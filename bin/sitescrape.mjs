#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so catalog endpoints can stay plain .ts files.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsx = require.resolve("tsx/cli");
const result = spawnSync(process.execPath, [tsx, path.join(root, "src", "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
