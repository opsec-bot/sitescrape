import { z } from "zod";
import type { Entry } from "./registry.ts";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  [k: string]: unknown;
};

export const inputSchema = (e: Entry) => z.toJSONSchema(e.endpoint.input, { io: "input" }) as JsonSchema;
export const outputSchema = (e: Entry) => z.toJSONSchema(e.endpoint.output) as JsonSchema;

/** JSON Schema view of the catalog, used by GET / and handy for generating clients. */
export function describeCatalog(entries: Entry[]) {
  return entries.map((e) => ({
    id: e.id,
    kind: e.endpoint.kind,
    description: e.endpoint.description,
    notes: e.endpoint.notes,
    input: inputSchema(e),
    output: outputSchema(e),
    example: e.endpoint.example,
  }));
}

/** OpenAPI 3.1 spec. Every endpoint takes POST with a JSON body; read endpoints also take GET with query params. */
export function openapi(entries: Entry[], serverUrl = "http://127.0.0.1:8787", version = "0.0.0") {
  const paths: Record<string, unknown> = {};
  for (const e of entries) {
    const { $schema: _in, ...input } = inputSchema(e);
    const { $schema: _out, ...output } = outputSchema(e);
    const op = (method: string) => ({
      operationId: `${e.id.replace(/[^A-Za-z0-9]+/g, "_")}_${method}`,
      summary: e.endpoint.description,
      ...(e.endpoint.notes ? { description: e.endpoint.notes } : {}),
      tags: [e.site],
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: { type: "object", properties: { data: output }, required: ["data"] } } },
        },
        default: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    });
    const item: Record<string, unknown> = {
      post: {
        ...op("post"),
        requestBody: { required: false, content: { "application/json": { schema: input, example: e.endpoint.example } } },
      },
    };
    if (e.endpoint.kind === "read") {
      item.get = {
        ...op("get"),
        parameters: Object.entries(input.properties ?? {}).map(([name, schema]) => ({
          name,
          in: "query",
          required: input.required?.includes(name) ?? false,
          schema,
          ...(schema.description ? { description: schema.description } : {}),
        })),
      };
    }
    paths[`/${e.id}`] = item;
  }
  return {
    openapi: "3.1.0",
    info: { title: "sitescrape", version },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
              required: ["code", "message"],
            },
          },
        },
      },
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Only when SITESCRAPE_TOKEN is set" } },
    },
  };
}

/** Copy-paste calls. The token comes from the environment, never pasted into the snippet. */
export function snippets(id: string, input: unknown, baseUrl = "http://127.0.0.1:8787") {
  const url = `${baseUrl}/${id}`;
  const body = JSON.stringify(input ?? {});
  // Single-quote the JSON for the shell, but keep $SITESCRAPE_TOKEN in double quotes so it expands.
  const shellBody = `'${body.replaceAll("'", `'\\''`)}'`;
  return {
    curl: [
      `curl -X POST "${url}" \\`,
      `  -H "content-type: application/json" \\`,
      `  -H "authorization: Bearer $SITESCRAPE_TOKEN" \\`,
      `  -d ${shellBody}`,
    ].join("\n"),
    python: [
      "import os, requests",
      "",
      "res = requests.post(",
      `    ${JSON.stringify(url)},`,
      `    json=${pythonLiteral(input ?? {})},`,
      `    headers={"authorization": f"Bearer {os.environ.get('SITESCRAPE_TOKEN', '')}"},`,
      ")",
      "res.raise_for_status()",
      'print(res.json()["data"])',
    ].join("\n"),
    typescript: [
      `const res = await fetch(${JSON.stringify(url)}, {`,
      `  method: "POST",`,
      "  headers: { \"content-type\": \"application/json\", authorization: `Bearer ${process.env.SITESCRAPE_TOKEN ?? \"\"}` },",
      `  body: JSON.stringify(${body}),`,
      "});",
      "if (!res.ok) throw new Error((await res.json()).error.message);",
      "const { data } = await res.json();",
    ].join("\n"),
    cli: `sitescrape call ${id} ${shellBody}`,
  };
}

function pythonLiteral(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (Array.isArray(v)) return `[${v.map(pythonLiteral).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pythonLiteral(x)}`).join(", ")}}`;
  }
  return JSON.stringify(v);
}

/** Plain-text docs for one endpoint, for `sitescrape describe`. */
export function describeText(e: Entry, baseUrl?: string): string {
  const input = inputSchema(e);
  const required = new Set(input.required ?? []);
  const rows = Object.entries(input.properties ?? {}).map(([name, s]) => {
    const type = typeLabel(s);
    const extra = [required.has(name) ? "required" : "", s.default !== undefined ? `default ${JSON.stringify(s.default)}` : ""]
      .filter(Boolean)
      .join(", ");
    return `  ${name.padEnd(20)} ${type.padEnd(10)} ${extra.padEnd(24)} ${s.description ?? ""}`.trimEnd();
  });
  const fields = Object.entries(outputSchema(e).properties ?? {}).map(([name, s]) => `  ${name.padEnd(20)} ${typeLabel(s)}`);
  const snip = snippets(e.id, e.endpoint.example, baseUrl);
  return [
    `${e.id}  (${e.endpoint.kind}${e.endpoint.session ? ", login" : ""})`,
    "",
    e.endpoint.description,
    ...(e.endpoint.notes ? ["", e.endpoint.notes] : []),
    "",
    "Input:",
    ...(rows.length ? rows : ["  (none)"]),
    "",
    "Output:",
    ...(fields.length ? fields : ["  (see JSON Schema: GET / on serve)"]),
    "",
    "Example:",
    `  ${snip.cli}`,
    "",
    "Over HTTP (sitescrape serve):",
    snip.curl.replace(/^/gm, "  "),
  ].join("\n");
}

function typeLabel(s: JsonSchema): string {
  if (s.enum) return s.enum.map(String).join("|");
  if (Array.isArray(s.type)) return s.type.join("|");
  if (s.type === "array") return `${typeLabel((s.items as JsonSchema) ?? {})}[]`;
  return s.type ?? "any";
}

/**
 * Turn query-string values into the types the input schema wants, so GET /site/name?page=2 works.
 * Arrays repeat the key (?tag=a&tag=b); objects are passed as JSON.
 */
export function coerceQuery(params: URLSearchParams, schema: JsonSchema): Record<string, unknown> {
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    const s = props[key];
    const type = Array.isArray(s?.type) ? s!.type.find((t) => t !== "null") : s?.type;
    if (type === "array") out[key] = values.map((v) => scalar(v, (s!.items as JsonSchema | undefined)?.type));
    else out[key] = scalar(values.at(-1)!, type);
  }
  return out;
}

function scalar(v: string, type: unknown): unknown {
  if ((type === "integer" || type === "number") && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  if (type === "boolean" && (v === "true" || v === "false")) return v === "true";
  if (type === "object") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
