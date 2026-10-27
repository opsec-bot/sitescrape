import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEndpoint, EndpointError, type Endpoint } from "../src/endpoint.ts";
import { buildHealPrompt, heal } from "../src/heal.ts";
import { mergeStatus, probe, type ProbeResult } from "../src/probe.ts";
import type { Entry } from "../src/registry.ts";

function endpoint(over: Partial<Endpoint> = {}): Endpoint {
  return {
    ...defineEndpoint({
      description: "x",
      input: z.object({ q: z.string() }),
      output: z.object({ ok: z.boolean() }),
      example: { q: "a" },
      async run() {
        return { ok: true };
      },
    }),
    ...over,
  } as Endpoint;
}

const entry = (id: string, ep: Endpoint, file = ""): Entry => {
  const [site, name] = id.split("/") as [string, string];
  return { id, site, name, file, endpoint: ep };
};

const NOW = new Date("2026-10-27T12:00:00Z");

describe("probe", () => {
  it("runs examples, keeps last_verified on failure and never runs actions", async () => {
    const calls: string[] = [];
    const entries = [
      entry("a.com/ok", endpoint()),
      entry("a.com/broken", endpoint()),
      entry("a.com/buy", endpoint({ kind: "action" })),
      entry("b.com/private", endpoint({ session: true })),
      entry("c.com/private", endpoint({ session: true })),
    ];
    const results = await probe(entries, {
      now: () => NOW,
      previous: { "a.com/broken": { last_verified: "2026-10-01T00:00:00Z" } as ProbeResult },
      hasLogin: async (site) => site === "c.com",
      run: async (e, input) => {
        calls.push(e.id);
        expect(input).toEqual({ q: "a" });
        if (e.id === "a.com/broken") throw new EndpointError("site response no longer matches schema", "bad_output");
        return {};
      },
    });

    expect(calls).toEqual(["a.com/ok", "a.com/broken", "c.com/private"]);
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["a.com/ok", "ok"],
      ["a.com/broken", "failed"],
      ["a.com/buy", "skipped"],
      ["b.com/private", "skipped"],
      ["c.com/private", "ok"],
    ]);
    expect(results[0]!.last_verified).toBe(NOW.toISOString());
    expect(results[1]).toMatchObject({ last_verified: "2026-10-01T00:00:00Z", error: { code: "bad_output" } });
    expect(results[3]!.reason).toMatch(/no saved login/);
  });

  it("reports crashes that are not endpoint errors", async () => {
    const [r] = await probe([entry("a.com/x", endpoint())], {
      run: async () => {
        throw new TypeError("cannot read properties of undefined");
      },
    });
    expect(r!.error).toEqual({ code: "crash", message: "cannot read properties of undefined" });
  });

  it("merges new results over old ones", () => {
    const merged = mergeStatus({ "a/x": { status: "ok" } as ProbeResult, "a/y": { status: "ok" } as ProbeResult }, [
      { id: "a/y", status: "failed" } as ProbeResult,
    ]);
    expect(Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v.status]))).toEqual({ "a/x": "ok", "a/y": "failed" });
  });
});

describe("heal", () => {
  async function siteDir() {
    const root = await mkdtemp(path.join(os.tmpdir(), "sitescrape-heal-"));
    const dir = path.join(root, "catalog", "a.com");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "list.ts"), "old list");
    await writeFile(path.join(dir, "_shared.ts"), "old shared");
    return { root, dir };
  }
  const failure = { id: "a.com/list", status: "failed", error: { code: "bad_output", message: "drift" } } as ProbeResult;
  const ok = { status: "ok" } as ProbeResult;

  it("keeps the agent's edits when the endpoint passes again", async () => {
    const { root, dir } = await siteDir();
    const e = entry("a.com/list", endpoint(), path.join(dir, "list.ts"));
    const result = await heal(
      { entry: e, failure, digestPath: path.join(root, "recordings", "digest.md"), repoRoot: root },
      {
        agent: async () => {
          await writeFile(path.join(dir, "_shared.ts"), "new shared");
          return "looked at digest\nFIXED selector changed";
        },
        verify: async () => ok,
      },
    );
    expect(result).toMatchObject({ fixed: true, agentSummary: "FIXED selector changed" });
    expect(result.changed).toEqual([path.join(dir, "_shared.ts")]);
    expect(await readFile(path.join(dir, "_shared.ts"), "utf8")).toBe("new shared");
  });

  it("restores every file, including new ones, when the fix does not work", async () => {
    const { root, dir } = await siteDir();
    const e = entry("a.com/list", endpoint(), path.join(dir, "list.ts"));
    const result = await heal(
      { entry: e, failure, digestPath: path.join(root, "d.md"), repoRoot: root },
      {
        agent: async () => {
          await writeFile(path.join(dir, "list.ts"), "broken edit");
          await writeFile(path.join(dir, "_extra.ts"), "new file");
          return "FIXED probably";
        },
        verify: async () => ({ status: "failed", error: { code: "bad_output", message: "still drift" } }) as ProbeResult,
      },
    );
    expect(result).toMatchObject({ fixed: false, changed: [], error: "bad_output: still drift" });
    expect(await readFile(path.join(dir, "list.ts"), "utf8")).toBe("old list");
    expect((await readdir(dir)).sort()).toEqual(["_shared.ts", "list.ts"]);
  });

  it("restores files when the agent itself fails", async () => {
    const { root, dir } = await siteDir();
    const e = entry("a.com/list", endpoint(), path.join(dir, "list.ts"));
    const result = await heal(
      { entry: e, failure, digestPath: path.join(root, "d.md"), repoRoot: root },
      {
        agent: async () => {
          await writeFile(path.join(dir, "list.ts"), "half written");
          throw new Error("could not start claude");
        },
        verify: async () => ok,
      },
    );
    expect(result).toMatchObject({ fixed: false, error: "could not start claude" });
    expect(await readFile(path.join(dir, "list.ts"), "utf8")).toBe("old list");
  });

  it("builds a prompt scoped to the endpoint's folder", () => {
    const root = path.join(os.tmpdir(), "repo");
    const prompt = buildHealPrompt({
      entry: entry("a.com/list", endpoint(), path.join(root, "catalog", "a.com", "list.ts")),
      failure,
      digestPath: path.join(root, "recordings", "a.com", "t", "digest.md"),
      repoRoot: root,
    });
    expect(prompt).toContain("Endpoint file: catalog/a.com/list.ts");
    expect(prompt).toContain("Only edit files in catalog/a.com/");
    expect(prompt).toContain("recordings/a.com/t/page.html");
    expect(prompt).toContain(`npx tsx src/cli.ts call a.com/list '{"q":"a"}'`);
    expect(prompt).toContain("Failure: bad_output: drift");
  });
});
