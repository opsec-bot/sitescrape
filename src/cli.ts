import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { EndpointError } from "./endpoint.ts";
import { find, loadCatalog, type Entry } from "./registry.ts";
import { login, record, writeDigest } from "./record.ts";
import { configFromEnv, runEntry, sessionStore, type RuntimeConfig } from "./runtime.ts";
import { createServer } from "./serve.ts";
import { buildMcpServer } from "./mcp.ts";

const HELP = `sitescrape: turn a website into a typed API

Usage:
  sitescrape record <url> [--task "..."] [--seconds N] [--headless] [--channel chrome|msedge]
  sitescrape digest <recording dir | file.har> [--host example.com]
  sitescrape list
  sitescrape call <site/endpoint> ['{"json":"input"}']
  sitescrape login <url> [--site name]                log in by hand in a browser; cookies saved encrypted
  sitescrape logout <site>
  sitescrape serve [--port 8787] [--host 127.0.0.1]   REST: GET / lists, POST /<site>/<endpoint> calls
  sitescrape mcp                                      MCP server on stdio, one tool per endpoint

Env (.env is loaded if present):
  PROXY_URL          http://user:pass@host:port; put {session} where your provider takes a session id
  CAPTCHA_PROVIDER   anticaptcha | capmonster | 2captcha, with CAPTCHA_API_KEY
  SESSION_KEY        16+ random chars, encrypts saved logins
  SITESCRAPE_TOKEN   bearer token required by serve
  SITESCRAPE_CATALOG, SITESCRAPE_SESSIONS   override the catalog and sessions folders
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
      site: { type: "string" },
    },
  });

  let cfg: RuntimeConfig | undefined;
  const config = () => (cfg ??= configFromEnv());
  const run = (entry: Entry, input: unknown) => runEntry(entry, input, config());

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
        proxyUrl: config().proxyUrl,
      });
      console.log(`saved ${rec.dir}\ndigest ${rec.digestPath}`);
      return 0;
    }
    case "digest": {
      const target = positionals[0];
      if (!target) return usage();
      const harPath = statSync(target).isDirectory() ? path.join(target, "network.har") : target;
      console.log(await writeDigest(harPath, values.host ?? []));
      return 0;
    }
    case "list": {
      const entries = await loadCatalog(catalogDir());
      for (const e of entries) {
        const tags = [e.endpoint.kind, e.endpoint.session ? "login" : ""].filter(Boolean).join(",");
        console.log(`${e.id.padEnd(40)} ${tags.padEnd(12)} ${e.endpoint.description}`);
      }
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
      console.log(JSON.stringify(await run(entry, raw ? JSON.parse(raw) : {}), null, 2));
      return 0;
    }
    case "login": {
      const url = positionals[0];
      if (!url) return usage();
      const site = await login({
        url,
        site: values.site,
        channel: values.channel,
        store: sessionStore(config()),
        proxyUrl: config().proxyUrl,
      });
      console.log(`saved login for ${site}. Endpoints in catalog/${site}/ with session: true will use it.`);
      return 0;
    }
    case "logout": {
      const site = positionals[0];
      if (!site) return usage();
      await sessionStore(config()).remove(site);
      console.log(`removed login for ${site}`);
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
      config();
      createServer(entries, { token, run }).listen(port, host, () => {
        console.log(`sitescrape serving ${entries.length} endpoints on http://${host}:${port}`);
      });
      return new Promise<number>(() => {});
    }
    case "mcp": {
      const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
      const entries = await loadCatalog(catalogDir());
      config();
      serveStdio(() => buildMcpServer(entries, run));
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
