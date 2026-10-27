import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetCache } from "../catalog/resy.com/_shared.ts";
import search from "../catalog/resy.com/search.ts";
import { Context } from "../src/context.ts";
import { invoke } from "../src/endpoint.ts";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");
const FAKE_KEY = "testkey0123456789abcdefABCDEF01";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function resyContext(opts: { bundle?: string } = {}) {
  const calls: Call[] = [];
  const ctx = new Context({
    retries: 0,
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body as string });
      if (url === "https://resy.com/") return new Response('<script src="modules/app.abc123.js"></script>');
      if (url === "https://resy.com/modules/app.abc123.js") return new Response(opts.bundle ?? `x={s3:"https://s3.amazonaws.com/resy.com/",apiKey:"${FAKE_KEY}"}`);
      if (url.startsWith("https://api.resy.com/3/location/config")) return new Response(fixture("resy-cities.json"));
      if (url === "https://api.resy.com/3/venuesearch/search") return new Response(fixture("resy-search.json"));
      return new Response("", { status: 404 });
    },
  });
  return { ctx, calls };
}

beforeEach(() => resetCache());

describe("resy.com/search", () => {
  it("reads the key from the app bundle and maps venues", async () => {
    const { ctx, calls } = resyContext();
    const out = (await invoke(search, ctx, { query: "pizza", per_page: 2 })) as any;

    expect(out).toMatchObject({ query: "pizza", city: "new-york-ny", total: 81, page: 1 });
    expect(out.venues[0]).toMatchObject({
      id: 85342,
      name: "Crazy Pizza",
      url: "https://resy.com/cities/new-york-ny/venues/crazy-pizza",
      cuisine: ["Italian & Pizza"],
      neighborhood: "SoHo",
      price_range: 2,
      rating: 4.2,
      rating_count: 520,
    });

    const api = calls.find((c) => c.url.endsWith("/venuesearch/search"))!;
    expect(api.method).toBe("POST");
    expect(api.headers.authorization).toBe(`ResyAPI api_key="${FAKE_KEY}"`);
    expect(JSON.parse(api.body!)).toMatchObject({ query: "pizza", per_page: 2, geo: { latitude: 40.7128, longitude: -74.006 } });
  });

  it("caches the key and city list across calls", async () => {
    const { ctx, calls } = resyContext();
    await invoke(search, ctx, { query: "a" });
    await invoke(search, ctx, { query: "b" });
    expect(calls.filter((c) => c.url === "https://resy.com/")).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/location/config"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/venuesearch/search"))).toHaveLength(2);
  });

  it("fails clearly and retries discovery when the bundle changes", async () => {
    const broken = resyContext({ bundle: "no key here" });
    await expect(invoke(search, broken.ctx, { query: "a" })).rejects.toMatchObject({ code: "upstream" });
    // a failed lookup is not cached
    const fixed = resyContext();
    await expect(invoke(search, fixed.ctx, { query: "a" })).resolves.toBeTruthy();
  });

  it("rejects unknown cities and unsafe slugs", async () => {
    await expect(invoke(search, resyContext().ctx, { query: "a", city: "atlantis" })).rejects.toMatchObject({ code: "not_found" });
    await expect(invoke(search, resyContext().ctx, { query: "a", city: "../x" })).rejects.toMatchObject({ code: "bad_input" });
  });
});
