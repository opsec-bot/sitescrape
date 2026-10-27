import * as cheerio from "cheerio";
import type { CookieJar } from "tough-cookie";
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

  constructor(opts: ContextOptions = {}) {
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.headers = { ...DEFAULT_HEADERS, ...opts.headers };
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 500;
    this.jar = opts.jar;
    this.solver = opts.captcha;
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
