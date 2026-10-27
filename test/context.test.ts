import { describe, expect, it } from "vitest";
import { Context } from "../src/context.ts";
import { EndpointError } from "../src/endpoint.ts";

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

describe("Context", () => {
  it("retries retryable statuses and network errors", async () => {
    const f = fakeFetch([new Response("", { status: 503 }), new Error("ECONNRESET"), Response.json({ ok: 1 })]);
    const ctx = new Context({ fetch: f.fetch, backoffMs: 1 });
    expect(await ctx.json("https://x.test/a")).toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(3);
  });

  it("does not retry client errors", async () => {
    const f = fakeFetch([new Response("", { status: 403 })]);
    const ctx = new Context({ fetch: f.fetch, backoffMs: 1 });
    await expect(ctx.text("https://x.test/a")).rejects.toMatchObject({ code: "upstream" });
    expect(f.calls).toHaveLength(1);
  });

  it("maps 404 to not_found", async () => {
    const f = fakeFetch([new Response("", { status: 404 })]);
    const err: any = await new Context({ fetch: f.fetch }).html("https://x.test/a").catch((e) => e);
    expect(err).toBeInstanceOf(EndpointError);
    expect(err.code).toBe("not_found");
  });

  it("merges default, context and request headers", async () => {
    const f = fakeFetch([new Response("hi")]);
    const ctx = new Context({ fetch: f.fetch, headers: { "x-app": "1" } });
    await ctx.text("https://x.test/a", { headers: { "x-req": "2" } });
    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-app"]).toBe("1");
    expect(headers["x-req"]).toBe("2");
    expect(headers["user-agent"]).toMatch(/Chrome/);
  });
});
