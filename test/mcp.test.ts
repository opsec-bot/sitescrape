import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toolName } from "../src/mcp.ts";

describe("toolName", () => {
  it("maps ids to names MCP accepts", () => {
    expect(toolName("books.toscrape.com/search")).toBe("books_toscrape_com__search");
    expect(toolName("a.b/c.d")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(toolName(`${"x".repeat(80)}.com/y`).length).toBe(64);
  });
});

describe("sitescrape mcp", () => {
  it("lists catalog endpoints as tools over stdio and validates input", async () => {
    const root = path.join(import.meta.dirname, "..");
    const child = spawn(process.execPath, [path.join(root, "bin", "sitescrape.mjs"), "mcp"], { cwd: root });
    const replies = new Map<number, (msg: any) => void>();
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          const msg = JSON.parse(line);
          replies.get(msg.id)?.(msg);
        }
      }
    });
    let next = 0;
    const rpc = (method: string, params: object) =>
      new Promise<any>((resolve) => {
        const id = ++next;
        replies.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    try {
      const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      expect(init.result.serverInfo.name).toBe("sitescrape");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const { result } = await rpc("tools/list", {});
      const names = result.tools.map((t: any) => t.name);
      expect(names).toEqual(expect.arrayContaining(["books_toscrape_com__book", "books_toscrape_com__search", "resy_com__search"]));
      expect(result.tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true);

      // invalid input is rejected before the endpoint runs, so no network call happens
      const bad = await rpc("tools/call", { name: "books_toscrape_com__book", arguments: { id: "../x" } });
      expect(bad.result.isError).toBe(true);
    } finally {
      child.kill();
    }
  }, 30_000);
});
