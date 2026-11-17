// A scratch folder for tests, inside the repository's target/tmp/<pid> (not the OS temp folder, where leftovers would
// stay for good). The whole <pid> folder is removed when the process ends; tests still remove their own folders.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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
