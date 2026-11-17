// One build per verification round: builds the app (and the release CLI) once from a commit, into
// target/verify/<short-sha>/ of the main checkout (shared by all worktrees), and tells the testers how to run
// app-drive / app-smoke on that binary, each with settings and scratch folders of their own, without building.
//
//   node scripts/verify-build.mjs [--commit REV] [--no-cli] [--tester NAME] [--json] [--force]
//
//   --commit REV    what to build (default HEAD of the checkout this runs in): `git archive` of it, so uncommitted
//                   changes are not in it
//   --no-cli        leave out the release CLI (w3proj; app-smoke needs one: it builds its own when none is given)
//   --tester NAME   print the command lines with NAME's folders (target/verify-runs/<sha>/NAME/…)
//   --json          print one JSON object (commit, exe, cli, env) instead of text
//   --force         build again even when the folder says it is built
//   --keep N        before building, delete the older builds (target/verify/<sha> and target/verify-runs/<sha>) and
//                   keep the newest N (default 2; 0 = keep all). Never deleted: a build with a lock folder, one whose
//                   runs folder changed in the last 2 hours, the commit being built.
//   --dry-run       only print what --keep would delete (and free); delete and build nothing
//
// A folder that is already built (verify.json inside, the binary there) is not built again; two runs at once for
// one commit take turns (the second finds it built). Progress goes to stderr, the answer to stdout.
// Cargo uses the archive's own target/, so sccache (.cargo/config.toml of the main checkout, found from the parent
// folders) is used when it is set up.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./appctl.mjs";
import { mainCheckout } from "../../tests/gamepath.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.platform === "win32" ? ".exe" : "";
const log = (m) => console.error(`verify-build: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where a commit's build lives, and its testers' run folders. */
export function layout(root, sha) {
  const dir = join(root, "target", "verify", sha);
  return { dir, record: join(dir, "verify.json"), exe: join(dir, "target", "debug", `w3proj-studio${EXE}`), cli: join(dir, "target", "release", `w3proj${EXE}`), runs: join(root, "target", "verify-runs", sha) };
}

/** The command lines a tester uses: `built` is the verify.json record, `tester` the folder name of this tester. */
export function testerCommands(built, runs, tester) {
  const base = join(runs, tester);
  const env = { W3_APP_BIN: built.exe, ...(built.cli ? { W3PROJ_BIN: built.cli } : {}) };
  return {
    env,
    appDrive: `node scripts/app-drive.mjs --app "${built.exe}" --work "${join(base, "drive")}" <steps>`,
    appSmoke: `W3_APP_BIN="${built.exe}"${built.cli ? ` W3PROJ_BIN="${built.cli}"` : ""} W3_SMOKE_ID=${built.id}.${tester} W3_SMOKE_DIR="${join(base, "smoke")}" node scripts/app-smoke.mjs --only=<check>`,
    weCompare: `node scripts/we-compare.mjs --app "${built.exe}" --work "${join(base, "we-compare")}" <spec.json>`,
  };
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** git archive of the commit unpacked into `dir` (tar reads the stream; present on Linux, macOS and Windows 10+). */
function extract(rev, dir) {
  mkdirSync(dir, { recursive: true });
  return new Promise((ok, fail) => {
    const a = spawn("git", ["archive", "--format=tar", rev], { cwd: here, stdio: ["ignore", "pipe", "inherit"] });
    const t = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "inherit", "inherit"] });
    a.stdout.pipe(t.stdin);
    let codes = {};
    const done = () => {
      if (codes.a === undefined || codes.t === undefined) return;
      if (codes.a !== 0 || codes.t !== 0) fail(new Error(`git archive / tar failed (${codes.a}, ${codes.t})`));
      else ok();
    };
    a.on("exit", (c) => { codes.a = c; done(); });
    t.on("exit", (c) => { codes.t = c; done(); });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** A lock folder next to the build: one builder per commit; a dead owner's lock is taken over. */
async function lock(dir, timeoutMs = 60 * 60 * 1000) {
  const l = `${dir}.lock`, owner = join(l, "owner.json");
  mkdirSync(dirname(l), { recursive: true });
  const start = Date.now();
  let told = false;
  for (;;) {
    try {
      mkdirSync(l);
      writeFileSync(owner, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
      return () => rmSync(l, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = null;
      try { pid = JSON.parse(readFileSync(owner, "utf8")).pid; } catch { /* just made, or broken */ }
      const old = Date.now() - statSync(l).mtimeMs > 10000;
      if (pid ? !alive(pid) : old) {
        const gone = `${l}.stale-${process.pid}-${Date.now()}`;
        try { renameSync(l, gone); rmSync(gone, { recursive: true, force: true }); log(`took over the lock of a build that is gone: ${l}`); } catch { /* another took it */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`another build of this commit still holds ${l}`);
      if (!told) { log(`waiting for the build another run is making (${l})`); told = true; }
      await sleep(1000);
    }
  }
}

const RECENT_MS = 2 * 60 * 60 * 1000;

/** Newest modification time in a folder tree (depth-limited; a missing folder gives 0). */
function newestMtime(dir, depth = 4) {
  let st;
  try { st = lstatSync(dir); } catch { return 0; }
  let m = st.mtimeMs;
  if (!st.isDirectory() || depth <= 0) return m;
  let names = [];
  try { names = readdirSync(dir); } catch { /* unreadable: its own time */ }
  for (const n of names) m = Math.max(m, newestMtime(join(dir, n), depth - 1));
  return m;
}

function sizeOf(path) {
  let st;
  try { st = lstatSync(path); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  try { for (const f of readdirSync(path)) n += sizeOf(join(path, f)); } catch { /* unreadable */ }
  return n;
}

/** True when `path` is strictly inside `parent`. */
export const inside = (parent, path) => { const r = relative(parent, path); return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };

/**
 * Deletes the older builds: keeps the newest `keep` (keep 0 = everything), plus any build with a lock folder, with a
 * runs folder touched within `recentMs`, or named `current`. Only folders directly in <root>/target/verify and
 * <root>/target/verify-runs are ever removed. Returns { removed: [{sha, bytes}], kept: [sha], freed, dryRun }.
 */
export function pruneBuilds(root, { keep = 2, dryRun = false, now = Date.now(), recentMs = RECENT_MS, current = null, remove = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }) } = {}) {
  const verify = resolve(root, "target", "verify"), runsRoot = resolve(root, "target", "verify-runs");
  const out = { removed: [], kept: [], freed: 0, dryRun };
  if (!(keep > 0) || !existsSync(verify)) return out;
  const builds = readdirSync(verify, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.endsWith(".lock") && !/\.(lock|stale)-/.test(d.name))
    .map((d) => ({ sha: d.name, dir: join(verify, d.name), runs: join(runsRoot, d.name) }))
    .map((b) => ({ ...b, time: Math.max(statSync(b.dir).mtimeMs, newestMtime(join(b.dir, "verify.json"), 0)) }))
    .sort((a, b) => b.time - a.time);
  builds.forEach((b, i) => {
    const busy = existsSync(`${b.dir}.lock`) || now - newestMtime(b.runs) < recentMs || b.sha === current;
    if (i < keep || busy) { out.kept.push(b.sha); return; }
    for (const p of [b.dir, b.runs]) {
      if (!existsSync(p)) continue;
      if (!inside(verify, p) && !inside(runsRoot, p)) throw new Error(`refusing to delete ${p}: not under ${verify} or ${runsRoot}`);
      const bytes = sizeOf(p);
      if (!dryRun) remove(p);
      out.freed += bytes;
      out.removed.push({ sha: b.sha, path: p, bytes });
    }
  });
  return out;
}

function reportPrune(r) {
  const mb = (n) => (n / 1048576).toFixed(0);
  for (const x of r.removed) log(`${r.dryRun ? "would remove" : "removed"} ${x.path} (${mb(x.bytes)} MB)`);
  if (r.removed.length) log(`${r.dryRun ? "would free" : "freed"} ${mb(r.freed)} MB`);
}

const readRecord = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const isBuilt = (rec, want) => rec && existsSync(rec.exe) && (!want.cli || (rec.cli && existsSync(rec.cli)));

export async function verifyBuild({ commit = "HEAD", cli = true, force = false, keep = 2 } = {}) {
  const root = mainCheckout(here);
  const full = git(["rev-parse", "--verify", `${commit}^{commit}`], here);
  const sha = full.slice(0, 10);
  const l = layout(root, sha);
  let rec = readRecord(l.record);
  if (!force && isBuilt(rec, { cli })) return { ...rec, reused: true, runs: l.runs };
  reportPrune(pruneBuilds(root, { keep, current: sha }));
  const release = await lock(l.dir);
  try {
    rec = readRecord(l.record);
    if (!force && isBuilt(rec, { cli })) return { ...rec, reused: true, runs: l.runs };
    const t0 = Date.now();
    const steps = {};
    const time = (name, since) => { steps[name] = Math.round((Date.now() - since) / 1000); log(`${name}: ${steps[name]} s`); };
    // The folder is made again unless a build of an earlier run is there to continue (a half-built one is cheap to continue:
    // cargo and npm keep their work), and the sources are then the commit's again.
    let t = Date.now();
    if (force || !existsSync(join(l.dir, "app", "package.json"))) {
      rmSync(l.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      log(`unpacking ${full} into ${l.dir}`);
      await extract(full, l.dir);
    }
    // .game-path is git-ignored, so the archive lacks it: the tools run from there find the game as the checkout does.
    if (existsSync(join(root, ".game-path"))) copyFileSync(join(root, ".game-path"), join(l.dir, ".game-path"));
    time("archive", t);
    const appDir = join(l.dir, "app");
    t = Date.now();
    const npm = spawnSync("npm ci", { cwd: appDir, shell: true, stdio: ["ignore", process.stderr, process.stderr] });
    if (npm.status !== 0) throw new Error("npm ci failed");
    time("npm ci", t);
    const id = `dev.w3proj.studio.smoke.verify-${sha}`;
    t = Date.now();
    buildApp(id, join(l.dir, "target", "verify-work"), appDir);
    time("app build", t);
    if (!existsSync(l.exe)) throw new Error(`the build left no ${l.exe}`);
    let cliPath = null;
    if (cli) {
      t = Date.now();
      const r = spawnSync("cargo", ["build", "--release", "-p", "w3proj-cli", "--quiet"], { cwd: l.dir, stdio: ["ignore", process.stderr, process.stderr] });
      if (r.status !== 0 || !existsSync(l.cli)) throw new Error("building the w3proj CLI failed");
      cliPath = l.cli;
      time("cli build", t);
    }
    rec = { commit: full, short: sha, id, exe: l.exe, cli: cliPath, builtAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), steps };
    writeFileSync(l.record, JSON.stringify(rec, null, 2));
    return { ...rec, reused: false, runs: l.runs };
  } finally {
    release();
  }
}

function parse(argv) {
  const o = { commit: "HEAD", cli: true, force: false, json: false, keep: 2, dryRun: false, tester: "tester" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--commit") o.commit = value();
    else if (a === "--no-cli") o.cli = false;
    else if (a === "--force") o.force = true;
    else if (a === "--keep") { o.keep = Number(value()); if (!Number.isInteger(o.keep) || o.keep < 0) throw new Error("--keep needs a whole number >= 0"); }
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--json") o.json = true;
    else if (a === "--tester") o.tester = value();
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown argument ${a} (see the top of verify-build.mjs)`);
  }
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) { console.log("usage: node scripts/verify-build.mjs [--commit REV] [--no-cli] [--tester NAME] [--json] [--force] [--keep N] [--dry-run]; see the top of the file"); return 0; }
  if (o.dryRun) { reportPrune(pruneBuilds(mainCheckout(here), { keep: o.keep, dryRun: true })); return 0; }
  const built = await verifyBuild(o);
  const cmds = testerCommands(built, built.runs, o.tester);
  if (o.json) { console.log(JSON.stringify({ ...built, commands: cmds })); return 0; }
  console.log(`${built.reused ? "already built" : `built in ${built.seconds} s`}: ${built.commit}`);
  console.log(`binary: ${built.exe}`);
  if (built.cli) console.log(`cli:    ${built.cli}`);
  console.log(`\nEvery tester picks a name (here "${o.tester}"); its folders hold its settings, webview storage and scratch:\n`);
  console.log(`  app-drive:   ${cmds.appDrive}`);
  console.log(`  app-smoke:   ${cmds.appSmoke}`);
  console.log(`  we-compare:  ${cmds.weCompare}`);
  console.log(`\nSame without flags: W3_APP_BIN=<binary> (app-drive, app-smoke, we-compare), W3PROJ_BIN=<cli>, W3_SMOKE_DIR (app-smoke's folder),\nW3PROJ_CONFIG_DIR (settings folder; default: inside the run's own folder). Nothing is built by them.`);
  return 0;
}

if (process.argv[1] && basename(process.argv[1]) === "verify-build.mjs") {
  try { process.exit(await main()); } catch (e) { console.error(`verify-build: ${e.message}`); process.exit(1); }
}
