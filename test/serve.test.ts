import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEndpoint, EndpointError } from "../src/endpoint.ts";
import type { Entry } from "../src/registry.ts";
import { createServer } from "../src/serve.ts";

const echo = defineEndpoint({
  description: "Echo a name.",
  input: z.object({ name: z.string(), times: z.number().int().default(1) }),
  output: z.object({ text: z.string() }),
  example: { name: "a" },
  async run(_ctx, { name, times }) {
    if (name === "gone") throw new EndpointError("no such thing", "not_found");
    if (name === "drift") return { text: 42 } as never;
    if (name === "crash") throw new Error("boom");
    return { text: name.repeat(times) };
  },
});

const entries: Entry[] = [{ id: "example.com/echo", site: "example.com", name: "echo", file: "", endpoint: echo }];

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(token?: string): Promise<string> {
  const server = createServer(entries, { token, maxBodyBytes: 200 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", body, headers });

describe("REST server", () => {
  it("lists endpoints with JSON Schema", async () => {
    const res = await fetch(await start());
    const { endpoints } = await res.json();
    expect(endpoints[0]).toMatchObject({ id: "example.com/echo", kind: "read", example: { name: "a" } });
    expect(endpoints[0].input.required).toEqual(["name"]);
  });

  it("calls an endpoint and applies input defaults", async () => {
    const res = await post(await start(), "/example.com/echo", '{"name":"ab","times":2}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { text: "abab" } });
  });

  it("maps errors to status codes", async () => {
    const base = await start();
    const cases: [string, string, number, string][] = [
      ["/example.com/echo", "{}", 400, "bad_input"],
      ["/example.com/echo", "{nope", 400, "bad_json"],
      ["/example.com/echo", '{"name":"gone"}', 404, "not_found"],
      ["/example.com/echo", '{"name":"drift"}', 502, "bad_output"],
      ["/example.com/echo", '{"name":"crash"}', 500, "internal"],
      ["/example.com/missing", "{}", 404, "unknown_endpoint"],
      ["/example.com/echo", JSON.stringify({ name: "x".repeat(300) }), 413, "too_large"],
    ];
    for (const [path, body, status, code] of cases) {
      const res = await post(base, path, body);
      expect([path, body.slice(0, 20), res.status]).toEqual([path, body.slice(0, 20), status]);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it("does not leak crash messages to the caller", async () => {
    const res = await post(await start(), "/example.com/echo", '{"name":"crash"}');
    expect(JSON.stringify(await res.json())).not.toContain("boom");
  });

  it("requires the bearer token when one is set", async () => {
    const base = await start("s3cret-token");
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { headers: { authorization: "Bearer wrong-token!" } })).status).toBe(401);
    expect((await fetch(base, { headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
  });
});
