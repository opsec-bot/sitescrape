import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Context } from "../src/context.ts";
import { defineEndpoint } from "../src/endpoint.ts";
import type { Entry } from "../src/registry.ts";
import { configFromEnv, runEntry, sessionStore, type RuntimeConfig } from "../src/runtime.ts";
import { jarFromBrowserCookies, SessionStore } from "../src/session.ts";

const KEY = "0123456789abcdef-test-key";
const tmp = () => mkdtemp(path.join(os.tmpdir(), "sitescrape-"));

describe("SessionStore", () => {
  it("round-trips encrypted data and keeps cookie values out of the file", async () => {
    const dir = await tmp();
    const store = new SessionStore(dir, KEY);
    const jar = await jarFromBrowserCookies([
      { name: "sid", value: "SUPERSECRET", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true },
    ]);
    await store.save({ site: "example.com", jar: await jar.serialize(), proxySession: "p1", savedAt: "now" });

    expect(await readFile(path.join(dir, "example.com.session"), "utf8")).not.toContain("SUPERSECRET");
    const loaded = await store.load("example.com");
    expect(loaded?.proxySession).toBe("p1");
    expect(JSON.stringify(loaded?.jar)).toContain("SUPERSECRET");
  });

  it("rejects a wrong key, short keys and path tricks", async () => {
    const dir = await tmp();
    await new SessionStore(dir, KEY).save({ site: "example.com", jar: {}, savedAt: "now" });
    await expect(new SessionStore(dir, "a-different-key-123").load("example.com")).rejects.toMatchObject({ code: "config" });
    expect(() => new SessionStore(dir, "short")).toThrow(/SESSION_KEY/);
    await expect(new SessionStore(dir, KEY).load("../etc")).rejects.toMatchObject({ code: "bad_input" });
    expect(await new SessionStore(dir, KEY).load("missing.com")).toBeUndefined();
  });

  it("imports browser cookies so they match subdomains and paths", async () => {
    const jar = await jarFromBrowserCookies([
      { name: "a", value: "1", domain: ".example.com", path: "/", expires: -1, httpOnly: false, secure: true },
      { name: "b", value: "2", domain: "app.example.com", path: "/api", expires: Date.now() / 1000 + 3600, httpOnly: false, secure: true },
      { name: "old", value: "x", domain: ".example.com", path: "/", expires: 1, httpOnly: false, secure: true },
    ]);
    expect(await jar.getCookieString("https://app.example.com/api/v1")).toBe("b=2; a=1");
    expect(await jar.getCookieString("https://www.example.com/")).toBe("a=1");
  });
});

describe("Context cookie jar", () => {
  it("sends jar cookies and stores Set-Cookie", async () => {
    const jar = await jarFromBrowserCookies([
      { name: "sid", value: "s1", domain: "x.test", path: "/", expires: -1, httpOnly: true, secure: true },
    ]);
    const sent: string[] = [];
    const ctx = new Context({
      jar,
      fetch: async (_url, init) => {
        sent.push((init!.headers as Record<string, string>).cookie ?? "");
        return new Response("ok", { headers: { "set-cookie": "csrf=c9; Path=/; Secure" } });
      },
    });
    await ctx.text("https://x.test/a");
    await ctx.text("https://x.test/b");
    expect(sent).toEqual(["sid=s1", "sid=s1; csrf=c9"]);
  });
});

describe("runEntry", () => {
  const whoami = defineEndpoint({
    description: "Who is logged in.",
    session: true,
    input: z.object({}),
    output: z.object({ user: z.string() }),
    example: {},
    async run(ctx) {
      return { user: await ctx.text("https://app.example.com/me") };
    },
  });
  const entry: Entry = { id: "example.com/whoami", site: "example.com", name: "whoami", file: "", endpoint: whoami };

  it("asks for a login when no session is saved", async () => {
    const cfg: RuntimeConfig = { sessionDir: await tmp(), sessionKey: KEY, fetch: async () => new Response("") };
    await expect(runEntry(entry, {}, cfg)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("uses saved cookies and user agent, and saves refreshed cookies", async () => {
    const seen: Record<string, string>[] = [];
    const cfg: RuntimeConfig = {
      sessionDir: await tmp(),
      sessionKey: KEY,
      fetch: async (_url, init) => {
        seen.push(init!.headers as Record<string, string>);
        return new Response("gian", { headers: { "set-cookie": "sid=rotated; Domain=example.com; Path=/; Secure" } });
      },
    };
    const jar = await jarFromBrowserCookies([
      { name: "sid", value: "first", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true },
    ]);
    await sessionStore(cfg).save({ site: "example.com", jar: await jar.serialize(), userAgent: "UA/1", savedAt: "then" });

    expect(await runEntry(entry, {}, cfg)).toEqual({ user: "gian" });
    expect(seen[0]!.cookie).toBe("sid=first");
    expect(seen[0]!["user-agent"]).toBe("UA/1");

    await runEntry(entry, {}, cfg);
    expect(seen[1]!.cookie).toBe("sid=rotated");
  });
});

describe("configFromEnv", () => {
  it("validates captcha settings", () => {
    expect(() => configFromEnv({ CAPTCHA_PROVIDER: "nope", CAPTCHA_API_KEY: "k" })).toThrow(/must be one of/);
    expect(() => configFromEnv({ CAPTCHA_PROVIDER: "capmonster" })).toThrow(/CAPTCHA_API_KEY/);
    expect(configFromEnv({ CAPTCHA_PROVIDER: "capmonster", CAPTCHA_API_KEY: "k" }).captcha).toBeDefined();
    expect(configFromEnv({ PROXY_URL: " " }).proxyUrl).toBeUndefined();
  });
});
