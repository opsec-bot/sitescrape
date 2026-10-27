// Turns a HAR recording into a short summary of the requests that carry data,
// so the agent that writes endpoints reads a few KB instead of a multi-MB HAR.

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: HarHeader[];
    postData?: { mimeType?: string; text?: string };
  };
  response: {
    status: number;
    headers: HarHeader[];
    content: { mimeType?: string; size?: number; text?: string; encoding?: string };
  };
  _resourceType?: string;
}

export interface Har {
  log: { entries: HarEntry[] };
}

export interface DigestEntry {
  method: string;
  url: string;
  /** origin + path, used to group repeated calls. */
  route: string;
  status: number;
  kind: "json" | "html" | "other";
  count: number;
  query: Record<string, string>;
  headers: Record<string, string>;
  cookies: string[];
  body?: string;
  responseShape?: string;
  responseSize: number;
  title?: string;
}

const STATIC_MIME = /^(image|font|audio|video)\/|css|javascript|ecmascript|wasm|octet-stream/i;
const STATIC_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|css|js|mjs|map|mp4|webm|mp3)(\?|$)/i;
const NOISE_HOSTS =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|facebook\.(com|net)|connect\.facebook|segment\.(io|com)|hotjar|sentry\.io|datadoghq|newrelic|nr-data|clarity\.ms|mixpanel|amplitude|intercom|hubspot|optimizely|tiktok|snapchat|bing\.com\/bat|cloudflareinsights|stripe\.network|recaptcha|hcaptcha)/i;

/** Request headers worth showing: anything that looks like auth or app-specific. */
const KEEP_HEADER = /^(authorization|content-type|x-[\w-]+|api[-_]?key|accept|origin|referer|csrf[-\w]*|[\w-]*token[\w-]*)$/i;
const SECRET_HEADER = /authorization|token|key|secret|csrf|session|cookie/i;

export interface DigestOptions {
  /** Only keep requests to hosts ending in one of these (e.g. the target site). Empty keeps all. */
  hosts?: string[];
  maxBody?: number;
}

export function digestHar(har: Har, opts: DigestOptions = {}): DigestEntry[] {
  const maxBody = opts.maxBody ?? 600;
  const groups = new Map<string, DigestEntry>();

  for (const e of har.log.entries) {
    if (isNoise(e, opts.hosts)) continue;
    const url = new URL(e.request.url);
    const route = `${url.origin}${url.pathname}`;
    const key = `${e.request.method} ${route}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      continue;
    }

    const mime = e.response.content.mimeType ?? "";
    const kind = /json/i.test(mime) ? "json" : /html/i.test(mime) ? "html" : "other";
    const text = decodeBody(e.response.content);
    const entry: DigestEntry = {
      method: e.request.method,
      url: e.request.url,
      route,
      status: e.response.status,
      kind,
      count: 1,
      query: Object.fromEntries(url.searchParams),
      headers: pickHeaders(e.request.headers),
      cookies: cookieNames(e.request.headers),
      responseSize: e.response.content.size ?? text?.length ?? 0,
    };
    if (e.request.postData?.text) entry.body = truncate(e.request.postData.text, maxBody);
    if (kind === "json" && text) {
      try {
        entry.responseShape = shapeOf(JSON.parse(text));
      } catch {
        entry.responseShape = "(invalid JSON)";
      }
    }
    if (kind === "html" && text) entry.title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    groups.set(key, entry);
  }

  // JSON first, then HTML documents, then the rest; keep recording order inside each group.
  const rank = { json: 0, html: 1, other: 2 };
  return [...groups.values()].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function isNoise(e: HarEntry, hosts?: string[]): boolean {
  const { method, url } = e.request;
  if (method === "OPTIONS" || e.response.status === 0) return true;
  if (!/^https?:/i.test(url)) return true;
  const host = new URL(url).hostname;
  if (hosts?.length && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  if (NOISE_HOSTS.test(url)) return true;
  if (["image", "font", "stylesheet", "script", "media", "manifest", "ping"].includes(e._resourceType ?? "")) return true;
  if (STATIC_MIME.test(e.response.content.mimeType ?? "") || STATIC_EXT.test(url)) return true;
  return false;
}

function pickHeaders(headers: HarHeader[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.name.startsWith(":") || !KEEP_HEADER.test(h.name)) continue;
    out[h.name.toLowerCase()] = SECRET_HEADER.test(h.name) ? mask(h.value) : h.value;
  }
  return out;
}

/** Cookie names only. Values are session secrets and never go into a digest. */
function cookieNames(headers: HarHeader[]): string[] {
  const raw = headers.filter((h) => h.name.toLowerCase() === "cookie").map((h) => h.value).join("; ");
  return raw
    .split(";")
    .map((c) => c.split("=")[0]!.trim())
    .filter(Boolean);
}

export function mask(value: string): string {
  const scheme = /^(Bearer|Basic|Token)\s+/i.exec(value)?.[0] ?? "";
  const secret = value.slice(scheme.length);
  if (secret.length <= 8) return `${scheme}***`;
  return `${scheme}${secret.slice(0, 4)}...(${secret.length} chars)`;
}

function decodeBody(content: HarEntry["response"]["content"]): string | undefined {
  if (!content.text) return undefined;
  return content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
}

/** Compact type sketch of a JSON value: keys and types, first array item only, depth-limited. */
export function shapeOf(value: unknown, depth = 0, maxDepth = 4): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${shapeOf(value[0], depth + 1, maxDepth)}] x${value.length}`;
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) return "{...}";
    const keys = Object.keys(value as object);
    const shown = keys.slice(0, 25).map((k) => `${k}: ${shapeOf((value as Record<string, unknown>)[k], depth + 1, maxDepth)}`);
    if (keys.length > 25) shown.push(`...+${keys.length - 25} keys`);
    return `{ ${shown.join(", ")} }`;
  }
  if (typeof value === "string") return value.length > 40 ? "string" : JSON.stringify(value);
  return typeof value === "number" || typeof value === "boolean" ? String(value) : typeof value;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...(${s.length} chars)` : s;
}

export function renderDigest(entries: DigestEntry[], title = "Recording digest"): string {
  const lines = [`# ${title}`, "", `${entries.length} data requests (static files, trackers and preflights removed).`, ""];
  entries.forEach((e, i) => {
    lines.push(`## ${i + 1}. ${e.method} ${e.route}`);
    lines.push(`- status ${e.status}, ${e.kind}, ${e.responseSize} bytes${e.count > 1 ? `, seen ${e.count}x` : ""}`);
    if (Object.keys(e.query).length) lines.push(`- query: ${JSON.stringify(e.query)}`);
    if (Object.keys(e.headers).length) lines.push(`- headers: ${JSON.stringify(e.headers)}`);
    if (e.cookies.length) lines.push(`- cookies sent: ${e.cookies.join(", ")}`);
    if (e.body) lines.push(`- body: \`${e.body}\``);
    if (e.title) lines.push(`- page title: ${e.title}`);
    if (e.responseShape) lines.push(`- response: \`${e.responseShape}\``);
    lines.push("");
  });
  return lines.join("\n");
}
