import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CookieJar } from "tough-cookie";
import { EndpointError } from "./endpoint.ts";

/** What a logged-in site needs between calls. Stored encrypted; never logged. */
export interface SessionData {
  site: string;
  /** tough-cookie serialized jar. */
  jar: object;
  /** Proxy session id, so calls keep the exit IP the login used. */
  proxySession?: string;
  userAgent?: string;
  savedAt: string;
}

/** Cookie shape Playwright's storageState() writes. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

const SITE = /^[a-z0-9.-]+$/;

export class SessionStore {
  private readonly key: Buffer;

  constructor(
    private readonly dir: string,
    secret: string,
  ) {
    if (!secret || secret.length < 16) {
      throw new EndpointError("SESSION_KEY must be set to at least 16 random characters", "config");
    }
    this.key = scryptSync(secret, "sitescrape-session-v1", 32);
  }

  private file(site: string): string {
    if (!SITE.test(site)) throw new EndpointError(`bad site name "${site}"`, "bad_input");
    return path.join(this.dir, `${site}.session`);
  }

  async save(data: SessionData): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(data.site), Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64"), { mode: 0o600 });
  }

  async load(site: string): Promise<SessionData | undefined> {
    const file = this.file(site);
    let raw: Buffer;
    try {
      raw = Buffer.from(await readFile(file, "utf8"), "base64");
    } catch {
      return undefined;
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      return JSON.parse(json) as SessionData;
    } catch {
      throw new EndpointError(`session for ${site} cannot be decrypted (wrong SESSION_KEY or corrupted file)`, "config");
    }
  }

  async remove(site: string): Promise<void> {
    await rm(this.file(site), { force: true });
  }
}

export async function jarFromBrowserCookies(cookies: BrowserCookie[]): Promise<CookieJar> {
  const jar = new CookieJar();
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, "");
    const parts = [`${c.name}=${c.value}`, `Domain=${c.domain}`, `Path=${c.path || "/"}`];
    if (c.expires > 0) parts.push(`Expires=${new Date(c.expires * 1000).toUTCString()}`);
    if (c.secure) parts.push("Secure");
    if (c.httpOnly) parts.push("HttpOnly");
    await jar.setCookie(parts.join("; "), `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`, { ignoreError: true });
  }
  return jar;
}
