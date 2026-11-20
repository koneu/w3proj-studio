// Starts the real World Editor for the app's "Open in World Editor" in tests: the program the app runs instead of the
// editor when W3PROJ_WE_LAUNCH names it (app/src-tauri/src/lib.rs `we_launch_hook`; test builds only, a release build
// ignores the variable). The app gives it what it gives the editor (`-launch -loadfile <map>`, the map as a path of this
// machine) and waits on it; it starts World Editor.exe through we-drive's machinery (we-drive.mjs Session: the slot's
// farm and prefix, its own Xvfb display, bubblewrap without network, the game's files read-only, Proton's
// `runinprefix` as the app uses) with the map itself, not a copy (the app watches that file for the editor's saves), and
// exits when the editor exits, with its exit code. LOCAL ONLY (Linux, the game, a set-up slot farm), like we-drive.
//
//   node scripts/we-launch.mjs [options] -- -launch -loadfile <map>
//   node scripts/we-launch.mjs --check [--slot N]     prints {"ok": true, …} or {"skipped": why}, starts nothing
//
// Options:
//   --slot N         the World Editor slot (default W3PROJ_WE_SLOT, else 0); its lock is held for the whole run
//   --work DIR       we-drive's work folder (the editor's log, dialog pictures, what --save copies)
//   --ctl DIR        a folder to be driven through (app-smoke's worldEditorReal): writes started.json (pid, display,
//                    map), ready.json (we-drive's --wait-ready line), exit.json ({code, why}) at the end; runs each
//                    cmd-<n>.json (n = 1, 2, …; {"step": "save" | "close" | "windows" | "kill"}) in order and writes
//                    done-<n>.json with the step's result. Every file is written whole (a rename)
//   --mode sd|hd|de  the editor's graphics (default sd: the cheapest under lavapipe)
//   --timeout S      how long the lock, --wait-ready and a save may take (default 300)
//   --max-minutes M  the editor is closed (else killed) after M minutes at the latest (default 30): nothing stays
//
// It ends the editor (and its prefix's processes and display) when the app is gone (its parent process changed: the
// app exited or was killed), on SIGTERM, SIGINT or SIGHUP; when killed outright, bwrap's --die-with-parent takes
// Proton along. The map's folder must be inside this repository, its main checkout or the temp folder, and neither the
// game folder nor the user's Steam prefix (inPlaceProblem): it's the one folder outside the farm the editor may write.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { lavapipeIcds, parseArgs as driveArgs, protonFor, Session, textLocale, wineserverPath } from "./we-drive.mjs";
import { farmDir, gameDir, missing, parseSlot, repo, setup, takeLock, userCompatData } from "./we-setup.mjs";
import { mainCheckout } from "../../tests/gamepath.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exit codes besides the editor's own. */
export const EXIT = Object.freeze({ failed: 1, refused: 2, skipped: 3, parentGone: 4, signal: 143 });

/**
 * The command line: options, then `--` and the editor's arguments. Of those, only what the app gives the editor is
 * taken (`-launch`, `-loadfile <map>`): anything else is refused, so nothing but a map reaches the editor.
 * Returns { opts, map } (map null when there's no -loadfile).
 */
export function parseLaunchArgs(argv) {
  const opts = { slot: undefined, work: null, ctl: null, mode: "sd", timeout: 300, maxMinutes: 30, check: false };
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv : argv.slice(0, dash), editor = dash < 0 ? [] : argv.slice(dash + 1);
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    const value = () => {
      if (i + 1 >= own.length) throw new Error(`${a} needs a value`);
      return own[++i];
    };
    const number = (name, v) => {
      const n = Number(v);
      if (!/^\d+(\.\d+)?$/.test(v) || !(n > 0)) throw new Error(`${name} wants a positive number, got ${JSON.stringify(v)}`);
      return n;
    };
    if (a === "--slot") opts.slot = parseSlot(value(), "--slot");
    else if (a === "--work") opts.work = resolve(value());
    else if (a === "--ctl") opts.ctl = resolve(value());
    else if (a === "--mode") {
      opts.mode = value();
      if (!["sd", "hd", "de"].includes(opts.mode)) throw new Error(`--mode wants sd, hd or de, not ${JSON.stringify(opts.mode)}`);
    }
    else if (a === "--timeout") opts.timeout = number("--timeout", value());
    else if (a === "--max-minutes") opts.maxMinutes = number("--max-minutes", value());
    else if (a === "--check") opts.check = true;
    else throw new Error(`unknown option ${a} (see the top of we-launch.mjs; the editor's arguments go after --)`);
  }
  let map = null, launch = false;
  for (let i = 0; i < editor.length; i++) {
    const a = editor[i];
    if (a === "-launch" && !launch) launch = true;
    else if (a === "-loadfile" && map === null) {
      if (i + 1 >= editor.length || !editor[i + 1]) throw new Error("-loadfile needs a map");
      map = resolve(editor[++i]);
    } else throw new Error(`the editor's argument ${JSON.stringify(a)} isn't one the app gives it (-launch, -loadfile <map>)`);
  }
  if (!opts.check && !launch) throw new Error("the editor's arguments start with -launch (the app always gives it)");
  return { opts, map };
}

/** The path with symlinks resolved as far as it exists. */
function real(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * Why the editor may not write `map`'s folder, or null: the map must be a .w3x or .w3m file whose folder is strictly
 * inside one of `roots` (this repository, its main checkout, the temp folder) and neither holds nor lies in the game
 * folder or the user's Steam prefix (those stay read-only inside the sandbox in any case).
 */
export function inPlaceProblem(map, { game, roots = [repo, mainCheckout(repo), tmpdir()], exists = existsSync, isFile = (f) => statSync(f).isFile() } = {}) {
  if (!/\.w3[xm]$/i.test(map)) return `${map} isn't a .w3x or .w3m map`;
  if (!exists(map) || !isFile(map)) return `no map file at ${map}`;
  const dir = real(dirname(map));
  const inside = (d, r) => d !== r && d.startsWith(r.endsWith(sep) ? r : r + sep);
  const touches = (d, r) => d === r || inside(d, r) || inside(r, d);
  if (!roots.some((r) => inside(dir, real(r)))) return `${dir} isn't inside the repository, its main checkout or the temp folder: the editor may write only there`;
  for (const guarded of [game, game && userCompatData(game)].filter(Boolean)) {
    if (touches(dir, real(guarded))) return `${dir} and ${guarded} contain one another: the game's files stay read-only`;
  }
  return null;
}

/** What a real run needs that isn't there (we-drive's checks, and the slot's farm set up), or null. */
export function prerequisites(game, { farm = farmDir() } = {}) {
  const why = missing(game);
  if (why) return why;
  if (!existsSync(join(farm, "_retail_", "x86_64", "World Editor.exe"))) return `the slot has no farm (${farm}): run we-drive on that slot once`;
  if (!lavapipeIcds().length) return "no lavapipe Vulkan driver (Debian/Ubuntu: mesa-vulkan-drivers)";
  try {
    const { tool } = protonFor(game);
    if (!wineserverPath(tool)) return `the Proton build ${tool} has no wineserver`;
  } catch (e) { return e.message; }
  return null;
}

/** Writes `value` as JSON into `dir/name` whole: a reader sees the old file or the new one, never half. */
export function writeWhole(dir, name, value) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, join(dir, name));
}

/**
 * Serves one editor until it ends, and returns the exit code. `editor`: { ready(), save(), close(), windows(), kill(),
 * exited() → null | { code, signal } } (we-drive's Session in main, a fake in the tests). Each turn (every `pollMs`):
 * the editor gone ends it with its code (a signal: 1); the parent gone (`parentGone()`) kills the editor (EXIT.parentGone);
 * past `maxMs` the editor is closed, else killed (EXIT.failed); else the next `ctl/cmd-<n>.json` is run.
 */
export async function serve({ editor, ctl = null, parentGone = () => false, maxMs = 30 * 60000, pollMs = 250, clock = { now: Date.now, sleep }, say = () => {} }) {
  const start = clock.now();
  const put = (name, v) => { if (ctl) writeWhole(ctl, name, v); };
  const end = (code, why) => { put("exit.json", { code, why }); say(why); return code; };
  const ready = await editor.ready();
  put("ready.json", ready);
  if (!ready.ready && !editor.exited()) {
    await editor.close().catch(() => {});
    if (!editor.exited()) editor.kill();
    return end(EXIT.failed, `the editor didn't get ready: ${JSON.stringify(ready).slice(0, 300)}`);
  }
  for (let n = 1; ;) {
    const ex = editor.exited();
    if (ex) return end(ex.code ?? EXIT.failed, `the editor exited (${ex.code ?? ex.signal})`);
    if (parentGone()) {
      editor.kill();
      return end(EXIT.parentGone, "the app is gone: the editor was ended");
    }
    if (clock.now() - start > maxMs) {
      const r = await editor.close().catch((e) => ({ closed: false, error: e.message }));
      if (!editor.exited()) editor.kill();
      return end(EXIT.failed, `the editor ran past its ${Math.round(maxMs / 60000)} minutes: ${r.closed ? "closed" : "killed"}`);
    }
    const file = ctl && join(ctl, `cmd-${n}.json`);
    if (file && existsSync(file)) {
      let result;
      try {
        const { step } = JSON.parse(readFileSync(file, "utf8"));
        if (step === "save") result = await editor.save();
        else if (step === "close") result = await editor.close();
        else if (step === "windows") result = editor.windows();
        else if (step === "kill") { editor.kill(); result = { killed: true }; }
        else result = { error: `unknown step ${JSON.stringify(step)} (save, close, windows, kill)` };
      } catch (e) {
        result = { error: e.message, ...(e.crashed ? { crashed: true, dialogs: e.dialogs } : {}) };
      }
      put(`done-${n}.json`, result);
      n++;
      continue;
    }
    await clock.sleep(pollMs);
  }
}

/** The editor of a we-drive Session as serve() takes it; `saved` is where a save's bytes are copied (we-drive's --save). */
export function sessionEditor(s, saved) {
  let exit = null;
  s.editor.once("exit", (code, signal) => { exit = { code, signal }; });
  if (s.editor.spawnError) exit = { code: EXIT.failed, signal: null };
  return {
    ready: () => s.waitReady(),
    save: () => s.save(saved),
    close: () => s.close(),
    windows: () => { const w = s.windows(); const brief = (x) => ({ title: x.title, rect: x.rect }); return { main: w.main && brief(w.main), dialogs: w.dialogs.map(brief), palettes: w.palettes.map(brief) }; },
    kill: () => s.killEditor(),
    // Its exit event, or (closed or killed by the session) its flag: then the event only hasn't come through yet.
    exited: () => exit ?? (s.editorExited ? { code: s.editor.exitCode ?? 0, signal: s.editor.signalCode ?? null } : null),
  };
}

async function main() {
  let parsed;
  try { parsed = parseLaunchArgs(process.argv.slice(2)); } catch (e) {
    console.error(`we-launch: ${e.message}`);
    return EXIT.refused;
  }
  const { opts, map } = parsed;
  // The slot decides the farm, the prefix and the lock together (we-setup slotPaths): set before any of them is read.
  if (opts.slot !== undefined) process.env.W3PROJ_WE_SLOT = String(opts.slot);
  const game = gameDir();
  const why = prerequisites(game);
  if (opts.check) {
    console.log(JSON.stringify(why ? { skipped: why } : { ok: true, game, farm: farmDir() }));
    return 0;
  }
  const put = (name, v) => { if (opts.ctl) writeWhole(opts.ctl, name, v); };
  const refuse = (code, msg) => { console.error(`we-launch: ${msg}`); put("exit.json", { code, why: msg }); return code; };
  if (why) return refuse(EXIT.skipped, `skipped, ${why}`);
  if (!map) return refuse(EXIT.refused, "no -loadfile <map>: the app always gives the map");
  const problem = inPlaceProblem(map, { game });
  if (problem) return refuse(EXIT.refused, problem);
  try { textLocale(readFileSync(join(game, ".build.info"), "utf8")); } catch (e) { return refuse(EXIT.refused, e.message); }

  const parentAtStart = process.ppid;
  const work = opts.work ?? join(repo, "target", "we-launch");
  const { opts: weOpts } = driveArgs(["--work", work, "--timeout", String(opts.timeout), "--mode", opts.mode, ...(opts.slot !== undefined ? ["--slot", String(opts.slot)] : [])]);
  Object.assign(weOpts, { inPlace: true, editorVerb: "runinprefix" });
  const release = await takeLock((m) => console.error(`we-launch: ${m}`), opts.timeout * 1000);
  let s = null;
  const stopAll = () => { try { s?.stop(); } finally { release(); } };
  const onSignal = () => { stopAll(); put("exit.json", { code: EXIT.signal, why: "ended by a signal" }); process.exit(EXIT.signal); };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, onSignal);
  const onFatal = (e) => {
    try { console.error(`we-launch: ${e?.message ?? e}`); } catch { /* stderr gone */ }
    stopAll();
    process.exit(EXIT.failed);
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  try {
    setup(game);
    s = new Session(weOpts, game);
    await s.startDisplay();
    await s.start(map);
    put("started.json", { pid: process.pid, display: s.display, map, log: s.log, slot: opts.slot ?? 0 });
    const editor = sessionEditor(s, join(work, "saved", basename(map)));
    return await serve({ editor, ctl: opts.ctl, parentGone: () => process.ppid !== parentAtStart, maxMs: opts.maxMinutes * 60000, say: (m) => console.error(`we-launch: ${m}`) });
  } catch (e) {
    return refuse(EXIT.failed, e.message);
  } finally {
    stopAll();
  }
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "we-launch.mjs") {
  process.exit(await main());
}
