import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EndpointError } from "./endpoint.ts";
import type { Entry } from "./registry.ts";

export interface ProbeResult {
  id: string;
  status: "ok" | "failed" | "skipped";
  ms: number;
  /** Last time the example passed, ISO. Kept from earlier runs when this one fails. */
  last_verified: string | null;
  checked_at: string;
  error?: { code: string; message: string };
  reason?: string;
}

export type StatusFile = Record<string, ProbeResult>;

export async function readStatus(file: string): Promise<StatusFile> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StatusFile;
  } catch {
    return {};
  }
}

export async function writeStatus(file: string, status: StatusFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(status, null, 2) + "\n");
}

export interface ProbeOptions {
  run: (entry: Entry, input: unknown) => Promise<unknown>;
  /** Sites with a saved login; session endpoints for other sites are skipped, not failed. */
  hasLogin?: (site: string) => Promise<boolean>;
  previous?: StatusFile;
  now?: () => Date;
}

/**
 * Run each endpoint's example and record whether it still matches its schema.
 * Action endpoints are never run automatically: they change things on the live site.
 */
export async function probe(entries: Entry[], opts: ProbeOptions): Promise<ProbeResult[]> {
  const now = opts.now ?? (() => new Date());
  const results: ProbeResult[] = [];
  for (const entry of entries) {
    const prev = opts.previous?.[entry.id];
    const base = { id: entry.id, last_verified: prev?.last_verified ?? null, checked_at: now().toISOString() };

    if (entry.endpoint.kind === "action") {
      results.push({ ...base, status: "skipped", ms: 0, reason: "action endpoint, not run automatically" });
      continue;
    }
    if (entry.endpoint.session && !(await opts.hasLogin?.(entry.site))) {
      results.push({ ...base, status: "skipped", ms: 0, reason: `no saved login for ${entry.site}` });
      continue;
    }

    const started = Date.now();
    try {
      await opts.run(entry, entry.endpoint.example);
      results.push({ ...base, status: "ok", ms: Date.now() - started, last_verified: now().toISOString() });
    } catch (err) {
      const error =
        err instanceof EndpointError
          ? { code: err.code, message: err.message }
          : { code: "crash", message: err instanceof Error ? err.message : String(err) };
      results.push({ ...base, status: "failed", ms: Date.now() - started, error });
    }
  }
  return results;
}

export function mergeStatus(previous: StatusFile, results: ProbeResult[]): StatusFile {
  const next = { ...previous };
  for (const r of results) next[r.id] = r;
  return next;
}
