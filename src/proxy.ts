import { randomBytes } from "node:crypto";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { FetchFn } from "./context.ts";

/**
 * Proxy URLs may contain `{session}`, e.g. `http://user-session-{session}:pass@gate.example.com:7000`.
 * Most residential providers pin the exit IP to that id, so the same id = same IP (sticky),
 * and a fresh id = a new IP (rotating).
 */
export function resolveProxyUrl(template: string, sessionId?: string): string {
  return template.includes("{session}") ? template.replaceAll("{session}", sessionId ?? newSessionId()) : template;
}

export function newSessionId(): string {
  return randomBytes(6).toString("hex");
}

export interface ProxiedFetch {
  fetch: FetchFn;
  close(): Promise<void>;
}

export function proxiedFetch(proxyUrl: string): ProxiedFetch {
  const agent = new ProxyAgent(proxyUrl);
  return {
    fetch: (url, init) => undiciFetch(url, { ...(init as object), dispatcher: agent }) as unknown as Promise<Response>,
    close: () => agent.close(),
  };
}

/** Proxy URL with the password hidden, safe for logs. */
export function redactProxy(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.href;
  } catch {
    return "(invalid proxy url)";
  }
}
