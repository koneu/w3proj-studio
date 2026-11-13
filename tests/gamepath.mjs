// Where the installed Warcraft III is, for the gate and the scripts that need the game's files.
//
//   1. W3PROJ_GAME, if set.
//   2. `.game-path` at the root of the main checkout: the game's folder, one per line; the first that exists wins
//      (a checkout shared by two machines lists each one's). Git-ignored, written by scripts/setup-linux.sh (which
//      finds Steam/Proton, Lutris and Wine installs) and scripts/setup-windows.bat, or by hand.
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

/** The folders a `.game-path` lists, in order: one per line, `#` lines and blank lines left out. */
export function listedGamePaths(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

/** The folder of `.game-path` to use: the first listed one that exists (one file can serve a checkout shared by a
 *  Windows and a Linux machine, a line for each), else the first listed. */
export function pickGamePath(listed, exists = existsSync) {
  return listed.find((p) => exists(p)) ?? listed[0] ?? null;
}

/** W3PROJ_GAME or `.game-path`; null when neither says (callers that have a default of their own keep it). */
export function chosenGamePath(from = process.cwd()) {
  if (process.env.W3PROJ_GAME) return process.env.W3PROJ_GAME;
  const file = join(mainCheckout(from), ".game-path");
  if (!existsSync(file)) return null;
  return pickGamePath(listedGamePaths(readFileSync(file, "utf8")));
}

/** The game's folder: what was chosen, else the folder above the main checkout. */
export function gamePath(from = process.cwd()) {
  return chosenGamePath(from) ?? dirname(mainCheckout(from));
}
