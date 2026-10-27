import path from "node:path";
import { CookieJar } from "tough-cookie";
import { createSolver, PROVIDERS, type CaptchaSolver, type ProviderName } from "./captcha.ts";
import { Context, type FetchFn } from "./context.ts";
import { EndpointError, invoke } from "./endpoint.ts";
import { proxiedFetch, resolveProxyUrl } from "./proxy.ts";
import type { Entry } from "./registry.ts";
import { SessionStore } from "./session.ts";

export interface RuntimeConfig {
  proxyUrl?: string;
  captcha?: CaptchaSolver;
  sessionKey?: string;
  sessionDir: string;
  /** Tests swap the network out; when set, the proxy is not used. */
  fetch?: FetchFn;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const provider = env.CAPTCHA_PROVIDER?.trim() as ProviderName | undefined;
  if (provider && !(provider in PROVIDERS)) {
    throw new EndpointError(`CAPTCHA_PROVIDER must be one of ${Object.keys(PROVIDERS).join(", ")}`, "config");
  }
  if (provider && !env.CAPTCHA_API_KEY) throw new EndpointError("CAPTCHA_PROVIDER is set but CAPTCHA_API_KEY is empty", "config");
  return {
    proxyUrl: env.PROXY_URL?.trim() || undefined,
    captcha: provider ? createSolver({ provider, apiKey: env.CAPTCHA_API_KEY! }) : undefined,
    sessionKey: env.SESSION_KEY || undefined,
    sessionDir: path.resolve(env.SITESCRAPE_SESSIONS ?? "sessions"),
  };
}

export function sessionStore(cfg: RuntimeConfig): SessionStore {
  return new SessionStore(cfg.sessionDir, cfg.sessionKey ?? "");
}

/** Session files are keyed by the catalog site folder, e.g. "resy.com". */
export function siteKey(site: string): string {
  return site.toLowerCase();
}

/**
 * Run one endpoint call with the right context: proxy (sticky when the endpoint uses a session),
 * captcha solver, and for session endpoints the saved cookies, written back afterwards.
 */
export async function runEntry(entry: Entry, input: unknown, cfg: RuntimeConfig): Promise<unknown> {
  const { endpoint } = entry;
  let jar: CookieJar | undefined;
  let proxySession: string | undefined;
  let userAgent: string | undefined;
  let store: SessionStore | undefined;

  if (endpoint.session) {
    store = sessionStore(cfg);
    const saved = await store.load(siteKey(entry.site));
    if (!saved) {
      throw new EndpointError(`no saved login for ${entry.site}. Run: sitescrape login https://${entry.site}/`, "auth_required");
    }
    jar = await CookieJar.deserialize(saved.jar as never);
    proxySession = saved.proxySession;
    userAgent = saved.userAgent;
  }

  const proxy = !cfg.fetch && cfg.proxyUrl ? proxiedFetch(resolveProxyUrl(cfg.proxyUrl, proxySession)) : undefined;
  const ctx = new Context({
    fetch: cfg.fetch ?? proxy?.fetch,
    jar,
    captcha: cfg.captcha,
    headers: userAgent ? { "user-agent": userAgent } : undefined,
  });

  try {
    return await invoke(endpoint, ctx, input);
  } finally {
    await proxy?.close();
    if (store && jar) {
      const saved = await store.load(siteKey(entry.site));
      if (saved) await store.save({ ...saved, jar: await jar.serialize(), savedAt: new Date().toISOString() });
    }
  }
}
