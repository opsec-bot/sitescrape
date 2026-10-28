import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { coerceQuery, describeText, inputSchema, openapi, snippets } from "../src/docs.ts";
import { defineEndpoint } from "../src/endpoint.ts";
import type { Entry } from "../src/registry.ts";

const search = defineEndpoint({
  description: "Search things.",
  notes: "Only the first 100 results.",
  input: z.object({
    q: z.string().describe("What to find."),
    page: z.number().int().default(1),
    exact: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    sort: z.enum(["asc", "desc"]).optional(),
  }),
  output: z.object({ hits: z.array(z.string()) }),
  example: { q: "it's" },
  async run() {
    return { hits: [] };
  },
});
const buy = defineEndpoint({ ...search, kind: "action" });
const entries: Entry[] = [
  { id: "a.com/search", site: "a.com", name: "search", file: "", endpoint: search },
  { id: "a.com/buy", site: "a.com", name: "buy", file: "", endpoint: buy },
];

describe("openapi", () => {
  it("documents POST for every endpoint and GET only for reads", () => {
    const spec = openapi(entries, "http://x:1", "9.9.9");
    expect(spec.info.version).toBe("9.9.9");
    const paths = spec.paths as Record<string, any>;
    expect(Object.keys(paths["/a.com/search"])).toEqual(["post", "get"]);
    expect(Object.keys(paths["/a.com/buy"])).toEqual(["post"]);
    expect(paths["/a.com/search"].post.description).toBe("Only the first 100 results.");
    const q = paths["/a.com/search"].get.parameters.find((p: any) => p.name === "q");
    expect(q).toMatchObject({ in: "query", required: true, description: "What to find." });
    expect(JSON.stringify(spec)).not.toContain("$schema");
  });
});

describe("coerceQuery", () => {
  it("turns query strings into the schema's types", () => {
    const params = new URLSearchParams("q=7&page=2&exact=true&tags=a&tags=b&sort=desc&page=3");
    expect(coerceQuery(params, inputSchema(entries[0]!))).toEqual({
      q: "7",
      page: 3,
      exact: true,
      tags: ["a", "b"],
      sort: "desc",
    });
  });

  it("leaves bad numbers as strings so validation reports them", () => {
    expect(coerceQuery(new URLSearchParams("page=abc"), inputSchema(entries[0]!))).toEqual({ page: "abc" });
  });
});

describe("snippets", () => {
  it("quotes the body for the shell and expands the token", () => {
    const s = snippets("a.com/search", { q: "it's \"x\" $HOME" }, "http://h:1");
    const out = spawnSync("bash", ["-c", `T=tok; printf '%s' ${s.cli.replace("sitescrape call a.com/search ", "")}`], {
      encoding: "utf8",
    });
    expect(JSON.parse(out.stdout)).toEqual({ q: "it's \"x\" $HOME" });
    expect(s.curl).toContain('"authorization: Bearer $SITESCRAPE_TOKEN"');
    expect(s.python).toContain('json={"q": "it\'s \\"x\\" $HOME"}');
    expect(s.typescript).toContain('"http://h:1/a.com/search"');
  });
});

describe("describeText", () => {
  it("shows notes, inputs and a working call", () => {
    const text = describeText(entries[0]!);
    expect(text).toContain("Only the first 100 results.");
    expect(text).toMatch(/q\s+string\s+required\s+What to find\./);
    expect(text).toMatch(/page\s+integer\s+default 1/);
    expect(text).toContain("asc|desc");
  });
});
