// The game's files and tables for tests, read through the release CLI (`w3proj game cat` / `game slk`).
// Only tests import it (never the app), so it stays out of the production bundle.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The git work tree and the main checkout it belongs to (the same folder outside a worktree); null outside git. */
export function mainCheckout(): { repo: string; main: string } | null {
  const git = (arg: string) => { const r = spawnSync("git", ["rev-parse", arg], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
  const repo = git("--show-toplevel"), common = git("--git-common-dir");
  return repo ? { repo, main: common ? dirname(resolve(common)) : repo } : null;
}

/** The release CLI and the game folder to give it; null without the CLI. */
function gameCli(): { bin: string; install: string[] } | null {
  const where = mainCheckout();
  if (!where) return null;
  const exe = `w3proj${process.platform === "win32" ? ".exe" : ""}`;
  const bin = [process.env.W3PROJ_BIN, join(where.repo, "target", "release", exe), join(where.main, "target", "release", exe)].find((p) => p && existsSync(p));
  if (!bin) return null;
  const gameFile = join(where.main, ".game-path");
  // One folder per line; the first that exists wins (a checkout shared by a Windows and a Linux machine), as in tests/gamepath.mjs.
  const listed = existsSync(gameFile) ? readFileSync(gameFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  const game = process.env.W3PROJ_GAME ?? listed.find((p) => existsSync(p)) ?? listed[0];
  return { bin, install: game ? ["--install", game] : [] };
}

/** The game's files by full storage path (War3.w3mod:_HD.w3mod:…); those it has (none without the game or the CLI). */
export function gameFiles(names: string[]): { name: string; bytes: Uint8Array }[] {
  const cli = gameCli();
  if (!cli) return [];
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const name of names) {
    const r = spawnSync(cli.bin, ["game", "cat", name, ...cli.install], { maxBuffer: 1 << 28 });
    if (r.status === 0 && r.stdout.length) out.push({ name, bytes: new Uint8Array(r.stdout) });
  }
  return out;
}

/** A game table's rows through `game slk`; null without the game or the CLI. */
export function gameTable(path: string, cols: string): Record<string, string>[] | null {
  const cli = gameCli();
  if (!cli) return null;
  const r = spawnSync(cli.bin, ["game", "slk", path, "--col", cols, ...cli.install], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) return null;
  const [head, ...rows] = r.stdout.split(/\r?\n/).filter((l) => l);
  const names = head.split("\t");
  return rows.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [names[i], v])));
}
