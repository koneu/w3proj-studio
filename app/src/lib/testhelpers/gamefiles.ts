// The game's files and tables for tests, read through the release CLI (`w3proj game cat` / `game slk`).
// Only tests import it (never the app), so it stays out of the production bundle.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The git work tree and the main checkout it belongs to (the same folder outside a worktree); null outside git. */
export function mainCheckout(): { repo: string; main: string } | null {
  if (checkout === undefined) checkout = findCheckout();
  return checkout;
}
let checkout: { repo: string; main: string } | null | undefined;
function findCheckout(): { repo: string; main: string } | null {
  // [Refactored] Walk parent directories in-process to find `.git` instead of spawning two synchronous `git rev-parse` subprocesses per test worker.
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        const text = readFileSync(dotGit, "utf8");
        const m = /^gitdir:\s*(.+)$/m.exec(text);
        if (m) {
          const gitDir = resolve(dir, m[1].trim());
          const commondirFile = join(gitDir, "commondir");
          const common = existsSync(commondirFile) ? resolve(gitDir, readFileSync(commondirFile, "utf8").trim()) : dirname(dirname(gitDir));
          return { repo: dir, main: dirname(common) };
        }
      } catch {
        // `.git` is a directory (main checkout), not a worktree file.
      }
      return { repo: dir, main: dir };
    }
    if (dirname(dir) === dir) break;
  }
  const git = (arg: string) => { const r = spawnSync("git", ["rev-parse", arg], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
  const repo = git("--show-toplevel"), common = git("--git-common-dir");
  return repo ? { repo, main: common ? dirname(resolve(common)) : repo } : null;
}

/** The release CLI and the game folder to give it; null without the CLI. */
export function gameCli(): { bin: string; install: string[] } | null {
  if (cli === undefined) cli = findGameCli();
  return cli;
}
let cli: { bin: string; install: string[] } | null | undefined;
function findGameCli(): { bin: string; install: string[] } | null {
  // [Refactored] Treat an explicit empty W3PROJ_GAME="" (used by `gate.mjs commit` tier) as disabling slow CASC reads;
  // `tstestcorpus` in `corpus`/`batch` tiers sets W3PROJ_GAME + W3PROJ_REQUIRE_CORPUS=1 so game tests always run there.
  if (process.env.W3PROJ_GAME === "") return null;
  const where = mainCheckout();
  if (!where) return null;
  const exe = `w3proj${process.platform === "win32" ? ".exe" : ""}`;
  const bin = [process.env.W3PROJ_BIN, join(where.repo, "target", "release", exe), join(where.main, "target", "release", exe)].find((p) => p && existsSync(p));
  if (!bin) return null;
  const gameFile = join(where.main, ".game-path");
  // One folder per line; the first that exists wins (a checkout shared by a Windows and a Linux machine), as in tests/gamepath.mjs.
  const listed = existsSync(gameFile) ? readFileSync(gameFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  const game = process.env.W3PROJ_GAME ?? listed.find((p) => existsSync(p)) ?? listed[0];
  // [Refactored] Fast pre-check that `.build.info` in the game install is actually readable in this environment (e.g. sandbox) so `gameFiles` / `gameTable` don't spawn 25+ failing subprocesses.
  if (game && !existsSync(join(game, ".build.info"))) return null;
  return { bin, install: game ? ["--install", game] : [] };
}

const fileCache = new Map<string, Uint8Array | null>();

/** The game's files by full storage path (War3.w3mod:_HD.w3mod:…); those it has (none without the game or the CLI). */
export function gameFiles(names: string[]): { name: string; bytes: Uint8Array }[] {
  const g = gameCli();
  if (!g) return [];
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const name of names) {
    let hit = fileCache.get(name);
    if (hit === undefined) {
      const r = spawnSync(g.bin, ["game", "cat", name, ...g.install], { maxBuffer: 1 << 28 });
      hit = r.status === 0 && r.stdout.length ? new Uint8Array(r.stdout) : null;
      fileCache.set(name, hit);
    }
    if (hit) out.push({ name, bytes: hit });
  }
  return out;
}

/** A game table's rows through `game slk`; null without the game or the CLI. */
export function gameTable(path: string, cols: string): Record<string, string>[] | null {
  const g = gameCli();
  if (!g) return null;
  const r = spawnSync(g.bin, ["game", "slk", path, "--col", cols, ...g.install], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) return null;
  const [head, ...rows] = r.stdout.split(/\r?\n/).filter((l) => l);
  const names = head.split("\t");
  return rows.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [names[i], v])));
}
