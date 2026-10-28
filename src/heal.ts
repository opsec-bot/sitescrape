import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProbeResult } from "./probe.ts";
import type { Entry } from "./registry.ts";

/** How the agent runs sitescrape and where it reads the skill, relative to the repo root. */
export interface AgentTools {
  cli: string;
  skill: string;
}

/** Inside the sitescrape repo itself. Catalog repos pass `npx sitescrape` and the installed skill. */
export const REPO_TOOLS: AgentTools = { cli: "npx tsx src/cli.ts", skill: "skill/SKILL.md" };

export interface HealInput {
  entry: Entry;
  failure: ProbeResult;
  /** digest.md of a fresh recording of the endpoint's source page. */
  digestPath: string;
  repoRoot: string;
  tools?: AgentTools;
}

const relTo = (root: string) => (p: string) => path.relative(root, p).replaceAll("\\", "/");

/** The instructions the repair agent gets. Kept short so a heal costs little. */
export function buildHealPrompt({ entry, failure, digestPath, repoRoot, tools = REPO_TOOLS }: HealInput): string {
  const rel = relTo(repoRoot);
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
    `- Read ${tools.skill} for how endpoints are written. Do not open network.har or state.json.`,
    `- Check your fix with: ${tools.cli} call ${entry.id} '${JSON.stringify(entry.endpoint.example)}'`,
    "- If the site now blocks automated access or the data is gone, change nothing and say why.",
    "- End with one line: FIXED or NOT FIXED, then the reason.",
  ].join("\n");
}

export interface ReviseInput {
  entry: Entry;
  request: string;
  repoRoot: string;
  /** digest.md of a fresh recording, when the change needs data the endpoint does not fetch yet. */
  digestPath?: string;
  tools?: AgentTools;
}

/** The instructions for changing a working endpoint in plain words. */
export function buildRevisePrompt({ entry, request, repoRoot, digestPath, tools = REPO_TOOLS }: ReviseInput): string {
  const rel = relTo(repoRoot);
  const siteDir = rel(path.dirname(entry.file));
  return [
    `Change the sitescrape endpoint ${entry.id}: ${request}`,
    "",
    `Endpoint file: ${rel(entry.file)}`,
    ...(digestPath
      ? [
          `Fresh recording digest of the site: ${rel(digestPath)}`,
          `Rendered HTML of the recorded page: ${rel(path.join(path.dirname(digestPath), "page.html"))} (search it with Grep, do not read it whole)`,
        ]
      : []),
    "",
    "Rules:",
    `- Only edit or add files in ${siteDir}/. A new endpoint gets its own file there.`,
    "- Keep existing input and output fields working unless the request says to change them. Adding fields is fine.",
    "- Update `description` and `notes` if what the endpoint returns or its limits change.",
    `- Read ${tools.skill} for how endpoints are written. Do not open network.har or state.json.`,
    `- Check with: ${tools.cli} call ${entry.id} '<input json>'`,
    "- If the site does not have the data, change nothing and say why.",
    "- End with one line: DONE or NOT DONE, then the reason.",
  ].join("\n");
}

export interface BuildInput {
  site: string;
  task: string;
  /** catalog/<site>, where the new endpoints go. */
  siteDir: string;
  digestPath: string;
  repoRoot: string;
  tools?: AgentTools;
}

/** The instructions for writing new endpoints straight from a recording. */
export function buildBuildPrompt({ site, task, siteDir, digestPath, repoRoot, tools = REPO_TOOLS }: BuildInput): string {
  const rel = relTo(repoRoot);
  return [
    `Write sitescrape endpoints for ${site}. Goal: ${task}`,
    "",
    `Recording digest: ${rel(digestPath)}`,
    `Rendered HTML of the recorded page: ${rel(path.join(path.dirname(digestPath), "page.html"))} (search it with Grep, do not read it whole)`,
    "",
    "Rules:",
    `- Read ${tools.skill} first and follow it. Do not open network.har or state.json.`,
    `- Only write files in ${rel(siteDir)}/. One endpoint per file, named for what it returns (search, list, detail).`,
    "- Give every input field a .describe(). Write `notes`: what one call returns, paging, and what the site does not expose.",
    `- Check each endpoint with: ${tools.cli} call ${site}/<name> '<example json>'`,
    "- If the recording does not contain the data, write nothing and say what to record instead.",
    "- End with one line: BUILT <ids, comma separated> or NOT BUILT, then the reason.",
  ].join("\n");
}

export type AgentRunner = (prompt: string, cwd: string, cli?: string) => Promise<string>;

/**
 * Runs Claude Code headless on the user's own subscription. Edits allowed; shell limited to the
 * sitescrape CLI. The prompt goes in on stdin so no shell quoting is involved.
 */
export const claudeRunner: AgentRunner = (prompt, cwd, cli = REPO_TOOLS.cli) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.env.SITESCRAPE_CLAUDE ?? "claude",
      [
        "-p",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        `Read,Edit,Write,Grep,Glob,Bash(${cli} call:*)`,
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

export interface EditResult {
  ok: boolean;
  /** Files the agent changed and that were kept. Empty when the check failed and was rolled back. */
  changed: string[];
  agentSummary: string;
  error?: string;
}

/**
 * Snapshot a site folder, let the agent edit it, then check. If the check fails, every file goes
 * back to how it was and new files are removed. Nothing is committed; the user reviews the diff.
 */
export async function agentEdit(
  dir: string,
  prompt: string,
  opts: { agent: AgentRunner; cwd: string; cli?: string; verify: (changed: string[]) => Promise<ProbeResult> },
): Promise<EditResult> {
  await mkdir(dir, { recursive: true });
  const before = await snapshot(dir);
  let summary = "";
  try {
    summary = (await opts.agent(prompt, opts.cwd, opts.cli)).trim();
  } catch (err) {
    await restore(dir, before);
    return { ok: false, changed: [], agentSummary: "", error: (err as Error).message };
  }

  const after = await snapshot(dir);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((f) => before.get(f) !== after.get(f))
    .map((f) => path.join(dir, f));
  const check = await opts.verify(changed);
  if (check.status === "ok") return { ok: true, changed, agentSummary: lastLine(summary) };
  await restore(dir, before);
  return {
    ok: false,
    changed: [],
    agentSummary: lastLine(summary),
    error: check.error ? `${check.error.code}: ${check.error.message}` : check.reason,
  };
}

export interface HealResult {
  id: string;
  fixed: boolean;
  /** Files the agent changed and that were kept. Empty when the fix failed and was rolled back. */
  changed: string[];
  agentSummary: string;
  error?: string;
}

/** Let the agent repair a broken endpoint; keep the edit only if the endpoint passes again. */
export async function heal(
  input: HealInput,
  opts: { agent: AgentRunner; verify: () => Promise<ProbeResult> },
): Promise<HealResult> {
  const r = await agentEdit(path.dirname(input.entry.file), buildHealPrompt(input), {
    agent: opts.agent,
    cwd: input.repoRoot,
    cli: input.tools?.cli,
    verify: () => opts.verify(),
  });
  return { id: input.entry.id, fixed: r.ok, changed: r.changed, agentSummary: r.agentSummary, ...(r.error ? { error: r.error } : {}) };
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
