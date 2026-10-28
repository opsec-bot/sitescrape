import * as cheerio from "cheerio";
import type { Browser, Page } from "playwright";
import type { CookieJar } from "tough-cookie";
import { launchBrowser } from "./browser.ts";
import type { CaptchaSolver, CaptchaTask } from "./captcha.ts";
import { EndpointError } from "./endpoint.ts";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ContextOptions {
  /** Swap the transport. Tests pass a fake; the proxy-aware fetch also plugs in here. */
  fetch?: FetchFn;
  /** Headers sent on every request, e.g. a recorded User-Agent or cookie. */
  headers?: Record<string, string>;
  retries?: number;
  /** Base delay for retry backoff, in ms. */
  backoffMs?: number;
  /** Cookies sent with matching requests and updated from Set-Cookie. */
  jar?: CookieJar;
  captcha?: CaptchaSolver;
  /** Proxy URL template for the browser launched by `page()`; the sticky session is substituted in. */
  proxyUrl?: string;
  proxySession?: string;
  /** Browser channel for `page()`, e.g. "chrome" or "msedge". */
  channel?: string;
}

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class Context {
  private readonly doFetch: FetchFn;
  private readonly headers: Record<string, string>;
  private readonly retries: number;
  private readonly backoffMs: number;
  readonly jar?: CookieJar;
  private readonly solver?: CaptchaSolver;
  private readonly proxyUrl?: string;
  private readonly proxySession?: string;
  private readonly channel?: string;
  private browserPromise?: Promise<Browser>;

  constructor(opts: ContextOptions = {}) {
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.headers = { ...DEFAULT_HEADERS, ...opts.headers };
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 500;
    this.jar = opts.jar;
    this.solver = opts.captcha;
    this.proxyUrl = opts.proxyUrl;
    this.proxySession = opts.proxySession;
    this.channel = opts.channel;
  }

  /** Solve a captcha with the configured provider (CAPTCHA_PROVIDER + CAPTCHA_API_KEY). */
  async solveCaptcha(task: CaptchaTask): Promise<string> {
    if (!this.solver) throw new EndpointError("this endpoint needs a captcha solver: set CAPTCHA_PROVIDER and CAPTCHA_API_KEY", "config");
    return this.solver.solve(task);
  }

  /** fetch with default headers, retrying network errors and retryable statuses. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers, ...(init.headers as Record<string, string> | undefined) };
    if (this.jar) {
      const cookie = await this.jar.getCookieString(url);
      if (cookie) headers.cookie = headers.cookie ? `${headers.cookie}; ${cookie}` : cookie;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs * 2 ** (attempt - 1));
      try {
        const res = await this.doFetch(url, { ...init, headers });
        if (this.jar) {
          for (const c of res.headers.getSetCookie()) await this.jar.setCookie(c, url, { ignoreError: true });
        }
        if (!RETRY_STATUS.has(res.status) || attempt === this.retries) return res;
        lastError = new EndpointError(`HTTP ${res.status} from ${url}`, "upstream");
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async json<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.ok(url, init);
    return (await res.json()) as T;
  }

  async text(url: string, init?: RequestInit): Promise<string> {
    return (await this.ok(url, init)).text();
  }

  /** Fetch a page and load it into cheerio, for sites that render data server-side. */
  async html(url: string, init?: RequestInit): Promise<cheerio.CheerioAPI> {
    return cheerio.load(await this.text(url, init));
  }

  /**
   * A fresh browser page, for sites whose data only exists after client-side JS runs
   * (SPAs, Blazor/websocket apps, heavy bot-scoring). The browser launches once per context,
   * reuses the proxy, session and user-agent, and is closed by `close()`. Prefer `fetch`/`html`
   * when the data is reachable over HTTP; a browser is the slow fallback.
   */
  async page(): Promise<Page> {
    if (!this.browserPromise) {
      this.browserPromise = launchBrowser({
        headless: true,
        channel: this.channel,
        proxyUrl: this.proxyUrl,
        proxySession: this.proxySession,
      });
    }
    const browser = await this.browserPromise;
    const browserContext = await browser.newContext({ userAgent: this.headers["user-agent"], locale: "en-US" });
    if (this.jar) {
      const cookies = await browserCookiesFromJar(this.jar);
      if (cookies.length) await browserContext.addCookies(cookies);
    }
    return browserContext.newPage();
  }

  /** Close the browser launched by `page()`, if any. Always called at the end of a run. */
  async close(): Promise<void> {
    if (!this.browserPromise) return;
    const browser = await this.browserPromise.catch(() => undefined);
    this.browserPromise = undefined;
    await browser?.close().catch(() => {});
  }

  private async ok(url: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetch(url, init);
    if (res.status === 404) throw new EndpointError(`not found: ${url}`, "not_found");
    if (!res.ok) throw new EndpointError(`HTTP ${res.status} from ${url}`, "upstream");
    return res;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Best-effort tough-cookie jar -> Playwright cookies, so a browser `page()` reuses a saved login. */
async function browserCookiesFromJar(jar: CookieJar): Promise<PlaywrightCookie[]> {
  const serialized = (await jar.serialize()) as { cookies?: Array<Record<string, unknown>> };
  const out: PlaywrightCookie[] = [];
  for (const c of serialized.cookies ?? []) {
    const domainRaw = typeof c.domain === "string" ? c.domain : undefined;
    const name = typeof c.key === "string" ? c.key : undefined;
    if (!domainRaw || !name) continue;
    const domain = c.hostOnly === true ? domainRaw : domainRaw.startsWith(".") ? domainRaw : `.${domainRaw}`;
    const sameSiteRaw = typeof c.sameSite === "string" ? c.sameSite.toLowerCase() : undefined;
    const sameSite = sameSiteRaw === "strict" ? "Strict" : sameSiteRaw === "lax" ? "Lax" : sameSiteRaw === "none" ? "None" : undefined;
    const expires = typeof c.expires === "string" && c.expires !== "Infinity" ? Math.floor(new Date(c.expires).getTime() / 1000) : undefined;
    out.push({
      name,
      value: typeof c.value === "string" ? c.value : "",
      domain,
      path: typeof c.path === "string" ? c.path : "/",
      ...(expires && Number.isFinite(expires) ? { expires } : {}),
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      ...(sameSite ? { sameSite } : {}),
    });
  }
  return out;
}
