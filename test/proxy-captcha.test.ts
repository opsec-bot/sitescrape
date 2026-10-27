import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSolver } from "../src/captcha.ts";
import { proxiedFetch, redactProxy, resolveProxyUrl } from "../src/proxy.ts";

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("proxy", () => {
  it("fills {session} with a given or random id", () => {
    expect(resolveProxyUrl("http://u-session-{session}:p@gate:7000", "abc")).toBe("http://u-session-abc:p@gate:7000");
    const a = resolveProxyUrl("http://u-{session}:p@gate:7000");
    const b = resolveProxyUrl("http://u-{session}:p@gate:7000");
    expect(a).not.toBe(b);
    expect(resolveProxyUrl("http://u:p@gate:7000", "abc")).toBe("http://u:p@gate:7000");
  });

  it("hides the password in logs", () => {
    expect(redactProxy("http://user:hunter2@gate:7000")).toBe("http://user:***@gate:7000/");
  });

  it("sends requests through the proxy with basic auth", async () => {
    const target = await listen((_req, res) => res.end("from target"));
    const seen: { url?: string; auth?: string }[] = [];
    // Plain-HTTP targets are sent to the proxy in absolute form, so this tiny proxy just forwards them.
    const proxy = await listen(async (req, res) => {
      seen.push({ url: req.url, auth: req.headers["proxy-authorization"] });
      const upstream = await fetch(req.url!);
      res.end(await upstream.text());
    });

    const p = proxiedFetch(`http://alice-session-s1:pa%24s@${proxy}`);
    try {
      const res = await p.fetch(`http://${target}/hello`);
      expect(await res.text()).toBe("from target");
    } finally {
      await p.close();
    }
    expect(seen[0]!.url).toBe(`http://${target}/hello`);
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from("alice-session-s1:pa$s").toString("base64")}`);
  });
});

describe("captcha solver", () => {
  function provider(replies: object[]) {
    const calls: { url: string; body: any }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return Response.json(replies.shift());
    };
    return { fetch, calls };
  }

  it("creates a task, polls until ready and returns the token", async () => {
    const p = provider([{ errorId: 0, taskId: 7 }, { errorId: 0, status: "processing" }, { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "tok123" } }]);
    const solver = createSolver({ provider: "capmonster", apiKey: "k", fetch: p.fetch, pollMs: 1 });
    expect(await solver.solve({ type: "recaptcha_v2", websiteURL: "https://x.test/", websiteKey: "site-key" })).toBe("tok123");

    expect(p.calls.map((c) => c.url)).toEqual([
      "https://api.capmonster.cloud/createTask",
      "https://api.capmonster.cloud/getTaskResult",
      "https://api.capmonster.cloud/getTaskResult",
    ]);
    expect(p.calls[0]!.body).toEqual({
      clientKey: "k",
      task: { type: "RecaptchaV2TaskProxyless", websiteURL: "https://x.test/", websiteKey: "site-key", isInvisible: false },
    });
    expect(p.calls[1]!.body).toEqual({ clientKey: "k", taskId: 7 });
  });

  it("maps every task type and reads token or text answers", async () => {
    const turnstile = provider([{ errorId: 0, taskId: 1 }, { errorId: 0, status: "ready", solution: { token: "cf" } }]);
    const solver = createSolver({ provider: "2captcha", apiKey: "k", fetch: turnstile.fetch, pollMs: 1 });
    expect(await solver.solve({ type: "turnstile", websiteURL: "https://x.test/", websiteKey: "0x4" })).toBe("cf");
    expect(turnstile.calls[0]!.url).toBe("https://api.2captcha.com/createTask");
    expect(turnstile.calls[0]!.body.task.type).toBe("TurnstileTaskProxyless");

    const image = provider([{ errorId: 0, taskId: 2 }, { errorId: 0, status: "ready", solution: { text: "x7k2" } }]);
    const solver2 = createSolver({ provider: "anticaptcha", apiKey: "k", fetch: image.fetch, pollMs: 1 });
    expect(await solver2.solve({ type: "image", body: "iVBOR" })).toBe("x7k2");
    expect(image.calls[0]!.body.task).toEqual({ type: "ImageToTextTask", body: "iVBOR" });
  });

  it("surfaces provider errors and timeouts", async () => {
    const bad = provider([{ errorId: 1, errorCode: "ERROR_KEY_DOES_NOT_EXIST", errorDescription: "bad key" }]);
    const solver = createSolver({ provider: "anticaptcha", apiKey: "k", fetch: bad.fetch, pollMs: 1 });
    await expect(solver.solve({ type: "hcaptcha", websiteURL: "https://x.test/", websiteKey: "h" })).rejects.toThrow(/ERROR_KEY_DOES_NOT_EXIST/);

    const slow = provider([{ errorId: 0, taskId: 3 }, ...Array.from({ length: 50 }, () => ({ errorId: 0, status: "processing" }))]);
    const solver2 = createSolver({ provider: "anticaptcha", apiKey: "k", fetch: slow.fetch, pollMs: 1, timeoutMs: 20 });
    await expect(solver2.solve({ type: "hcaptcha", websiteURL: "https://x.test/", websiteKey: "h" })).rejects.toThrow(/did not solve/);
  });
});
