import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { type BrowserContext } from "playwright";
import { launchBrowser } from "./browser.ts";
import { digestHar, renderDigest, type Har } from "./har.ts";
import { newSessionId } from "./proxy.ts";
import { jarFromBrowserCookies, type BrowserCookie, type SessionStore } from "./session.ts";

export interface RecordOptions {
  url: string;
  /** Plain-language task, saved with the recording so the endpoint writer knows the goal. */
  task?: string;
  outRoot?: string;
  headless?: boolean;
  /** Stop automatically after this many seconds instead of waiting for Enter. */
  seconds?: number;
  /** Browser channel, e.g. "chrome" or "msedge". Falls back to these if bundled Chromium is missing. */
  channel?: string;
  proxyUrl?: string;
}

export interface Recording {
  dir: string;
  harPath: string;
  digestPath: string;
}

export async function record(opts: RecordOptions): Promise<Recording> {
  const host = new URL(opts.url).hostname;
  const dir = path.join(opts.outRoot ?? "recordings", host, stamp());
  await mkdir(dir, { recursive: true });
  const harPath = path.join(dir, "network.har");

  const browser = await launchBrowser({ headless: opts.headless ?? false, channel: opts.channel, proxyUrl: opts.proxyUrl });
  const context = await browser.newContext({ recordHar: { path: harPath, content: "embed" } });
  const page = await context.newPage();
  await page.goto(opts.url, { waitUntil: "domcontentloaded" });

  if (opts.seconds !== undefined) {
    await page.waitForTimeout(opts.seconds * 1000);
  } else {
    console.log("Do the task in the browser window. Press Enter here when done.");
    await waitForEnterOrClose(context);
  }

  // Rendered DOM, for sites whose data is in the HTML rather than in JSON calls.
  await writeFile(path.join(dir, "page.html"), await page.content()).catch(() => {});
  // Cookies stay on disk next to the HAR (recordings/ is git-ignored) so authenticated endpoints can reuse them.
  await context.storageState({ path: path.join(dir, "state.json") }).catch(() => {});
  await context.close();
  await browser.close();

  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ url: opts.url, task: opts.task ?? null, recordedAt: new Date().toISOString() }, null, 2),
  );
  const digestPath = await writeDigest(harPath, [baseDomain(host)], opts.task);
  return { dir, harPath, digestPath };
}

export async function writeDigest(harPath: string, hosts: string[], task?: string): Promise<string> {
  const har = JSON.parse(await readFile(harPath, "utf8")) as Har;
  const entries = digestHar(har, { hosts });
  const header = task ? `Task: ${task}\n\n` : "";
  const out = path.join(path.dirname(harPath), "digest.md");
  await writeFile(out, header + renderDigest(entries, `Digest of ${path.basename(path.dirname(path.dirname(harPath)))}`));
  return out;
}

export interface LoginOptions {
  url: string;
  /** Session name; must match the catalog folder. Defaults to the host without "www.". */
  site?: string;
  channel?: string;
  proxyUrl?: string;
  store: SessionStore;
}

/**
 * Open a real browser, let the user log in by hand (2FA and captchas included), then save the
 * cookies encrypted together with the proxy session id and user agent, so later calls look like
 * the same browser on the same IP.
 */
export async function login(opts: LoginOptions): Promise<string> {
  const site = (opts.site ?? new URL(opts.url).hostname.replace(/^www\./, "")).toLowerCase();
  const proxySession = newSessionId();
  const browser = await launchBrowser({ headless: false, channel: opts.channel, proxyUrl: opts.proxyUrl, proxySession });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(opts.url, { waitUntil: "domcontentloaded" });
  const userAgent = await page.evaluate(() => navigator.userAgent);
  console.log("Log in in the browser window. Press Enter here when you are logged in.");
  await waitForEnterOrClose(context);
  const { cookies } = await context.storageState();
  await context.close();
  await browser.close();

  const jar = await jarFromBrowserCookies(cookies as BrowserCookie[]);
  await opts.store.save({ site, jar: await jar.serialize(), proxySession, userAgent, savedAt: new Date().toISOString() });
  return site;
}

/** "www.shop.example.co" -> "example.co"; good enough to keep same-site API subdomains. */
export function baseDomain(host: string): string {
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

function waitForEnterOrClose(context: BrowserContext): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    const done = () => {
      rl.close();
      resolve();
    };
    rl.once("line", done);
    context.on("page", (p) => p.on("close", () => context.pages().length === 0 && done()));
    for (const p of context.pages()) p.on("close", () => context.pages().length === 0 && done());
  });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
