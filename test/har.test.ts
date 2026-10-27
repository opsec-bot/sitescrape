import { describe, expect, it } from "vitest";
import { digestHar, mask, renderDigest, shapeOf, type Har, type HarEntry } from "../src/har.ts";

interface EntryOpts {
  url: string;
  method: string;
  mime: string;
  text: string;
  type: string;
  status: number;
  headers: { name: string; value: string }[];
  post: string;
}

function entry(over: Partial<EntryOpts>): HarEntry {
  return {
    request: {
      method: over.method ?? "GET",
      url: over.url ?? "https://shop.example.com/api/items?page=2",
      headers: over.headers ?? [],
      postData: over.post ? { mimeType: "application/json", text: over.post } : undefined,
    },
    response: {
      status: over.status ?? 200,
      headers: [],
      content: { mimeType: over.mime ?? "application/json", text: over.text ?? '{"items":[{"id":1,"name":"a"}],"total":40}' },
    },
    _resourceType: over.type ?? "fetch",
  };
}

const har = (...entries: HarEntry[]): Har => ({ log: { entries } });

describe("digestHar", () => {
  it("keeps API calls and drops static files, trackers and preflights", () => {
    const out = digestHar(
      har(
        entry({}),
        entry({ url: "https://shop.example.com/logo.png", mime: "image/png", type: "image" }),
        entry({ url: "https://shop.example.com/app.js", mime: "application/javascript", type: "script" }),
        entry({ url: "https://www.google-analytics.com/g/collect?v=2" }),
        entry({ method: "OPTIONS" }),
      ),
    );
    expect(out.map((e) => e.route)).toEqual(["https://shop.example.com/api/items"]);
    expect(out[0]!.query).toEqual({ page: "2" });
    expect(out[0]!.responseShape).toBe('{ items: [{ id: 1, name: "a" }] x1, total: 40 }');
  });

  it("groups repeated calls and sorts JSON before HTML", () => {
    const out = digestHar(
      har(
        entry({ url: "https://shop.example.com/", mime: "text/html", text: "<title> Shop </title>", type: "document" }),
        entry({ url: "https://shop.example.com/api/items?page=1" }),
        entry({ url: "https://shop.example.com/api/items?page=2" }),
      ),
    );
    expect(out.map((e) => [e.kind, e.count])).toEqual([
      ["json", 2],
      ["html", 1],
    ]);
    expect(out[1]!.title).toBe("Shop");
  });

  it("filters by host but keeps subdomains", () => {
    const out = digestHar(har(entry({ url: "https://api.example.com/v1/x" }), entry({ url: "https://other.net/v1/y" })), {
      hosts: ["example.com"],
    });
    expect(out.map((e) => e.route)).toEqual(["https://api.example.com/v1/x"]);
  });

  it("never puts cookie or token values in the digest", () => {
    const out = digestHar(
      har(
        entry({
          headers: [
            { name: "cookie", value: "sid=SECRETSESSION123; theme=dark" },
            { name: "authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" },
            { name: "x-api-key", value: "pk_live_abcdefghijkl" },
          ],
        }),
      ),
    );
    const text = renderDigest(out);
    expect(text).toContain("cookies sent: sid, theme");
    expect(text).not.toContain("SECRETSESSION123");
    expect(text).not.toContain("payload.sig");
    expect(text).not.toContain("abcdefghijkl");
    expect(out[0]!.headers.authorization).toBe("Bearer eyJh...(32 chars)");
  });

  it("decodes base64 bodies", () => {
    const e = entry({});
    e.response.content = { mimeType: "application/json", text: Buffer.from('{"ok":true}').toString("base64"), encoding: "base64" };
    expect(digestHar(har(e))[0]!.responseShape).toBe("{ ok: true }");
  });
});

describe("shapeOf", () => {
  it("summarises arrays by first item and limits depth", () => {
    expect(shapeOf([{ a: { b: { c: { d: { e: 1 } } } } }, {}])).toBe("[{ a: { b: { c: {...} } } }] x2");
    expect(shapeOf("x".repeat(50))).toBe("string");
    expect(shapeOf([])).toBe("[]");
  });
});

describe("mask", () => {
  it("hides short secrets completely", () => {
    expect(mask("abc")).toBe("***");
    expect(mask("Basic abc")).toBe("Basic ***");
  });
});
