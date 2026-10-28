import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Context } from "./context.ts";
import { EndpointError, invoke, type ErrorCode } from "./endpoint.ts";
import { find, type Entry } from "./registry.ts";

export interface ServeOptions {
  /** When set, every request must send `Authorization: Bearer <token>`. */
  token?: string;
  /** How a call runs. Defaults to a plain context; the CLI passes the proxy/captcha/session runtime. */
  run?: (entry: Entry, input: unknown) => Promise<unknown>;
  maxBodyBytes?: number;
}

const STATUS: Record<ErrorCode, number> = {
  bad_input: 400,
  not_found: 404,
  auth_required: 401,
  bad_output: 502,
  upstream: 502,
  config: 500,
};

/** JSON Schema view of the catalog, used by GET / and handy for generating clients. */
export function describeCatalog(entries: Entry[]) {
  return entries.map((e) => ({
    id: e.id,
    kind: e.endpoint.kind,
    description: e.endpoint.description,
    input: z.toJSONSchema(e.endpoint.input, { io: "input" }),
    output: z.toJSONSchema(e.endpoint.output),
    example: e.endpoint.example,
  }));
}

async function defaultRun(entry: Entry, input: unknown): Promise<unknown> {
  const ctx = new Context();
  try {
    return await invoke(entry.endpoint, ctx, input);
  } finally {
    await ctx.close();
  }
}

export function createServer(entries: Entry[], opts: ServeOptions = {}): http.Server {
  const run = opts.run ?? defaultRun;
  const maxBody = opts.maxBodyBytes ?? 1_000_000;

  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (opts.token && !authorized(req.headers.authorization, opts.token)) {
        return send(401, { error: { code: "unauthorized", message: "missing or wrong bearer token" } });
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return send(200, { endpoints: describeCatalog(entries) });
      if (req.method !== "POST") return send(405, { error: { code: "method_not_allowed", message: "use POST /<site>/<endpoint>" } });

      const entry = find(entries, decodeURIComponent(url.pathname.slice(1)));
      if (!entry) return send(404, { error: { code: "unknown_endpoint", message: `no endpoint ${url.pathname}` } });

      const raw = await readBody(req, maxBody);
      let input: unknown = {};
      if (raw.trim()) {
        try {
          input = JSON.parse(raw);
        } catch {
          return send(400, { error: { code: "bad_json", message: "body is not valid JSON" } });
        }
      }
      const data = await run(entry, input);
      return send(200, { data });
    } catch (err) {
      if (err instanceof EndpointError) {
        return send(STATUS[err.code], { error: { code: err.code, message: err.message, details: err.details } });
      }
      if (err instanceof BodyTooLarge) return send(413, { error: { code: "too_large", message: err.message } });
      console.error(err);
      return send(500, { error: { code: "internal", message: "endpoint crashed, see server log" } });
    }
  });
}

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // Keep draining instead of destroying the socket, so the client still gets the 413.
      if (size > max) return reject(new BodyTooLarge(`body over ${max} bytes`));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
