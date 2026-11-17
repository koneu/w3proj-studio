// "Do the same in the World Editor and in Studio, save both, diff the saved files", from a spec file.
//
//   node scripts/we-compare.mjs [options] <spec.json>...
//
// Options:
//   --app PATH      a built Studio to use (W3_APP_BIN; verify-build.mjs makes one): nothing is built
//   --work DIR      scratch folder (default: target/we-compare): per spec its input map, the saves and Studio's project
//   --game DIR      the game's folder (default: W3PROJ_GAME, .game-path, or the folder above the checkout)
//   --json FILE     where the JSON report goes (default: <work>/report.json)
//   --limit N       differences listed per file (default: the spec's "limit", else 10)
//   --restart-per-map  the World Editor is closed and started again for each map (the old way, for timing); the default
//                   is one editor per mode, each next map opened in it (we-drive --map on a running editor)
//   --no-we         only Studio's side (its saves are in <work>/<spec>/studio.w3x); reported NOT COMPARED, exit 3
//   --strict-ignore an "ignore" pattern that names no path of either file fails the file (else a warning in the report)
//
// The work folder is locked (<work>/we-compare.lock, the pid): a second run in it stops at once. Spec names are
// folders there: "studio-app", "we-drive", "report.json" and "we-compare.lock" are refused, and two names that differ
// only in case.
//
// A spec file holds one spec or a list. A spec (we-compare-core.mjs `parseSpec` has the full form):
//   name        letters, digits, . _ - (the spec's folder)
//   input       { "map": "path.w3x" } (copied: the original isn't touched; ${MAIN} is the main checkout, ${REPO} this one,
//               a relative path is the spec file's folder's) or { "new": { name, width, height }, "steps": [studio steps] }:
//               Studio makes the map (new_map), runs the steps, packs it, and the World Editor opens that
//               A file from the checkout: `${REPO_WE}` / `${MAIN_WE}` in a "--type" step's text are the checkouts as the
//               editor's file dialogs take them (Z:\… on Linux), `${REPO}` / `${MAIN}` in an "eval" their paths.
//   we          { "mode": "sd|hd|de", "from": "input|studio" (studio: the editor opens the map Studio saved and re-saves it), "saveAccept": ["Warning"] (dialog titles the save answers with Return), "steps": ["--key d", ["--click", "100,100"], ...] }: we-drive steps between the map being
//               ready and the save (the save and the close are added); several specs of one mode share ONE we-drive
//               process, so one display and one lock, and ONE editor: each next map is opened in it (File > Open)
//   studio      { "settings": { key: value }, "steps": [ { "mcp": "tool", "args": {} }, { "eval": "js" }, { "sleep": ms },
//               { "open": "map/war3map.w3e.txt" }, { "terrain": true }, { "setting": [key, value] }, { "command": id } ] }:
//               the project (the input map unpacked, or the new map) is open; afterwards everything is saved and packed
//   compare     files of the map: "war3map.w3i", or { "file": "war3map.wpm", "as": "wpm", "expect": "differs", "tolerance": 0.01 (parsed: numbers this close are equal),
//               "ignore": ["doodads[3].scale", "units[].itemTable"] (parsed: paths whose differences are known and named; [] is any index) }. "as": auto
//               (the codecs' JSON when the unpack makes one, a pathing map by cells, text by lines, else bytes), parsed,
//               text, text-set (the lines as a set, their order ignored), bytes, wpm. "expect": "differs" is for known differences: they don't fail the run; with
//               "expectPaths": ["players[].start", ...] (JSON kinds) every listed path must differ and nothing else may.
//               A file missing from a save, or one that can't be read, is MISSING / ERROR: never the expected difference.
//               "tolerance", "ignore" and "expectPaths" are refused on text, bytes and wpm (they'd do nothing there).
//               "lines": "regex" (text and text-set only) compares only the lines of each save that match it.
//               More kinds (we-compare-w3e.mjs): w3e (war3map.w3e corner by corner), w3e-spread (the set of ground offsets,
//               for random runs), unit-heights (war3mapUnits.doo: id, x, y, z), unit-ids (war3mapUnits.doo: editor ids unique and in order, the kinds of object), doodad-places (war3map.doo: which doodads are left, by the 64 square each stands in), minimap (war3mapMap.blp
//               decoded by the app's lib/image: the mean colour of each 16-pixel square, within "tolerance" per channel). Studio step { "ui": [["tab","Terrain"],
//               ["view","we"], ["tool","Paint:"], ["texture","Lgrs"], ["size",3], ["click",748,500]] } is we-compare-ui.mjs.
//
// Output: a short report on stdout (OK / UNEXPECTED per spec, MATCH / DIFFERS per file with the first differences:
// "doodads[3].angle: WE 4.71, Studio 0", counts of fields and entries) and the same as JSON. Exit 0 when every file is
// as its spec expects, 1 when not (or a file is MISSING), 2 when something couldn't run (a file's ERROR included), 3
// when nothing was compared (--no-we). Local only (the World Editor: see we-drive.mjs).
// Never starts the game; the World Editor is we-drive's, in its sandbox, with its machine-wide lock; the crash dialog is
// never touched (we-drive).

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sleep, until } from "./cdp.mjs";
import { buildApp, ensureCli, mcpCall, repo, smokeId, startApp } from "./appctl.mjs";
import { compareEntry, duplicateName, formatReport, parseSpecFile, runOutcome, weOutcome } from "./we-compare-core.mjs";
import { uiStep } from "./we-compare-ui.mjs";
import { chosenGamePath, gamePath, mainCheckout } from "../../tests/gamepath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const say = (m) => console.error(`we-compare: ${m}`);

export function parseArgs(argv) {
  const o = { work: join(repo, "target", "we-compare"), game: null, json: null, limit: null, we: true, strictIgnore: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--app") process.env.W3_APP_BIN = resolve(value());
    else if (a === "--work") o.work = resolve(value());
    else if (a === "--game") o.game = resolve(value());
    else if (a === "--json") o.json = resolve(value());
    else if (a === "--limit") {
      const v = value();
      if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`--limit is a positive whole number, got ${JSON.stringify(v)}`);
      o.limit = Number(v);
    } else if (a === "--no-we") o.we = false;
    else if (a === "--strict-ignore") o.strictIgnore = true;
    else if (a === "--allow-stale") continue; // read by tests/binfresh.mjs: a binary older than its sources is used anyway
    else if (a === "--keep-prefs") o.keepPrefs = true;
    else if (a === "--restart-per-map") o.restart = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument ${a} (see the top of we-compare.mjs)`);
    else o.files.push(resolve(a));
  }
  return o;
}

// ---------------------------------------------------------------- Studio's side

/**
 * Opens `path` in its editor and waits until that editor is made. `w3.editors.open` resolves once the provider has
 * built it (EditorService.load awaits it), except when the file's tab was already there and still loading (showAgain
 * returns at once): the tab's state is what counts. Replaced a fixed 300 ms pause: measured on 2026-11-17 (Sound Editor,
 * sound-order-move), the rows were all there at the first look after open, and nothing changed in the 300 ms after.
 * An editor that failed to open (its pane shows the error) stops the spec instead of running steps against nothing.
 */
async function openEditor(page, path) {
  const p = JSON.stringify(path);
  await page.evaluate(`w3.editors.open(${p})`);
  const state = await until(`the editor of ${path}`, async () => {
    const s = await page.evaluate(`(() => { const t = w3Workbench.editors.tabs.find((x) => x.path === ${p}); return !t ? "not open" : t.failed ? "failed" : t.loading || !t.instance ? "" : "ready"; })()`);
    return s || false;
  }, 60000);
  if (state !== "ready") throw new Error(`${path}: the editor ${state === "failed" ? "failed to open (its tab shows why)" : "didn't open"}`);
}

/** Runs one Studio step in the page. */
async function studioStep(page, step, ctx) {
  if (step.mcp) await mcpCall(page, step.mcp, step.args ?? {});
  else if (step.eval) await page.evaluate(`(async () => {\n${step.eval}\n})()`, { timeout: 300000 });
  else if (step.sleep !== undefined) await sleep(step.sleep);
  else if (step.open) await openEditor(page, step.open);
  else if (step.setting) await page.evaluate(`w3.settings.set(${JSON.stringify(step.setting[0])}, ${JSON.stringify(step.setting[1])})`);
  else if (step.ui) await uiStep(page, step.ui);
  else if (step.command) await page.evaluate(`w3.commands.execute(${JSON.stringify(step.command)}, ${JSON.stringify(step.args ?? {})})`, { timeout: 300000 });
  else if (step.terrain) {
    // As app-drive's --terrain: the terrain view's handle, the view open, the game's files read.
    await page.evaluate(`(async () => {
      const s = await w3.services.get("w3.terrain");
      if (!window.__compareGroup) window.__compareGroup = s.registerToolGroup({ id: "we-compare", title: "we-compare", order: 999, create: (ed) => { window.__driveEd = ed; return { toolbar: document.createElement("div") }; } });
      window.__driveEd = null;
    })()`);
    await page.evaluate(`w3.editors.open("map/war3map.w3e.txt")`);
    await until("the terrain view", () => page.evaluate(`!!window.__driveEd && !!document.querySelector(".model-stage canvas")`), 120000);
    let quietSince = 0;
    await until("the game's files and the view's layers", async () => {
      const busy = await page.evaluate(`w3Workbench.game.readsPending > 0 || [...document.querySelectorAll("span.muted")].some((e) => !e.hidden && e.textContent === "Working…")`);
      if (busy) { quietSince = 0; return false; }
      quietSince ||= Date.now();
      return Date.now() - quietSince > 1000;
    }, 180000);
  } else throw new Error(`unknown Studio step ${JSON.stringify(step)}`);
}

/** Saves what is open and packs the project into `output`. */
async function packProject(page, output) {
  await page.evaluate(`w3.editors.saveAll()`, { timeout: 120000 });
  await page.evaluate(`w3.commands.execute("w3.terrain.settle").catch(() => {})`).catch(() => {});
  const root = await page.evaluate(`w3.workspace.project()?.root`);
  if (!root) throw new Error("no project is open to pack");
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  await page.evaluate(`w3.backend.invoke("project_pack", { root: ${JSON.stringify(root)}, output: ${JSON.stringify(output)} })`, { timeout: 300000 });
  if (!existsSync(output)) throw new Error(`the pack wrote no ${output}`);
}

/** Studio's side of every spec in one app: writes <dir>/input.w3x (the World Editor's input) and <dir>/studio.w3x. */
async function runStudio(specs, opts, game) {
  const id = smokeId();
  const work = join(opts.work, "studio-app");
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  mkdirSync(work, { recursive: true });
  buildApp(id, work);
  const { page, stop } = await startApp({ id, work, game });
  try {
    await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
    await page.evaluate(`(async () => { const h = w3Workbench.host; await Promise.all(h.extensions.filter((e) => !e.disabled).map((e) => h.activate(e))); })()`);
    for (const spec of specs) {
      const dir = join(opts.work, spec.name);
      const t0 = Date.now();
      // The settings are put back after the spec: the next one starts from the app's.
      const kept = {};
      try {
        await page.evaluate(`(async () => { window.__driveEd = null; await w3.editors.closeAll(); })()`);
        for (const [k, v] of Object.entries(spec.studio.settings)) {
          kept[k] = await page.evaluate(`w3.settings.get(${JSON.stringify(k)})`);
          await page.evaluate(`w3.settings.set(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
        }
        if (spec.input.map) {
          const project = join(dir, "project");
          cpSync(spec.input.map, join(dir, "input.w3x"));
          await page.evaluate(`w3.backend.invoke("project_unpack", { map: ${JSON.stringify(spec.input.map)}, dir: ${JSON.stringify(project)}, allowIncomplete: false, install: ${JSON.stringify(game)} })`, { timeout: 300000 });
          await page.evaluate(`w3.workspace.open(${JSON.stringify(project)})`);
          await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(project)}`));
        } else {
          await mcpCall(page, "new_map", { ...spec.input.new, folder: dir });
          for (const s of spec.input.steps) await studioStep(page, s, spec);
          // The app at rest before the pack (edits flushed, saves and writes ended, the script, pathing, shadows and
          // minimap due written, the terrain view drawn): replaced a fixed 2500 ms pause. Measured on 2026-11-17
          // (new maps with and without input steps): no work started or ran during those 2500 ms, and the packs made
          // after 0 ms, after the pause and after settled() held the same files (only the random ground variations
          // differ, as between any two new maps); settled() took 0.1 to 0.5 s.
          await page.evaluate(`w3Workbench.settled()`, { timeout: 120000 });
          await packProject(page, join(dir, "input.w3x"));
        }
        for (const s of spec.studio.steps) await studioStep(page, s, spec);
        await packProject(page, join(dir, "studio.w3x"));
        say(`${spec.name}: Studio done in ${Math.round((Date.now() - t0) / 1000)} s`);
      } catch (e) {
        spec.error = `Studio: ${e.message}`;
        say(`${spec.name}: ${spec.error}`);
      } finally {
        for (const [k, v] of Object.entries(kept)) await page.evaluate(`w3.settings.set(${JSON.stringify(k)}, ${v === undefined ? "undefined" : JSON.stringify(v)})`).catch(() => {});
      }
    }
  } finally {
    await stop();
  }
}

// ---------------------------------------------------------------- the World Editor's side

/**
 * One we-drive process for `specs` (all of one mode): per spec --map input.w3x, --wait-ready, its steps, --save we.w3x,
 * (--close after the last only). One editor for all maps; the display, the lock and the farm's setup once. A spec whose steps fail
 * stops that process (we-drive stops at a failed step): the specs after it run in the next process.
 */
async function runWorldEditor(specs, opts, game, mode, saveAccept) {
  let rest = specs.filter((s) => !s.error);
  while (rest.length) {
    const args = [join(here, "we-drive.mjs"), "--work", join(opts.work, "we-drive"), "--mode", mode, "--game", game, ...(opts.keepPrefs ? ["--keep-prefs"] : []), ...(saveAccept.length ? ["--save-accept", saveAccept.join(",")] : [])];
    // One editor for all: --map after the first opens the map in the running editor (File > Open; a restart if that
    // fails), the map before it was saved, so nothing is asked. Only the last map is followed by --close.
    // --restart-per-map (opts.restart) is the old way, an editor start per map, for timing the two.
    for (const s of rest) {
      const dir = join(opts.work, s.name);
      args.push("--map", join(dir, s.we.from === "studio" ? "studio.w3x" : "input.w3x"), "--wait-ready", ...s.we.steps.flat(), "--save", join(dir, "we.w3x"));
      if (opts.restart || s === rest.at(-1)) args.push("--close");
    }
    const t0 = Date.now();
    say(`the World Editor on ${rest.length} map${rest.length === 1 ? "" : "s"} (${mode}), one we-drive process`);
    let code, lines;
    try {
      ({ code, lines } = await runLines(process.execPath, args));
    } catch (e) {
      for (const s of rest) s.error = `World Editor: we-drive didn't start: ${e.message}`;
      return;
    }
    const outs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (outs.some((o) => o.skipped)) { for (const s of rest) s.error = `the World Editor can't run here: ${outs.find((o) => o.skipped).skipped}`; return; }
    say(`the World Editor part took ${Math.round((Date.now() - t0) / 1000)} s (exit ${code})`);
    // After a failure the process stopped; the specs behind it that haven't run go again in the next process.
    const { errors, rerun } = weOutcome(rest.length, outs);
    rest.forEach((s, i) => { s.error = errors[i] ?? undefined; });
    rest = rerun.map((i) => rest[i]);
  }
}

/**
 * Runs `command args` with stdout piped: resolves { code, lines } once the process has ended AND its output is drained
 * ("close", not "exit": the last line may still be in the pipe at "exit"), the last line kept without its line break.
 * Rejects when the process can't be started ("error").
 */
export function runLines(command, args, options = {}) {
  return new Promise((ok, fail) => {
    const lines = [];
    let buf = "";
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options });
    } catch (e) { fail(e); return; }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, nl).replace(/\r$/, "")); buf = buf.slice(nl + 1); }
    });
    child.on("error", fail);
    child.on("close", (c, signal) => {
      if (buf) lines.push(buf.replace(/\r$/, ""));
      ok({ code: c ?? (signal ? `signal ${signal}` : null), lines });
    });
  });
}

// ---------------------------------------------------------------- reading and comparing

/** Both maps unpacked with the CLI (its codecs), once; `file(name)` reads one file's forms from an unpacked folder. */
export function reader(cli, game, dir, map) {
  const project = join(dir, `unpacked-${map.replace(/\.w3[xm]$/i, "")}`);
  const mapFile = join(dir, map);
  rmSync(project, { recursive: true, force: true });
  const r = spawnSync(cli, ["unpack", mapFile, project, "--game", game ?? "none", "--allow-incomplete"], { encoding: "utf8", timeout: 600000 });
  if (r.status !== 0) throw new Error(`w3proj unpack ${map}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  const names = new Set(readdirSync(join(project, "map")));
  let listing = null;
  const list = () => {
    if (listing) return listing;
    const l = spawnSync(cli, ["ls", mapFile], { encoding: "utf8", maxBuffer: 1 << 26 });
    if (l.status !== 0) throw new Error(`w3proj ls ${map}: ${String(l.stderr || l.error?.message || "").trim()}`);
    return (listing = l.stdout.split("\n").map((x) => x.trim()));
  };
  return {
    has: (f) => names.has(f) || names.has(`${f}.json`) || names.has(`${f}.txt`),
    unpackedAs: (f) => (names.has(`${f}.json`) ? "json" : names.has(`${f}.txt`) ? "text" : names.has(f) ? "raw" : null),
    json: (f) => JSON.parse(readFileSync(join(project, "map", `${f}.json`), "utf8")),
    text: (f) => readFileSync(join(project, "map", names.has(`${f}.txt`) ? `${f}.txt` : f), "utf8"),
    bytes: (f) => {
      const c = spawnSync(cli, ["cat", mapFile, f], { maxBuffer: 1 << 29 });
      if (c.status !== 0) throw new Error(`w3proj cat ${map} ${f}: ${String(c.stderr).trim()}`);
      return c.stdout;
    },
    listed: (f) => list().some((l) => l.endsWith(` ${f}`) || l === f),
  };
}

/** The app's own image decoder (lib/image, BLP and the rest), bundled into the work folder for the "minimap" kind. */
async function imageDecoder(work) {
  const { build } = await import("esbuild");
  const app = resolve(here, "..");
  const out = join(work, `image-decoder-${process.pid}.mjs`);
  await build({
    stdin: { contents: `export { decodeImage } from "./src/lib/image/index";`, resolveDir: app, loader: "ts" },
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  });
  try {
    return (await import(pathToFileURL(out).href)).decodeImage;
  } finally {
    rmSync(out, { force: true });
  }
}

function compareSpec(spec, cli, game, opts) {
  const dir = join(opts.work, spec.name);
  const limit = opts.limit ?? spec.limit;
  const we = reader(cli, game, dir, "we.w3x"), studio = reader(cli, game, dir, "studio.w3x");
  return spec.compare.map((c) => compareEntry(c, we, studio, { limit, decodeImage: opts.decodeImage }));
}

/**
 * The work folder's lock: two runs in one folder would wipe each other's specs, studio-app and we-drive. Takes
 * <work>/we-compare.lock (this process's pid); one left by a process that is gone is taken over. Returns a release
 * function; throws when a live process holds it.
 */
export function lockWork(work, pid = process.pid) {
  const file = join(work, "we-compare.lock");
  mkdirSync(work, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: "wx" });
      return () => { try { if (readFileSync(file, "utf8").trim() === String(pid)) rmSync(file, { force: true }); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = NaN;
      try { holder = Number(readFileSync(file, "utf8").trim()); } catch { /* removed meanwhile: try again */ }
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new Error(`another we-compare (pid ${holder}) uses ${work}: wait for it, or give this run its own --work`);
      // Taken over by renaming it away, as the gate's lock is: of two runs that both see it stale only one can rename
      // it, and one that took the lock in between isn't swept away (the holder is checked once more before the rename).
      let again = NaN;
      try { again = Number(readFileSync(file, "utf8").trim()); } catch { continue; }
      if (again !== holder && Number.isInteger(again) && again > 0 && alive(again)) continue;
      const gone = `${file}.stale-${process.pid}-${Date.now()}`;
      try { renameSync(file, gone); } catch { continue; }
      rmSync(gone, { force: true });
    }
  }
  throw new Error(`can't take the lock ${file}`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.files.length) {
    console.log("usage: node scripts/we-compare.mjs [options] <spec.json>...; the spec's form and the options are at the top of the file");
    return 0;
  }
  const vars = { MAIN: mainCheckout(repo), REPO: repo };
  const specs = o.files.flatMap((f) => parseSpecFile(readFileSync(f, "utf8"), f, vars));
  const dup = duplicateName(specs);
  if (dup) throw new Error(`two specs are named ${dup} (names are folders: any case)`);
  for (const s of specs) if (s.input.map && !existsSync(s.input.map)) throw new Error(`${s.name}: no input map at ${s.input.map}`);
  const game = o.game ?? chosenGamePath() ?? gamePath(repo);
  const release = lockWork(o.work);
  try {
    return await runSpecs(specs, o, game);
  } finally {
    release();
  }
}

async function runSpecs(specs, o, game) {
  for (const s of specs) rmSync(join(o.work, s.name), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  const cli = ensureCli();
  const t0 = Date.now();
  await runStudio(specs, o, game);
  const tStudio = Date.now();
  if (o.we) {
    // One we-drive process per mode and set of accepted dialogs (both are options of the whole process).
    const key = (s) => `${s.we.mode}|${s.we.saveAccept.join(",")}`;
    for (const k of [...new Set(specs.map(key))]) {
      const group = specs.filter((s) => key(s) === k);
      await runWorldEditor(group, o, game, group[0].we.mode, group[0].we.saveAccept);
    }
  }
  const tWe = Date.now();
  if (specs.some((s) => s.compare.some((c) => c.as === "minimap"))) o.decodeImage = await imageDecoder(o.work);
  const results = [];
  for (const s of specs) {
    const r = { name: s.name, description: s.description, files: [], error: s.error ?? null };
    // --no-we: Studio's side only; nothing was compared, which is never "ok" (runOutcome: exit 3).
    if (!s.error && !o.we) r.notCompared = true;
    if (!s.error && o.we) {
      try { r.files = compareSpec(s, cli, game, o); } catch (e) { r.error = `compare: ${e.message}`; }
    }
    results.push(r);
  }
  const { ok, code, unexpected } = runOutcome(results, { strictIgnore: o.strictIgnore });
  for (const r of results) console.log(formatReport(r, o.limit ?? specs.find((s) => s.name === r.name).limit, { strictIgnore: o.strictIgnore }));
  const seconds = { studio: Math.round((tStudio - t0) / 1000), worldEditor: Math.round((tWe - tStudio) / 1000), compare: Math.round((Date.now() - tWe) / 1000) };
  const json = { specs: results, seconds, ok, ...(o.we ? {} : { notCompared: true }) };
  writeFileSync(o.json ?? join(o.work, "report.json"), JSON.stringify(json, null, 2));
  console.log(`\n${results.length} spec${results.length === 1 ? "" : "s"}, ${o.we ? `${results.filter(unexpected).length} unexpected` : "NOT COMPARED (--no-we)"}; Studio ${seconds.studio} s, World Editor ${seconds.worldEditor} s, compare ${seconds.compare} s; report ${o.json ?? join(o.work, "report.json")}`);
  return code;
}

if (process.argv[1] && basename(process.argv[1]) === "we-compare.mjs") {
  try { process.exit(await main()); } catch (e) { console.error(`we-compare: ${e.message}`); process.exit(2); }
}
