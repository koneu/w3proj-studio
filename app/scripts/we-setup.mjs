// Sets up what we-drive.mjs runs the real World Editor in, so it never runs from or writes into the real install
// or the user's Wine prefix. Linux only, and local only: it needs the installed game, Proton and Xvfb, and is no
// part of CI or the commit gate.
//
// One place for all worktrees (like the shared Rust coverage folder): W3PROJ_WE_DIR, else target/we of the main
// checkout. In it:
//
//   install/      a farm of the install: hardlinks of the real files, except the ones the editor writes, which are
//                 real copies (the CASC .idx indexes, shmem, ecache: about 6 MB). we-drive mounts every hardlink
//                 read-only for the editor (bubblewrap), so not even a write through a link can reach the real install.
//   prefix/       the Wine prefix (STEAM_COMPAT_DATA_PATH); Proton fills it on the first start (about 0.6 GB).
//   we-rofs.so    built from we-rofs.c: turns the editor's read-write opens of the read-only links into read-only ones.
//   build.info    the game build the farm was made from; the farm is made again only when the game's differs.
//   (the lock is not in here: see lockPath, one per user and machine, whatever the farm)
//
//   node scripts/we-setup.mjs [--game DIR]     set up (idempotent)
//   node scripts/we-setup.mjs --clean          remove the farm, the prefix and the rest
//   node scripts/we-setup.mjs --snapshot FILE  write a list of the user's Steam prefix's files (the install is in it):
//                                              size, mtime, ctime, inode, and the sha256 of files under 64 MB
//   node scripts/we-setup.mjs --compare A B    compare two snapshots; exit 1 if a file of the install or of the
//                                              editor's preferences (Documents/Warcraft III) changed, came or went.
//                                              Other changes in the prefix are listed (the user's running Battle.net
//                                              app writes there; the editor can't, its sandbox has the prefix read-only)
//
// The game folder: --game, else W3PROJ_GAME / .game-path (tests/gamepath.mjs). The farm has to be on the install's
// file system (hardlinks); if it isn't, setting up fails rather than copying 34 GB.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chosenGamePath, gamePath, mainCheckout } from "../../tests/gamepath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, "..", "..");
export const weDir = () => resolve(process.env.W3PROJ_WE_DIR ?? join(mainCheckout(repo), "target", "we"));
export const farmDir = () => join(weDir(), "install");
export const prefixDir = () => join(weDir(), "prefix");
export const shimPath = () => join(weDir(), "we-rofs.so");
const stampPath = () => join(weDir(), "build.info");

/** Files of the install the editor writes: real copies in the farm. Everything else is a hardlink. */
export const isCopied = (rel) => /\.idx$/.test(rel) || /(^|\/)shmem$/.test(rel) || /(^|\/)ecache\//.test(rel);

function* walk(dir, base = dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, base);
    else if (e.isFile()) yield relative(base, p).split("\\").join("/");
  }
}

export function gameDir(opt) {
  return resolve(opt ?? chosenGamePath(repo) ?? gamePath(repo));
}

/** The user's Steam prefix the install lives in (…/compatdata/<id>), or null if it isn't in one. */
export function userCompatData(game) {
  const parts = game.split("/");
  const i = parts.lastIndexOf("pfx");
  return i > 1 && parts[i - 2] === "compatdata" ? parts.slice(0, i).join("/") : null;
}

/** The farm's files that are hardlinks of the install (absolute paths), for the read-only mounts. */
export function linkedFiles() {
  const farm = farmDir();
  if (!existsSync(farm)) return [];
  return [...walk(farm)].filter((rel) => !isCopied(rel) && statSync(join(farm, rel)).nlink > 1).map((rel) => join(farm, rel));
}

/** What a run needs that isn't there, or null: the game, Proton, Xvfb, bubblewrap, a C compiler (for the shim). */
export function missing(game) {
  if (process.platform !== "linux") return "the World Editor runs through Proton, on Linux only";
  if (!existsSync(join(game, "_retail_", "x86_64", "World Editor.exe"))) return `no World Editor in ${game} (set W3PROJ_GAME or .game-path)`;
  if (!userCompatData(game)) return `${game} isn't in a Steam prefix (…/compatdata/<id>/pfx/…), so there's no Proton build to use`;
  for (const tool of ["Xvfb", "bwrap", "cc", "python3"]) {
    try { execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }); } catch { return `${tool} isn't installed`; }
  }
  try { execFileSync("python3", ["-I", "-c", "import Xlib.ext.xtest, PIL"], { stdio: "ignore" }); } catch { return "python3 lacks python-xlib or Pillow (Debian/Ubuntu: python3-xlib python3-pil)"; }
  return null;
}

function buildShim() {
  const src = join(here, "we-rofs.c"), out = shimPath();
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) return false;
  mkdirSync(dirname(out), { recursive: true });
  execFileSync("cc", ["-shared", "-fPIC", "-O2", "-o", `${out}.tmp`, src, "-ldl"], { stdio: ["ignore", "inherit", "inherit"] });
  renameSync(`${out}.tmp`, out);
  return true;
}

function place(game, rel) {
  const src = join(game, rel), dst = join(farmDir(), rel);
  mkdirSync(dirname(dst), { recursive: true });
  if (isCopied(rel)) {
    copyFileSync(src, dst);
    return statSync(src).size;
  }
  try { linkSync(src, dst); } catch (e) { throw new Error(`can't hardlink ${rel} (${e.code}): the farm (${farmDir()}) must be on the install's file system`); }
  return 0;
}

/** Sets up the farm, the prefix folder and the shim. The farm is made again only for another game build. */
export function setup(game) {
  const why = missing(game);
  if (why) throw new Error(why);
  const build = readFileSync(join(game, ".build.info"), "utf8");
  const shim = buildShim();
  mkdirSync(prefixDir(), { recursive: true });
  if (existsSync(stampPath()) && readFileSync(stampPath(), "utf8") === build && existsSync(farmDir())) {
    // Same build: only files that went missing are placed again (copies the editor changed stay as it left them).
    let fixed = 0;
    for (const rel of walk(game)) if (!existsSync(join(farmDir(), rel))) { place(game, rel); fixed++; }
    return { dir: weDir(), reused: true, fixed, shimBuilt: shim };
  }
  rmSync(farmDir(), { recursive: true, force: true });
  rmSync(stampPath(), { force: true });
  let linked = 0, copied = 0, bytes = 0;
  for (const rel of walk(game)) {
    const n = place(game, rel);
    if (isCopied(rel)) { copied++; bytes += n; } else linked++;
  }
  writeFileSync(stampPath(), build);
  return { dir: weDir(), reused: false, linked, copied, copiedMB: Math.round(bytes / 1e5) / 10, shimBuilt: shim };
}

export function clean() {
  for (const p of [farmDir(), prefixDir(), shimPath(), stampPath()]) rmSync(p, { recursive: true, force: true });
}

// ---- the lock: one World Editor in the prefix at a time ---------------------------------------------------

function lockOwner(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function ageMs(path) {
  try { return Date.now() - statSync(path).mtimeMs; } catch { return 0; }
}

/**
 * The lock folder: one per user and machine, shared by every worktree and every W3PROJ_WE_DIR (two farms still
 * share the one display, GPU and CPU, and the editors disturb each other). W3PROJ_WE_LOCK overrides it (tests).
 */
export function lockPath() {
  if (process.env.W3PROJ_WE_LOCK) return resolve(process.env.W3PROJ_WE_LOCK);
  let user = "user";
  try { user = userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_"); } catch { /* no passwd entry */ }
  const run = process.env.XDG_RUNTIME_DIR;
  if (run && existsSync(run)) return join(run, "w3proj-we.lock");
  return join(tmpdir(), `w3proj-we-${user}.lock`);
}

/**
 * Takes the lock folder (as the gate's coverage lock: a folder with the owner's process in it, taken over when that
 * process is gone). Waits while another run holds it, saying so once (who, since when); gives
 * up after `timeoutMs`. Returns a function that lets it go.
 */
export async function takeLock(say, timeoutMs = 30 * 60 * 1000) {
  const dir = lockPath(), owner = join(dir, "owner.json");
  mkdirSync(dirname(dir), { recursive: true });
  const start = Date.now();
  let told = 0;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, JSON.stringify({ pid: process.pid, repo, farm: weDir(), since: new Date().toISOString() }));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = lockOwner(owner);
      const stale = held ? !alive(held.pid) : ageMs(dir) > 10000;
      if (stale) {
        const again = lockOwner(owner);
        if (again ? alive(again.pid) || again.pid !== held?.pid : held || ageMs(dir) <= 10000) continue;
        const gone = `${dir}.stale-${process.pid}-${Date.now()}`;
        try { renameSync(dir, gone); } catch { continue; }
        say(held ? `took over the World Editor lock of ${held.repo} (process ${held.pid} is gone)` : `took over a lock without an owner: ${dir}`);
        rmSync(gone, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`another World Editor run still holds ${dir} (${held ? `process ${held.pid} of ${held.repo}, since ${held.since}` : "no owner yet"})`);
      if (!told) {
        say(`waiting for the World Editor run of ${held ? `${held.repo} (process ${held.pid}, since ${held.since})` : "another session"}: ${dir}`);
        told = Date.now();
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---- proof that the real install and the user's prefix are unchanged ----------------------------------------

const SMALL = 64 * 1024 * 1024;

/** Every file under the roots: size, mtime, ctime, inode, and the sha256 of files under 64 MB. */
export function snapshot(roots) {
  const files = {};
  for (const root of roots) {
    for (const rel of walk(root)) {
      const p = join(root, rel);
      let st;
      try { st = lstatSync(p, { bigint: true }); } catch { continue; }
      const e = { size: Number(st.size), mtime: String(st.mtimeNs), ctime: String(st.ctimeNs), ino: String(st.ino) };
      if (st.size < SMALL) {
        try { e.sha256 = createHash("sha256").update(readFileSync(p)).digest("hex"); } catch (err) { e.sha256 = `unreadable: ${err.code}`; }
      }
      files[p] = e;
    }
  }
  return { taken: new Date().toISOString(), roots, files };
}

/**
 * What differs between two snapshots. `guarded` are the paths that must not change (the install, the editor's
 * preferences): a change there is a failure. Changes elsewhere in the prefix are listed apart: the user's own
 * programs (the Battle.net app, the game) keep writing there while they run, and we-drive mounts the whole prefix
 * read-only for the editor, so those can't come from it.
 */
export function compare(a, b, guarded = []) {
  const changed = [], gone = [], came = [];
  for (const [p, e] of Object.entries(a.files)) {
    const f = b.files[p];
    if (!f) gone.push(p);
    else if (["size", "mtime", "ctime", "ino", "sha256"].some((k) => e[k] !== f[k])) changed.push(p);
  }
  for (const p of Object.keys(b.files)) if (!a.files[p]) came.push(p);
  const isGuarded = (p) => guarded.some((g) => p === g || p.startsWith(`${g}/`));
  const all = [...changed, ...gone, ...came];
  const guardedFiles = Object.keys(a.files).filter(isGuarded).length;
  return { files: Object.keys(a.files).length, guarded, guardedFiles, guardedChanged: all.filter(isGuarded), elsewhereChanged: all.filter((p) => !isGuarded(p)) };
}

/** The paths of the user's that must stay as they are: the install, and the editor's preferences in their prefix. */
export function guardedPaths(game) {
  const user = userCompatData(game);
  return user ? [game, join(user, "pfx", "drive_c", "users", "steamuser", "Documents", "Warcraft III")] : [game];
}

function main(argv) {
  const at = (flag) => argv.indexOf(flag);
  const game = gameDir(at("--game") >= 0 ? argv[at("--game") + 1] : undefined);
  if (at("--clean") >= 0) {
    clean();
    console.log(JSON.stringify({ removed: weDir() }));
    return 0;
  }
  if (at("--snapshot") >= 0) {
    const out = argv[at("--snapshot") + 1];
    if (!out) throw new Error("--snapshot wants a file");
    const roots = [userCompatData(game) ?? game];
    const s = snapshot(roots);
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), JSON.stringify(s));
    console.log(JSON.stringify({ snapshot: resolve(out), roots, files: Object.keys(s.files).length }));
    return 0;
  }
  if (at("--compare") >= 0) {
    const [a, b] = argv.slice(at("--compare") + 1, at("--compare") + 3);
    if (!a || !b) throw new Error("--compare wants two snapshot files");
    const r = compare(JSON.parse(readFileSync(a, "utf8")), JSON.parse(readFileSync(b, "utf8")), guardedPaths(game));
    console.log(JSON.stringify(r, null, 1));
    return r.guardedChanged.length ? 1 : 0;
  }
  console.log(JSON.stringify(setup(game)));
  return 0;
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "we-setup.mjs") {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`we-setup: ${e.message}`);
    process.exit(1);
  }
}
