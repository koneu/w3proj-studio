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
//   (the lock is not in here: see lockPath, one per slot, user and machine)
//
// Slots (several editors at once): slot 0 is the folder above; slot N > 0 has a folder of its own with the same
// contents, target/we-slotN of the main checkout (W3PROJ_WE_DIR/slotN when that is set), and a lock of its own
// (slotPaths derives both). The slot is W3PROJ_WE_SLOT, or --slot N of this script, we-drive and we-compare.
//
//   node scripts/we-setup.mjs [--slot N] [--game DIR]     set up (idempotent)
//   node scripts/we-setup.mjs --clean          remove the farm, the prefix and the rest
//   node scripts/we-setup.mjs --snapshot FILE  write a list of the user's Steam prefix's files (the install is in it):
//                                              size, mtime, ctime, inode, and the sha256 of files under 64 MB
//   node scripts/we-setup.mjs --compare A B    compare two snapshots; exit 1 if a file of the install or of the
//                                              editor's preferences (Documents/Warcraft III) changed, came or went,
//                                              or when the snapshots hold no such file at all (they prove nothing).
//                                              Other changes in the prefix are listed (the user's running Battle.net
//                                              app writes there; the editor can't, its sandbox has the prefix read-only)
//
// The game folder: --game, else W3PROJ_GAME / .game-path (tests/gamepath.mjs). The farm has to be on the install's
// file system (hardlinks); if it isn't, setting up fails rather than copying 34 GB.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chosenGamePath, gamePath, mainCheckout } from "../../tests/gamepath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, "..", "..");

// ---- slots: several World Editors at once, each with a farm, a prefix and a lock of its own ----------------------

/** The highest slot number (slots are 0..MAX_SLOT). */
export const MAX_SLOT = 31;

/** A slot number from its text ("0".."31"); anything else is refused. */
export function parseSlot(v, what = "slot") {
  const s = String(v ?? "");
  if (!/^(0|[1-9][0-9]?)$/.test(s) || Number(s) > MAX_SLOT) throw new Error(`${what} is a whole number 0 to ${MAX_SLOT}, got ${JSON.stringify(v)}`);
  return Number(s);
}

/** This process's slot: W3PROJ_WE_SLOT (we-drive's and we-compare's --slot set it), else 0. */
export const currentSlot = (env = process.env) => (env.W3PROJ_WE_SLOT === undefined || env.W3PROJ_WE_SLOT === "" ? 0 : parseSlot(env.W3PROJ_WE_SLOT, "W3PROJ_WE_SLOT"));

function userName() {
  try { return userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_"); } catch { return "user"; }
}

/**
 * A slot's folder and lock, derived together (so a farm can't be paired with another slot's lock). Slot 0 is the one
 * there always was: W3PROJ_WE_DIR, else target/we of the main checkout, and the lock $XDG_RUNTIME_DIR/w3proj-we.lock
 * (else the temp dir with the user name; W3PROJ_WE_LOCK overrides it). Slot N > 0: target/we-slotN of the main
 * checkout, or W3PROJ_WE_DIR/slotN, and the lock with "-slotN" added (w3proj-we-slotN.lock, W3PROJ_WE_LOCK-slotN).
 * `env`, `main`, `tmp` and `user` are parameters for the tests.
 */
export function slotPaths(slot, { env = process.env, main = mainCheckout(repo), tmp = tmpdir(), user = userName() } = {}) {
  const n = parseSlot(slot);
  const tag = n === 0 ? "" : `-slot${n}`;
  const base = env.W3PROJ_WE_DIR ? resolve(env.W3PROJ_WE_DIR) : null;
  const dir = n === 0 ? base ?? resolve(main, "target", "we") : base ? join(base, `slot${n}`) : resolve(main, "target", `we${tag}`);
  let lock;
  if (env.W3PROJ_WE_LOCK) lock = `${resolve(env.W3PROJ_WE_LOCK)}${tag}`;
  else if (env.XDG_RUNTIME_DIR && existsSync(env.XDG_RUNTIME_DIR)) lock = join(env.XDG_RUNTIME_DIR, `w3proj-we${tag}.lock`);
  else lock = join(tmp, `w3proj-we-${user}${tag}.lock`);
  return { slot: n, dir, lock };
}

export const weDir = () => slotPaths(currentSlot()).dir;
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
    // On POSIX a backslash is a file-name character (Wine prefixes have such names): the relative path stays as is.
    else if (e.isFile()) yield sep === "\\" ? relative(base, p).split("\\").join("/") : relative(base, p);
  }
}

/** The path with symlinks resolved as far as it exists (the rest is appended as written). */
function realish(p) {
  const rest = [];
  let cur = resolve(p);
  for (;;) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch { /* not there (yet) */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.push(basename(cur));
    cur = up;
  }
}

/**
 * The farm's folder, once it is safe to build in and delete from: strictly inside this repository or the main
 * checkout (W3PROJ_WE_DIR="" or a stray value must never point `--clean` at the cwd or a home folder), and neither
 * holding the game folder nor inside it (walking the game would then walk the farm).
 */
export function guardedWeDir(game) {
  const dir = realish(weDir());
  const inside = (d, r) => d !== r && d.startsWith(r.endsWith(sep) ? r : r + sep);
  if (![repo, mainCheckout(repo)].some((r) => inside(dir, realish(r)))) throw new Error(`W3PROJ_WE_DIR ${dir} isn't inside the repository (${repo}) or the main checkout: refusing to build or delete there`);
  const g = realish(game);
  if (dir === g || inside(dir, g) || inside(g, dir)) throw new Error(`W3PROJ_WE_DIR ${dir} and the game folder ${g} contain one another: refusing`);
  return weDir();
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
  // A name of its own per process: two setups at once must not write the same file.
  const tmp = `${out}.tmp-${process.pid}`;
  try {
    execFileSync("cc", ["-shared", "-fPIC", "-O2", "-o", tmp, src, "-ldl"], { stdio: ["ignore", "inherit", "inherit"] });
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

function place(game, rel, farm = farmDir()) {
  const src = join(game, rel), dst = join(farm, rel);
  mkdirSync(dirname(dst), { recursive: true });
  if (isCopied(rel)) {
    copyFileSync(src, dst);
    return statSync(src).size;
  }
  try { linkSync(src, dst); } catch (e) { throw new Error(`can't hardlink ${rel} (${e.code}): the farm (${farm}) must be on the install's file system`); }
  return 0;
}

/**
 * Whether the farm's file for `rel` is as it should be, stat only: a hardlink is the install's own file (same device
 * and inode: a replaced install file leaves a stale link behind); a copy exists, isn't empty when the original isn't,
 * and a CASC index has the original's size (the editor changes shmem and ecache legitimately, so those only have to exist).
 */
function intact(game, rel, farm) {
  let f;
  try { f = lstatSync(join(farm, rel), { bigint: true }); } catch { return false; }
  const o = statSync(join(game, rel), { bigint: true });
  if (!isCopied(rel)) return f.dev === o.dev && f.ino === o.ino;
  if (f.size === 0n && o.size !== 0n) return false;
  return !/\.idx$/.test(rel) || f.size === o.size;
}

/** The run that holds the World Editor lock on this farm, if it isn't this process or its parent holding it for it
 *  (heldByParent): its farm must stay as it is. */
function busyHolder() {
  const o = lockOwner(join(lockPath(), "owner.json"));
  return o && o.pid !== process.pid && !heldByParent(o) && alive(o.pid) && o.farm && resolve(o.farm) === weDir() ? o : null;
}

/**
 * Sets up the farm, the prefix folder and the shim. The farm is made again only for another game build; for the same
 * build every file is checked by stat and a missing, stale or damaged one is placed again.
 *
 * For we-drive: take the World Editor lock (takeLock) BEFORE calling this, so no other run is using the farm while
 * it is checked. Meanwhile setup() refuses to replace a farm whose lock another live process holds (it then only
 * places files that are missing), builds a new farm in a folder of its own and moves it into place with a rename, so
 * two setups at once can't leave a half-built farm: the one that loses the rename uses the winner's.
 */
export function setup(game, { farmOnly = false } = {}) {
  // farmOnly (tests): just the farm, without the tools and the shim a run needs.
  if (!farmOnly) {
    const why = missing(game);
    if (why) throw new Error(why);
  }
  guardedWeDir(game);
  const build = readFileSync(join(game, ".build.info"), "utf8");
  const shim = farmOnly ? false : buildShim();
  mkdirSync(prefixDir(), { recursive: true });
  const farm = farmDir();
  const sameBuild = () => existsSync(stampPath()) && readFileSync(stampPath(), "utf8") === build && existsSync(farm);
  if (sameBuild()) {
    const busy = busyHolder();
    let fixed = 0;
    for (const rel of walk(game)) {
      if (intact(game, rel, farm)) continue;
      // A running editor has the files open: only what is missing is placed then, nothing is replaced.
      if (busy && existsSync(join(farm, rel))) continue;
      rmSync(join(farm, rel), { force: true });
      place(game, rel);
      fixed++;
    }
    return { dir: weDir(), reused: true, fixed, shimBuilt: shim };
  }
  const busy = busyHolder();
  if (busy && existsSync(farm)) throw new Error(`the farm ${farm} is in use by process ${busy.pid} of ${busy.repo}: not replacing it`);
  const fresh = `${farm}.new-${process.pid}`;
  rmSync(fresh, { recursive: true, force: true });
  let linked = 0, copied = 0, bytes = 0;
  try {
    for (const rel of walk(game)) {
      const n = place(game, rel, fresh);
      if (isCopied(rel)) { copied++; bytes += n; } else linked++;
    }
    const old = `${farm}.old-${process.pid}`;
    if (existsSync(farm)) {
      rmSync(stampPath(), { force: true });
      try { renameSync(farm, old); } catch { /* another setup moved it first */ }
    }
    try {
      renameSync(fresh, farm);
    } catch (e) {
      if (!existsSync(farm)) throw e;
      return { dir: weDir(), reused: true, fixed: 0, shimBuilt: shim }; // another setup was first: its farm stands
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
    writeFileSync(stampPath(), build);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
  return { dir: weDir(), reused: false, linked, copied, copiedMB: Math.round(bytes / 1e5) / 10, shimBuilt: shim };
}

/** Removes the farm, the prefix, the shim and the stamp; nothing else, and only inside a folder `guardedWeDir` accepts. */
export function clean(game) {
  const dir = guardedWeDir(game);
  const busy = busyHolder();
  if (busy) throw new Error(`the farm ${dir} is in use by process ${busy.pid} of ${busy.repo}: not removing it`);
  const allowed = new Set(["install", "prefix", "we-rofs.so", "build.info"]);
  for (const p of [farmDir(), prefixDir(), shimPath(), stampPath()]) {
    if (dirname(p) !== dir || !allowed.has(basename(p))) throw new Error(`refusing to remove ${p}`);
    rmSync(p, { recursive: true, force: true });
  }
}

// ---- the lock: one World Editor in a slot's prefix at a time --------------------------------------------------

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
 * The lock folder of this process's slot (slotPaths): one per slot, user and machine, shared by every worktree and
 * every W3PROJ_WE_DIR. Slot 0's is the one lock there always was. W3PROJ_WE_LOCK overrides it (tests).
 */
export const lockPath = (slot = currentSlot()) => slotPaths(slot).lock;

/**
 * Whether the lock's owner `o` is this process's parent, which took the slot's lock for it and said so in
 * W3PROJ_WE_LOCK_HOLDER (we-compare holds a slot for a whole run and starts we-drive under it): the same slot and farm,
 * the parent's pid, alive. `ppid` and `env` are parameters for the tests.
 */
export function heldByParent(o, slot = currentSlot(), { env = process.env, ppid = process.ppid } = {}) {
  const holder = /^[1-9][0-9]*$/.test(env.W3PROJ_WE_LOCK_HOLDER ?? "") ? Number(env.W3PROJ_WE_LOCK_HOLDER) : null;
  return !!o && holder !== null && o.pid === holder && o.pid === ppid && (o.slot ?? 0) === slot && !!o.farm && resolve(o.farm) === slotPaths(slot, { env }).dir && alive(o.pid);
}

/** Whether `slot`'s lock is held by a live process (none, or a dead owner, is free). */
export function slotBusy(slot) {
  const dir = lockPath(slot);
  if (!existsSync(dir)) return false;
  const o = lockOwner(join(dir, "owner.json"));
  return o ? alive(o.pid) : ageMs(dir) <= 10000;
}

/**
 * Takes the lock folder of `slot` (default this process's; as the gate's coverage lock: a folder with the owner's
 * process in it, taken over when that process is gone). Waits while another run holds it, saying so once (who, since
 * when); gives up after `timeoutMs`; with `wait: false` returns null at once instead of waiting. A lock this
 * process's parent holds for it (heldByParent) is used as it is: the release is then a no-op. Returns a function that
 * lets it go.
 */
export async function takeLock(say, timeoutMs = 30 * 60 * 1000, { beforeRename = () => {}, slot = currentSlot(), wait = true } = {}) {
  const dir = lockPath(slot), owner = join(dir, "owner.json");
  const farm = slotPaths(slot).dir;
  mkdirSync(dirname(dir), { recursive: true });
  const start = Date.now();
  let told = 0;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, JSON.stringify({ pid: process.pid, repo, slot, farm, since: new Date().toISOString() }));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = lockOwner(owner);
      if (heldByParent(held, slot)) return () => {};
      const stale = held ? !alive(held.pid) : ageMs(dir) > 10000;
      if (stale) {
        const again = lockOwner(owner);
        if (again ? alive(again.pid) || again.pid !== held?.pid : held || ageMs(dir) <= 10000) continue;
        // Renamed to a name of this run's own, then read again: when what was moved isn't the stale lock seen above
        // (another run took the lock between the check and the rename), it is put back where it was.
        const gone = `${dir}.stale-${process.pid}-${Date.now()}`;
        beforeRename(dir); // tests: another run takes the lock just here
        try { renameSync(dir, gone); } catch { continue; }
        const moved = lockOwner(join(gone, "owner.json"));
        if (held ? moved?.pid !== held.pid : moved !== null) {
          // A folder at the name now is a third run's: renaming onto it (empty) would take its place, so give up.
          if (existsSync(dir)) {
            rmSync(gone, { recursive: true, force: true });
            throw new Error(`the World Editor lock ${dir} changed hands while it was taken over (process ${moved?.pid ?? "?"}'s lock was moved and can't be put back): stop the other runs and try again`);
          }
          try { renameSync(gone, dir); } catch (e) { rmSync(gone, { recursive: true, force: true }); throw new Error(`the World Editor lock ${dir} changed hands while it was taken over and can't be put back: ${e.message}`); }
          continue;
        }
        say(held ? `took over the World Editor lock of ${held.repo} (process ${held.pid} is gone)` : `took over a lock without an owner: ${dir}`);
        rmSync(gone, { recursive: true, force: true });
        continue;
      }
      if (!wait) return null;
      if (Date.now() - start > timeoutMs) throw new Error(`another World Editor run still holds ${dir} (${held ? `process ${held.pid} of ${held.repo}, since ${held.since}` : "no owner yet"})`);
      if (!told) {
        say(`waiting for the World Editor run of ${held ? `${held.repo} (process ${held.pid}, since ${held.since})` : "another session"}: ${dir}`);
        told = Date.now();
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Takes the first free slot of `slots` (in their order: their locks are tried without waiting) and returns
 * { slot, release }. While every one is busy it waits, trying them all again every `pollMs`, saying so once; gives up
 * after `timeoutMs`. Two runs at once can't both get one slot: each lock is a folder made with mkdir.
 */
export async function takeFreeSlot(slots, say, { timeoutMs = 60 * 60 * 1000, pollMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!slots.length) throw new Error("no slots to take one of");
  const start = Date.now();
  let told = false;
  for (;;) {
    for (const slot of slots) {
      const release = await takeLock(say, 0, { slot, wait: false });
      if (release) return { slot, release };
    }
    if (Date.now() - start > timeoutMs) throw new Error(`every World Editor slot of ${slots.join(",")} is still busy`);
    if (!told) { say(`every World Editor slot of ${slots.join(",")} is busy: waiting for one`); told = true; }
    await sleep(pollMs);
  }
}

/** The slots that can run an editor: 0, and every other whose folder exists (its first start made it) or whose lock
 *  is there (a run that holds it may not have made the folder yet). */
export const existingSlots = (exists = existsSync) => Array.from({ length: MAX_SLOT + 1 }, (_, n) => n).filter((n) => n === 0 || exists(slotPaths(n).dir) || exists(slotPaths(n).lock));

/**
 * Every existing slot's lock, taken in ascending order (waiting for each, `timeoutMs` in all), so that no other World
 * Editor runs meanwhile: for measurements a second editor disturbs (--fps, specs marked serial). The caller must hold
 * no slot lock when it calls this (it waits for all of them; two callers taking them in the same order can't
 * deadlock). Returns a function that lets them all go; on a failure the ones taken are let go.
 */
export async function takeAllSlots(say, { timeoutMs = 60 * 60 * 1000, slots = existingSlots() } = {}) {
  const start = Date.now(), taken = [];
  const releaseAll = () => { for (const r of taken.splice(0).reverse()) r(); };
  try {
    for (const slot of [...slots].sort((a, b) => a - b)) taken.push(await takeLock(say, Math.max(0, timeoutMs - (Date.now() - start)), { slot }));
  } catch (e) {
    releaseAll();
    throw e;
  }
  return releaseAll;
}

// ---- proof that the real install and the user's prefix are unchanged ----------------------------------------

const SMALL = 64 * 1024 * 1024;

/** Every file under the roots: size, mtime, ctime, inode, and the sha256 of files under 64 MB. */
export function snapshot(roots) {
  const files = {}, skipped = [];
  for (const root of roots) {
    for (const rel of walk(root)) {
      const p = join(root, rel);
      let st;
      try { st = lstatSync(p, { bigint: true }); } catch (err) { skipped.push({ path: p, code: err.code }); continue; }
      const e = { size: Number(st.size), mtime: String(st.mtimeNs), ctime: String(st.ctimeNs), ino: String(st.ino) };
      if (st.size < SMALL) {
        try { e.sha256 = createHash("sha256").update(readFileSync(p)).digest("hex"); } catch (err) { e.sha256 = `unreadable: ${err.code}`; }
      }
      files[p] = e;
    }
  }
  return { taken: new Date().toISOString(), roots, files, skipped };
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
  // A file the snapshot couldn't stat is a hole in the proof: guarded ones fail it.
  const skipped = [...(a.skipped ?? []), ...(b.skipped ?? [])].map((s) => s.path);
  const guardedFiles = Object.keys(a.files).filter(isGuarded).length;
  return { files: Object.keys(a.files).length, guarded, guardedFiles, guardedChanged: all.filter(isGuarded), skippedGuarded: skipped.filter(isGuarded), skippedElsewhere: skipped.filter((p) => !isGuarded(p)), elsewhereChanged: all.filter((p) => !isGuarded(p)) };
}

/** --compare's exit code: 1 when a guarded file changed or couldn't be read, and when the snapshots hold no guarded
 *  file at all (taken of another folder, or of a prefix without the install: they prove nothing), else 0. */
export const compareExit = (r) => (r.guardedChanged.length || r.skippedGuarded.length || r.guardedFiles === 0 ? 1 : 0);

/** The paths of the user's that must stay as they are: the install, and the editor's preferences in their prefix. */
export function guardedPaths(game) {
  const user = userCompatData(game);
  return user ? [game, join(user, "pfx", "drive_c", "users", "steamuser", "Documents", "Warcraft III")] : [game];
}

function main(argv) {
  const at = (flag) => argv.indexOf(flag);
  if (at("--slot") >= 0) process.env.W3PROJ_WE_SLOT = String(parseSlot(argv[at("--slot") + 1], "--slot"));
  currentSlot(); // a bad W3PROJ_WE_SLOT is refused before anything is touched
  const game = gameDir(at("--game") >= 0 ? argv[at("--game") + 1] : undefined);
  if (at("--clean") >= 0) {
    clean(game);
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
    return compareExit(r);
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
