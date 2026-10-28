import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { EndpointError } from "./endpoint.ts";
import { find, loadCatalog, type Entry } from "./registry.ts";
import { login, record, writeDigest } from "./record.ts";
import { configFromEnv, runEntry, sessionStore, type RuntimeConfig } from "./runtime.ts";
import { createServer } from "./serve.ts";
import { claudeRunner, heal } from "./heal.ts";
import { mergeStatus, probe, readStatus, writeStatus, type ProbeResult } from "./probe.ts";
import { buildMcpServer } from "./mcp.ts";
import { describeText, openapi } from "./docs.ts";

const HELP = `sitescrape: turn a website into a typed API

Usage:
  sitescrape record <url> [--task "..."] [--seconds N] [--headless] [--channel chrome|msedge]
  sitescrape digest <recording dir | file.har> [--host example.com]
  sitescrape list
  sitescrape call <site/endpoint> ['{"json":"input"}']
  sitescrape describe <site/endpoint>                 docs, inputs, outputs and copy-paste calls
  sitescrape openapi [--port 8787] [--host 127.0.0.1] OpenAPI 3.1 spec of the catalog on stdout
  sitescrape login <url> [--site name]                log in by hand in a browser; cookies saved encrypted
  sitescrape logout <site>
  sitescrape probe [site or site/endpoint ...] [--json] [--heal]
                                                      run each endpoint's example; --heal repairs failures
  sitescrape heal <site/endpoint>                     re-record the site and let Claude Code patch the endpoint
  sitescrape serve [--port 8787] [--host 127.0.0.1]   REST + playground at /playground, spec at /openapi.json
  sitescrape mcp                                      MCP server on stdio, one tool per endpoint

Env (.env is loaded if present):
  PROXY_URL          http://user:pass@host:port; put {session} where your provider takes a session id
  CAPTCHA_PROVIDER   anticaptcha | capmonster | 2captcha, with CAPTCHA_API_KEY
  SESSION_KEY        16+ random chars, encrypts saved logins
  SITESCRAPE_TOKEN   bearer token required by serve
  SITESCRAPE_CATALOG, SITESCRAPE_SESSIONS   override the catalog and sessions folders
`;

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = (JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")) as { version: string }).version;
const STATUS_FILE = path.resolve(".sitescrape", "status.json");

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
      json: { type: "boolean" },
      heal: { type: "boolean" },
    },
  });

  let cfg: RuntimeConfig | undefined;
  const config = () => (cfg ??= configFromEnv());
  const run = (entry: Entry, input: unknown) => runEntry(entry, input, config());
  const hasLogin = async (site: string) => {
    try {
      return Boolean(await sessionStore(config()).load(site));
    } catch {
      return false;
    }
  };
  const select = (entries: Entry[], filters: string[]) =>
    filters.length ? entries.filter((e) => filters.some((f) => e.id === f || e.site === f)) : entries;

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
      const status = await readStatus(STATUS_FILE);
      for (const e of entries) {
        const tags = [e.endpoint.kind, e.endpoint.session ? "login" : ""].filter(Boolean).join(",");
        const s = status[e.id];
        const health = !s ? "unchecked" : s.status === "failed" ? "BROKEN" : s.last_verified ? `ok ${s.last_verified.slice(0, 16)}` : s.status;
        console.log(`${e.id.padEnd(36)} ${tags.padEnd(12)} ${health.padEnd(22)} ${e.endpoint.description}`);
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
    case "describe": {
      const id = positionals[0];
      if (!id) return usage();
      const entry = find(await loadCatalog(catalogDir()), id);
      if (!entry) {
        console.error(`unknown endpoint ${id}. Run: sitescrape list`);
        return 1;
      }
      console.log(describeText(entry, `http://${values.host?.[0] ?? "127.0.0.1"}:${values.port ?? 8787}`));
      return 0;
    }
    case "openapi": {
      const base = `http://${values.host?.[0] ?? "127.0.0.1"}:${values.port ?? 8787}`;
      console.log(JSON.stringify(openapi(await loadCatalog(catalogDir()), base, VERSION), null, 2));
      return 0;
    }
    case "probe": {
      const entries = select(await loadCatalog(catalogDir()), positionals);
      const previous = await readStatus(STATUS_FILE);
      const results = await probe(entries, { run, hasLogin, previous });
      await writeStatus(STATUS_FILE, mergeStatus(previous, results));
      if (values.json) console.log(JSON.stringify(results, null, 2));
      else for (const r of results) console.log(formatResult(r));

      const failed = results.filter((r) => r.status === "failed");
      if (values.heal) {
        let unfixed = 0;
        for (const f of failed) {
          if (!(await healOne(entries.find((e) => e.id === f.id)!, f))) unfixed++;
        }
        return unfixed ? 1 : 0;
      }
      return failed.length ? 1 : 0;
    }
    case "heal": {
      const id = positionals[0];
      if (!id) return usage();
      const entry = find(await loadCatalog(catalogDir()), id);
      if (!entry) {
        console.error(`unknown endpoint ${id}. Run: sitescrape list`);
        return 1;
      }
      const [current] = await probe([entry], { run, hasLogin });
      if (current!.status !== "failed") {
        console.log(`${id} is ${current!.status}, nothing to heal`);
        return 0;
      }
      return (await healOne(entry, current!)) ? 0 : 1;
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
      createServer(entries, { token, run, version: VERSION }).listen(port, host, () => {
        console.log(`sitescrape serving ${entries.length} endpoints on http://${host}:${port}`);
        console.log(`playground: http://${host}:${port}/playground`);
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

function formatResult(r: ProbeResult): string {
  const detail = r.status === "failed" ? `${r.error?.code}: ${r.error?.message}` : r.status === "skipped" ? r.reason : `${r.ms} ms`;
  return `${r.status.toUpperCase().padEnd(7)} ${r.id.padEnd(36)} ${detail}`;
}

/** Probe one endpoint in a fresh process, so edited files are loaded instead of the cached module. */
function probeFresh(id: string): ProbeResult {
  const out = spawnSync(process.execPath, [path.join(PKG_ROOT, "bin", "sitescrape.mjs"), "probe", id, "--json"], { encoding: "utf8" });
  try {
    return (JSON.parse(out.stdout) as ProbeResult[])[0]!;
  } catch {
    const message = out.stderr.trim().split(/\r?\n/).at(-1) || "probe crashed";
    return { id, status: "failed", ms: 0, last_verified: null, checked_at: new Date().toISOString(), error: { code: "crash", message } };
  }
}

async function healOne(entry: Entry, failure: ProbeResult): Promise<boolean> {
  const source = entry.endpoint.source ?? `https://${entry.site}/`;
  console.log(`healing ${entry.id}: recording ${source}`);
  const rec = await record({ url: source, headless: true, seconds: 8, proxyUrl: configFromEnv().proxyUrl, task: entry.endpoint.description });
  const result = await heal(
    { entry, failure, digestPath: rec.digestPath, repoRoot: process.cwd() },
    { agent: claudeRunner, verify: async () => probeFresh(entry.id) },
  );
  if (result.fixed) {
    console.log(`FIXED   ${entry.id}. Changed: ${result.changed.map((f) => path.relative(process.cwd(), f)).join(", ")}. Review with git diff before committing.`);
  } else {
    console.log(`NOT FIXED ${entry.id}: ${result.error ?? "unknown"}. Files restored. Agent said: ${result.agentSummary}`);
  }
  return result.fixed;
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
