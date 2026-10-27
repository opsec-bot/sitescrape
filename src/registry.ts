import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Endpoint } from "./endpoint.ts";

export interface Entry {
  /** "<site>/<name>", e.g. "books.toscrape.com/search". */
  id: string;
  site: string;
  name: string;
  file: string;
  endpoint: Endpoint;
}

/** Load every catalog/<site>/<name>.ts that default-exports an endpoint. Files starting with "_" are helpers. */
export async function loadCatalog(dir: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const site of (await readdirSafe(dir)).sort()) {
    const siteDir = path.join(dir, site);
    for (const file of (await readdirSafe(siteDir)).sort()) {
      if (!file.endsWith(".ts") || file.startsWith("_") || file.endsWith(".test.ts")) continue;
      const full = path.join(siteDir, file);
      const mod = await import(pathToFileURL(full).href);
      if (typeof mod.default?.run !== "function") continue;
      const name = file.slice(0, -3);
      entries.push({ id: `${site}/${name}`, site, name, file: full, endpoint: mod.default });
    }
  }
  return entries;
}

export function find(entries: Entry[], id: string): Entry | undefined {
  return entries.find((e) => e.id === id);
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
