// A scratch folder for tests, inside the repository's target/tmp/<pid> (not the OS temp folder, where leftovers would
// stay for good). The whole <pid> folder is removed when the process ends; tests still remove their own folders.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bundled into a test run's folder (app/node_modules/.cache/..) import.meta.url is not this file's place: walk up to
// the folder that holds tests/scratch.mjs.
function findRoot() {
  const start = dirname(fileURLToPath(import.meta.url));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "tests", "scratch.mjs"))) return dir;
    if (dirname(dir) === dir) return dirname(start);
  }
}
export const repoRoot = findRoot();
export const scratchRoot = join(repoRoot, "target", "tmp", String(process.pid));
let registered = false;

/** A new empty folder named `prefix` + random, under the scratch root. */
export function scratchDir(prefix) {
  mkdirSync(scratchRoot, { recursive: true });
  if (!registered) {
    registered = true;
    process.on("exit", () => rmSync(scratchRoot, { recursive: true, force: true }));
  }
  return mkdtempSync(join(scratchRoot, prefix));
}
