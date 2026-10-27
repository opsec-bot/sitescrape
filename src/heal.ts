import { spawn } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProbeResult } from "./probe.ts";
import type { Entry } from "./registry.ts";

export interface HealInput {
  entry: Entry;
  failure: ProbeResult;
  /** digest.md of a fresh recording of the endpoint's source page. */
  digestPath: string;
  repoRoot: string;
}

/** The instructions the repair agent gets. Kept short so a heal costs little. */
export function buildHealPrompt({ entry, failure, digestPath, repoRoot }: HealInput): string {
  const rel = (p: string) => path.relative(repoRoot, p).replaceAll("\\", "/");
  const siteDir = rel(path.dirname(entry.file));
  return [
    `The sitescrape endpoint ${entry.id} stopped working. Fix it.`,
    "",
    `Endpoint file: ${rel(entry.file)}`,
    `Failure: ${failure.error?.code}: ${failure.error?.message}`,
    `Fresh recording digest of the site: ${rel(digestPath)}`,
    `Rendered HTML of the recorded page: ${rel(path.join(path.dirname(digestPath), "page.html"))} (search it with Grep, do not read it whole)`,
    "",
    "Rules:",
    `- Only edit files in ${siteDir}/. Keep the endpoint's input schema and output field names the same, so callers do not break.`,
    "- Read the digest, find where the data now comes from, update the request or the parsing.",
    "- Read skill/SKILL.md for how endpoints are written. Do not open network.har or state.json.",
    `- Check your fix with: npx tsx src/cli.ts call ${entry.id} '${JSON.stringify(entry.endpoint.example)}'`,
    "- If the site now blocks automated access or the data is gone, change nothing and say why.",
    "- End with one line: FIXED or NOT FIXED, then the reason.",
  ].join("\n");
}

export type AgentRunner = (prompt: string, cwd: string) => Promise<string>;

/**
 * Runs Claude Code headless on the user's own subscription. Edits allowed; shell limited to the
 * sitescrape CLI. The prompt goes in on stdin so no shell quoting is involved.
 */
export const claudeRunner: AgentRunner = (prompt, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.env.SITESCRAPE_CLAUDE ?? "claude",
      [
        "-p",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,Edit,Write,Grep,Glob,Bash(npx tsx src/cli.ts call:*)",
        "--disallowedTools",
        "WebFetch,WebSearch",
      ],
      { cwd, stdio: ["pipe", "pipe", "inherit"] },
    );
    child.stdin.end(prompt);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (err) => reject(new Error(`could not start claude: ${err.message}. Is Claude Code installed?`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited with code ${code}`))));
  });

export interface HealResult {
  id: string;
  fixed: boolean;
  /** Files the agent changed and that were kept. Empty when the fix failed and was rolled back. */
  changed: string[];
  agentSummary: string;
  error?: string;
}

/**
 * Snapshot the endpoint's site folder, let the agent edit it, then re-check. If the check still
 * fails, every file goes back to how it was. Nothing is committed; the user reviews the diff.
 */
export async function heal(
  input: HealInput,
  opts: { agent: AgentRunner; verify: () => Promise<ProbeResult> },
): Promise<HealResult> {
  const siteDir = path.dirname(input.entry.file);
  const before = await snapshot(siteDir);
  let summary = "";
  try {
    summary = (await opts.agent(buildHealPrompt(input), input.repoRoot)).trim();
  } catch (err) {
    await restore(siteDir, before);
    return { id: input.entry.id, fixed: false, changed: [], agentSummary: "", error: (err as Error).message };
  }

  const after = await snapshot(siteDir);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f));
  const check = await opts.verify();
  if (check.status === "ok") {
    return { id: input.entry.id, fixed: true, changed: changed.map((f) => path.join(siteDir, f)), agentSummary: lastLine(summary) };
  }
  await restore(siteDir, before);
  return {
    id: input.entry.id,
    fixed: false,
    changed: [],
    agentSummary: lastLine(summary),
    error: check.error ? `${check.error.code}: ${check.error.message}` : check.reason,
  };
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const f of await readdir(dir)) {
    if (f.endsWith(".ts")) files.set(f, await readFile(path.join(dir, f), "utf8"));
  }
  return files;
}

async function restore(dir: string, files: Map<string, string>): Promise<void> {
  for (const f of await readdir(dir)) {
    if (f.endsWith(".ts") && !files.has(f)) await rm(path.join(dir, f));
  }
  for (const [f, text] of files) await writeFile(path.join(dir, f), text);
}

function lastLine(text: string): string {
  return text.split(/\r?\n/).filter((l) => l.trim()).at(-1) ?? "";
}
