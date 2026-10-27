import { EndpointError } from "./endpoint.ts";
import type { FetchFn } from "./context.ts";

// Anti-Captcha, CapMonster and 2Captcha all speak the same createTask / getTaskResult JSON API.
export const PROVIDERS = {
  anticaptcha: "https://api.anti-captcha.com",
  capmonster: "https://api.capmonster.cloud",
  "2captcha": "https://api.2captcha.com",
} as const;

export type ProviderName = keyof typeof PROVIDERS;

export type CaptchaTask =
  | { type: "recaptcha_v2"; websiteURL: string; websiteKey: string; invisible?: boolean }
  | { type: "recaptcha_v3"; websiteURL: string; websiteKey: string; action?: string; minScore?: number }
  | { type: "hcaptcha"; websiteURL: string; websiteKey: string }
  | { type: "turnstile"; websiteURL: string; websiteKey: string; action?: string }
  | { type: "image"; body: string };

export interface CaptchaSolver {
  /** Returns the token (or text, for image captchas) to submit to the site. */
  solve(task: CaptchaTask): Promise<string>;
}

export interface SolverOptions {
  provider: ProviderName;
  apiKey: string;
  fetch?: FetchFn;
  pollMs?: number;
  timeoutMs?: number;
}

function toProviderTask(task: CaptchaTask): Record<string, unknown> {
  switch (task.type) {
    case "recaptcha_v2":
      return { type: "RecaptchaV2TaskProxyless", websiteURL: task.websiteURL, websiteKey: task.websiteKey, isInvisible: task.invisible ?? false };
    case "recaptcha_v3":
      return {
        type: "RecaptchaV3TaskProxyless",
        websiteURL: task.websiteURL,
        websiteKey: task.websiteKey,
        pageAction: task.action ?? "verify",
        minScore: task.minScore ?? 0.7,
      };
    case "hcaptcha":
      return { type: "HCaptchaTaskProxyless", websiteURL: task.websiteURL, websiteKey: task.websiteKey };
    case "turnstile":
      return { type: "TurnstileTaskProxyless", websiteURL: task.websiteURL, websiteKey: task.websiteKey, ...(task.action ? { action: task.action } : {}) };
    case "image":
      return { type: "ImageToTextTask", body: task.body };
  }
}

interface ApiReply {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number | string;
  status?: "processing" | "ready";
  solution?: { gRecaptchaResponse?: string; token?: string; text?: string };
}

export function createSolver(opts: SolverOptions): CaptchaSolver {
  const base = PROVIDERS[opts.provider];
  if (!base) throw new EndpointError(`unknown captcha provider "${opts.provider}"`, "config");
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  async function call(method: string, body: object): Promise<ApiReply> {
    const res = await doFetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey: opts.apiKey, ...body }),
    });
    if (!res.ok) throw new EndpointError(`${opts.provider} ${method}: HTTP ${res.status}`, "upstream");
    const reply = (await res.json()) as ApiReply;
    if (reply.errorId) {
      throw new EndpointError(`${opts.provider} ${method}: ${reply.errorCode ?? "error"} ${reply.errorDescription ?? ""}`.trim(), "upstream");
    }
    return reply;
  }

  return {
    async solve(task) {
      const { taskId } = await call("createTask", { task: toProviderTask(task) });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const reply = await call("getTaskResult", { taskId });
        if (reply.status !== "ready") continue;
        const answer = reply.solution?.gRecaptchaResponse ?? reply.solution?.token ?? reply.solution?.text;
        if (!answer) throw new EndpointError(`${opts.provider} returned a solution without a token`, "upstream");
        return answer;
      }
      throw new EndpointError(`${opts.provider} did not solve the captcha within ${timeoutMs / 1000}s`, "upstream");
    },
  };
}
