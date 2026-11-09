// Where the installed Warcraft III is, for the gate and the scripts that need the game's files.
//
//   1. W3PROJ_GAME, if set.
//   2. `.game-path` at the root of the main checkout: one line, the game's folder. Git-ignored, written by
//      scripts/setup-linux.sh (which finds Steam/Proton, Lutris and Wine installs), or by hand.
//   3. The folder above the main checkout: the Windows layout, where the repository sits inside the game's folder.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The main checkout (not a worktree's folder): `.game-path` lives only there, like `openpoints/`. */
export function mainCheckout(from = process.cwd()) {
  try {
    // git's own message stays out of the output: outside a repository (a scratch folder) "fatal: not a git
    // repository" was printed at every start of a tool, though the folder itself is the answer then.
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: from, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // git answers with `/` on Windows too; resolve gives the platform's own form, as `from` has.
    return resolve(dirname(common));
  } catch {
    return from;
  }
}

/** W3PROJ_GAME or `.game-path`; null when neither says (callers that have a default of their own keep it). */
export function chosenGamePath(from = process.cwd()) {
  if (process.env.W3PROJ_GAME) return process.env.W3PROJ_GAME;
  const file = join(mainCheckout(from), ".game-path");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? null;
}

/** The game's folder: what was chosen, else the folder above the main checkout. */
export function gamePath(from = process.cwd()) {
  return chosenGamePath(from) ?? dirname(mainCheckout(from));
}
