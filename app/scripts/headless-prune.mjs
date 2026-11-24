// Removes the stale bundles that headless.mjs leaves in target/headless.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** How long a bundle of another hash counts as in use: a run from another worktree may be about to import it. */
export const RECENT_MS = 10 * 60 * 1000;

/**
 * Deletes the `w3proj-headless-<hash>.mjs` files in `dir` except `keep` (a file name) and those modified within
 * `recentMs` of `now`. Touches nothing else in the folder. Returns the names removed; never throws.
 */
export function pruneBundles(dir, keep, now = Date.now(), recentMs = RECENT_MS) {
  const removed = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name === keep || !/^w3proj-headless-[0-9a-f]+\.mjs$/.test(name)) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs < recentMs) continue;
      rmSync(file, { force: true });
      removed.push(name);
    } catch {
      // Another run may have removed it, or Windows holds it open: leave it for the next run.
    }
  }
  return removed;
}
