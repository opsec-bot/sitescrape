import { chromium, type Browser } from "playwright";
import { resolveProxyUrl } from "./proxy.ts";

export interface LaunchOptions {
  /** Headed for interactive recording; headless for endpoint runs. Defaults to headless. */
  headless?: boolean;
  /** Force a browser channel, e.g. "chrome" or "msedge". Otherwise bundled Chromium, then Chrome, then Edge. */
  channel?: string;
  /** Proxy URL template; the sticky session id is substituted in. */
  proxyUrl?: string;
  proxySession?: string;
}

/** Launch Chromium, falling back to installed Chrome/Edge when the bundled build is missing. */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const proxy = opts.proxyUrl ? parseProxy(resolveProxyUrl(opts.proxyUrl, opts.proxySession)) : undefined;
  const channels = opts.channel ? [opts.channel] : [undefined, "chrome", "msedge"];
  let lastError: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless: opts.headless ?? true, channel, proxy });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function parseProxy(raw: string): { server: string; username?: string; password?: string } {
  const u = new URL(raw);
  const server = `${u.protocol}//${u.host}`;
  return {
    server,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}
