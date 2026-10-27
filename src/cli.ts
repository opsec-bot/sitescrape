import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Context } from "./context.ts";
import { EndpointError, invoke } from "./endpoint.ts";
import { find, loadCatalog } from "./registry.ts";
import { record, writeDigest } from "./record.ts";
import { createServer } from "./serve.ts";
import { buildMcpServer } from "./mcp.ts";

const HELP = `sitescrape: turn a website into a typed API

Usage:
  sitescrape record <url> [--task "..."] [--seconds N] [--headless] [--channel chrome|msedge]
  sitescrape digest <recording dir | file.har> [--host example.com]
  sitescrape list
  sitescrape call <site/endpoint> ['{"json":"input"}']
  sitescrape serve [--port 8787] [--host 127.0.0.1]   REST: GET / lists, POST /<site>/<endpoint> calls
  sitescrape mcp                                      MCP server on stdio, one tool per endpoint

Env (.env is loaded if present): PROXY_URL, SITESCRAPE_CATALOG, SITESCRAPE_TOKEN (bearer token for serve)
`;

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function catalogDir(): string {
  if (process.env.SITESCRAPE_CATALOG) return path.resolve(process.env.SITESCRAPE_CATALOG);
  const local = path.resolve("catalog");
  return existsSync(local) ? local : path.join(PKG_ROOT, "catalog");
}

async function main(argv: string[]): Promise<number> {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    // no .env, fine
  }
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      seconds: { type: "string" },
      headless: { type: "boolean" },
      channel: { type: "string" },
      host: { type: "string", multiple: true },
      port: { type: "string" },
    },
  });

  switch (cmd) {
    case "record": {
      const url = positionals[0];
      if (!url) return usage();
      const rec = await record({
        url,
        task: values.task,
        headless: values.headless,
        seconds: values.seconds ? Number(values.seconds) : undefined,
        channel: values.channel,
        proxyUrl: process.env.PROXY_URL || undefined,
      });
      console.log(`saved ${rec.dir}\ndigest ${rec.digestPath}`);
      return 0;
    }
    case "digest": {
      const target = positionals[0];
      if (!target) return usage();
      const harPath = statSync(target).isDirectory() ? path.join(target, "network.har") : target;
      const hosts = values.host ?? [];
      console.log(await writeDigest(harPath, hosts));
      return 0;
    }
    case "list": {
      const entries = await loadCatalog(catalogDir());
      for (const e of entries) console.log(`${e.id.padEnd(40)} ${e.endpoint.kind.padEnd(6)} ${e.endpoint.description}`);
      if (!entries.length) console.log(`no endpoints in ${catalogDir()}`);
      return 0;
    }
    case "call": {
      const [id, raw] = positionals;
      if (!id) return usage();
      const entry = find(await loadCatalog(catalogDir()), id);
      if (!entry) {
        console.error(`unknown endpoint ${id}. Run: sitescrape list`);
        return 1;
      }
      const result = await invoke(entry.endpoint, new Context(), raw ? JSON.parse(raw) : {});
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case "serve": {
      const entries = await loadCatalog(catalogDir());
      const port = Number(values.port ?? 8787);
      const host = values.host?.[0] ?? "127.0.0.1";
      const token = process.env.SITESCRAPE_TOKEN || undefined;
      if (host !== "127.0.0.1" && host !== "localhost" && !token) {
        console.error("refusing to listen on a public interface without SITESCRAPE_TOKEN");
        return 1;
      }
      createServer(entries, { token }).listen(port, host, () => {
        console.log(`sitescrape serving ${entries.length} endpoints on http://${host}:${port}`);
      });
      return new Promise<number>(() => {});
    }
    case "mcp": {
      const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
      const entries = await loadCatalog(catalogDir());
      serveStdio(() => buildMcpServer(entries));
      return new Promise<number>(() => {});
    }
    default:
      return usage(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
  }
}

function usage(code = 1): number {
  (code ? console.error : console.log)(HELP);
  return code;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof EndpointError) {
      console.error(`${err.code}: ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details, null, 2));
    } else {
      console.error(err);
    }
    process.exit(1);
  },
);

