import { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { Context } from "./context.ts";
import { EndpointError, invoke } from "./endpoint.ts";
import type { Entry } from "./registry.ts";

/** MCP tool names allow only [A-Za-z0-9_-], so "books.toscrape.com/search" becomes "books_toscrape_com__search". */
export function toolName(id: string): string {
  const [site, name] = id.split("/");
  return `${site!.replace(/[^A-Za-z0-9-]/g, "_")}__${name!.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

export function buildMcpServer(entries: Entry[], makeContext: () => Context = () => new Context()): McpServer {
  const server = new McpServer({ name: "sitescrape", version: "0.1.0" });
  for (const entry of entries) {
    const { endpoint } = entry;
    server.registerTool(
      toolName(entry.id),
      {
        description: `${endpoint.description} (${entry.id})`,
        inputSchema: endpoint.input as z.ZodObject,
        annotations: {
          readOnlyHint: endpoint.kind === "read",
          destructiveHint: endpoint.kind === "action",
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          const data = await invoke(endpoint, makeContext(), args);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const message =
            err instanceof EndpointError ? `${err.code}: ${err.message}` : `endpoint crashed: ${(err as Error).message}`;
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }
  return server;
}
