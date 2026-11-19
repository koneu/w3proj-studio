// "Do the same in the World Editor and in Studio, save both, diff the saved files", from a spec file.
//
//   node scripts/we-compare.mjs [options] <spec.json>...
//
// Options:
//   --app PATH      a built Studio to use (W3_APP_BIN; verify-build.mjs makes one): nothing is built
//   --work DIR      scratch folder (default: target/we-compare, target/we-compare-slotN on slot N): per spec its input
//                   map, the saves and Studio's project; report.json goes there too, so every run has its own
//   --slot N|auto   the World Editor slot (we-setup.mjs slotPaths: a farm, a prefix and a lock of its own each), held for
//                   the whole run: N waits for that slot, auto takes the first free one of --slots. Without it, slot 0
//                   (or W3PROJ_WE_SLOT) as before, the lock taken by each we-drive process
//   --slots LIST    the slots --slot auto picks from, in order (default 0,1,2)
//   --renderer R    software|gpu|auto (default auto, or W3PROJ_WE_RENDERER): the we-drive renderer. auto: gpu for hd/de specs and
//                   for a full run (the whole tests/we-compare folder or a --shard), else software; a spec's we.renderer
//                   forces its own; software or gpu given here wins over all. No hardware driver: software, one line
//   --frame-cap N   the editor's frames a second (we-drive --frame-cap; 0 = none) for every we-drive process, over a
//                   spec's we.frameCap; without it a spec's we.frameCap, else we-drive's default (10)
//   --shard i/n     run part i of n of the spec files named (whole files, dealt out by their spec counts:
//                   we-compare-core shardFiles); n runs with the same files and --slot auto cover them all, at once
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
//   serial      true: the World Editor part would be disturbed by another editor at the same time (it times something):
//               run last, on slot 0, with every slot's lock held (runSerial)
//   input       { "map": "path.w3x" } (copied: the original isn't touched; ${MAIN} is the main checkout, ${REPO} this one,
//               a relative path is the spec file's folder's) or { "new": { name, width, height }, "steps": [studio steps] }:
//               Studio makes the map (new_map), runs the steps, packs it, and the World Editor opens that
//               A file from the checkout: `${REPO_WE}` / `${MAIN_WE}` in a "--type" step's text are the checkouts as the
//               editor's file dialogs take them (Z:\… on Linux), `${REPO}` / `${MAIN}` in an "eval" their paths.
//   we          { "mode": "sd|hd|de", "from": "input|studio" (studio: the editor opens the map Studio saved and re-saves it), "saveAccept": ["Warning"] (dialog titles the save answers with Return), "save": "plain|shadows" (shadows: File > Calculate Shadows and Save Map, we-drive --save-shadows, instead of Ctrl+S, which keeps the stored war3map.shd), "steps": ["--key d", ["--click", "100,100"], ...] }: we-drive steps between the map being
//               ready and the save (the save and the close are added); several specs of one mode share ONE we-drive
//               process, so one display and one lock, and ONE editor: each next map is opened in it (File > Open).
//               What an earlier spec toggled in that editor stays (Ctrl+Shift+W, a palette pick, a tree's scroll): a
//               step that depends on it is set, not toggled. Num Lock: "--numlock on" (reads the X server's state and
//               presses Num_Lock only when it differs; a blind "--key Num_Lock" depends on the spec before).
//               A module window a spec leaves open (F4's Trigger Editor ignores every close) gets the next spec a new
//               editor (we-drive --map restarts it, "modulesLeft"): an open one changed the next maps' saves.
//               "freshEditor": true  this spec gets an editor of its own: the editor before is closed and a new one
//                 started for it (the preferences written again), so nothing of the specs before it is left.
//               "prefs": { "Misc": { "Enforce Water Limits": "false" } }  keys of WorldEditPreferences.txt written
//                 before each start of its editor (we-drive --pref); specs with other prefs get another we-drive
//                 process. Pinned for every run unless --keep-prefs: Enforce Water Limits, Enforce Camera Boundaries,
//                 Reset Fixed Z When Moving Objects, Show Creep Camps (we-drive PINNED_PREFS).
//               "expectCrash": true  the editor must crash while closing after this spec's save (it is closed right
//                 after it): no crash is the spec's error (close-crash-light-ranges tests that crash)
//   studio      { "settings": { key: value }, "steps": [ { "mcp": "tool", "args": {} }, { "eval": "js" }, { "sleep": ms },
//               { "open": "map/war3map.w3e.txt" }, { "terrain": true }, { "setting": [key, value] }, { "command": id } ] }:
//               the project (the input map unpacked, or the new map) is open; afterwards everything is saved and packed
//   compare     files of the map: "war3map.w3i", or { "file": "war3map.wpm", "as": "wpm", "expect": "differs", "tolerance": 0.01 (parsed: numbers this close are equal),
//               "ignore": ["doodads[3].scale", "units[].itemTable"] (parsed: paths whose differences are known and named; [] is any index) }. "as": auto
//               (the codecs' JSON when the unpack makes one, a pathing map by cells, text by lines, else bytes), parsed,
//               text, text-exact (lines split at LF only: a CR is part of its line, so line endings count; the map's own
//               bytes), text-set (the lines as a set, their order ignored), bytes, wpm. "expect": "differs" is for known differences: they don't fail the run; with
//               "expectPaths": ["players[].start", ...] (JSON kinds) every listed path must differ and nothing else may;
//               "expectLines": { "we": [regex, ...], "studio": [regex, ...] } (text-set) the same for lines: each pattern
//               has to match a line only that side's save has, and every line only one side has a pattern of its side;
//               "expectCorners": [{ "box": [x0, y0, x1, y1], "fields": ["texture"], "we": 1, "studio": 0, "delta": 512,
//               "corners": [min, max] }, ...] (w3e) for a difference whose corners change from run to run or cover the
//               whole map: every differing field must be claimed by a rule (the first whose box, fields and values fit;
//               no box is the whole map; we / studio / delta optional), each rule's count of corners in its range.
//               A "differs" without expectPaths passes on any difference, also a World Editor step that missed: refused,
//               on a JSON kind (name the paths) and on text, text-set, text-exact, bytes and wpm alike (compare the file
//               as a JSON kind, as text-set with expectLines, or narrow it with "lines" and expect a match); only the entries and textEntries of
//               tests/we-compare/differs-without-paths.json are let through (that list only shrinks).
//               "tolerance": 0.5, or per path { "doodads[].z": 1, "camera.x": 4, "default": 0 }: the longest pattern
//               that matches a path gives its tolerance, "default" (else 0) every other path.
//               A file of the checkout that a "--type" text or an eval names (${REPO}/target/x/Rabbit.mdx,
//               ${REPO_WE}\tests\…) must exist: a missing one is the spec's ERROR (naming its make-*.mjs), as a missing
//               input map; else both sides would import nothing and match.
//               A file missing from a save, or one that can't be read, is MISSING / ERROR: never the expected difference.
//               A "parsed" file of the World Editor's save that doesn't come back the same from the codecs (w3proj
//               verify) is ERROR: the codecs' JSON of both sides would hide what they lose.
//               "tolerance", "ignore" and "expectPaths" are refused on text, bytes and wpm (they'd do nothing there).
//               "lines": "regex" (text and text-set only) compares only the lines of each save that match it; none
//               matching in a save is ERROR (two empty texts would match). A text kind on a binary file (a NUL in
//               it: a w3e or wpm the unpack left raw) is ERROR too: compare it as bytes, wpm or a JSON kind.
//               More kinds (we-compare-w3e.mjs): w3e-noise (one Noise click: on the step lattice, span, number changed),
//               wpm-cells (war3map.wpm as JSON, cells "x,y": expectPaths can name them), w3e (war3map.w3e corner by corner), w3e-spread (the set of ground offsets,
//               for random runs), unit-heights (war3mapUnits.doo: id, x, y, z), unit-ids (war3mapUnits.doo: editor ids unique and in order, the kinds of object; "minCount": N also whether each save holds N objects or more), doodad-places (war3map.doo: which doodads are left, by the 64 square each stands in), minimap (war3mapMap.blp
//               decoded by the app's lib/image: the mean colour of each 16-pixel square, within "tolerance" per channel). Studio step { "ui": [["tab","Terrain"],
//               ["view","we"], ["tool","Paint:"], ["texture","Lgrs"], ["size",3], ["click",748,500]] } is we-compare-ui.mjs.
//
// A spec whose input map is missing gets an ERROR naming the make-*.mjs that writes it; the other specs still run.
// Between specs Studio is put back: the settings a spec changes (studio.settings, "setting" steps), the w3.window
// functions its evals stub, and the "__" window globals they make. Studio's save must leave no editor unsaved and the
// terrain's rebuild must succeed, else the spec fails. A World Editor crash while closing after the spec's save is a
// warning in the report (the save is whole), not a failure. Every we-drive process runs with --expect-layout: an editor
// whose main window or tool palette isn't where the specs' clicks were measured (4,30 1352x937; the palette at
// 1356,30) fails all its specs with one message instead of clicking beside every button.
//
// Output: a short report on stdout (OK / UNEXPECTED per spec, MATCH / DIFFERS per file with the first differences:
// "doodads[3].angle: WE 4.71, Studio 0", counts of fields and entries) and the same as JSON. Exit 0 when every file is
// as its spec expects, 1 when not (or a file is MISSING), 2 when something couldn't run (a file's ERROR included), 3
// when nothing was compared (--no-we). Local only (the World Editor: see we-drive.mjs).
// Never starts the game; the World Editor is we-drive's, in its sandbox, with its slot's lock; the crash dialog is
// never touched (we-drive).

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sleep, until } from "./cdp.mjs";
import { buildApp, ensureCli, mcpCall, repo, smokeId, startApp } from "./appctl.mjs";
import { applyRoundtrip, chooseFrameCap, chooseRenderer, compareEntry, crashExpectation, duplicateName, formatReport, generatorOf, gpuMissing, isFullRun, parseShard, parseSpecFile, readDiffersAllowlist, runOutcome, settingKeys, shardFiles, verifyOutcome, weDriveSteps, weGroupKey, weOutcome } from "./we-compare-core.mjs";
import { parseFrameCap } from "./we-drive.mjs";
import { currentSlot, parseSlot, takeAllSlots, takeFreeSlot, takeLock } from "./we-setup.mjs";
import { uiStep } from "./we-compare-ui.mjs";
import { chosenGamePath, gamePath, mainCheckout } from "../../tests/gamepath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const say = (m) => console.error(`we-compare: ${m}`);

export function parseArgs(argv) {
  const o = { work: null, game: null, json: null, limit: null, we: true, strictIgnore: false, files: [], renderer: process.env.W3PROJ_WE_RENDERER || "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--app") process.env.W3_APP_BIN = resolve(value());
    else if (a === "--work") o.work = resolve(value());
    else if (a === "--slot") { const v = value(); o.slot = v === "auto" ? "auto" : parseSlot(v, "--slot"); }
    else if (a === "--slots") {
      const v = value();
      o.slots = v.split(",").map((x) => parseSlot(x.trim(), "--slots"));
      if (new Set(o.slots).size !== o.slots.length) throw new Error(`--slots names a slot twice: ${v}`);
    } else if (a === "--shard") o.shard = parseShard(value());
    else if (a === "--game") o.game = resolve(value());
    else if (a === "--json") o.json = resolve(value());
    else if (a === "--limit") {
      const v = value();
      if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`--limit is a positive whole number, got ${JSON.stringify(v)}`);
      o.limit = Number(v);
    } else if (a === "--no-we") o.we = false;
    else if (a === "--strict-ignore") o.strictIgnore = true;
    else if (a === "--allow-stale") continue; // read by tests/binfresh.mjs: a binary older than its sources is used anyway
    else if (a === "--renderer") o.renderer = value();
    else if (a === "--frame-cap") o.frameCap = parseFrameCap(value());
    else if (a === "--keep-prefs") o.keepPrefs = true;
    else if (a === "--restart-per-map") o.restart = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument ${a} (see the top of we-compare.mjs)`);
    else o.files.push(resolve(a));
  }
  if (!["auto", "software", "gpu"].includes(o.renderer)) throw new Error(`--renderer (or W3PROJ_WE_RENDERER) wants software, gpu or auto, not "${o.renderer}"`);
  if (o.slots && o.slot !== "auto") throw new Error("--slots is the list --slot auto takes a free slot of: give --slot auto too");
  if (o.slot === "auto") o.slots ??= DEFAULT_SLOTS;
  return o;
}

/** The slots `--slot auto` takes the first free one of when --slots isn't given. */
export const DEFAULT_SLOTS = Object.freeze([0, 1, 2]);

/** The work folder when --work isn't given: target/we-compare of this checkout for slot 0, target/we-compare-slotN for N,
 *  so two runs on two slots never share one (the work folder's lock would stop the second). */
export const defaultWork = (slot) => join(repo, "target", slot ? `we-compare-slot${slot}` : "we-compare");

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

/**
 * Runs in the page (stringified; the tests call it with fakes): saves every editor, lets the terrain's derived files
 * (pathing, shadows, minimap) be written, and throws when an editor still has unsaved changes after the save (its save
 * failed: the pack would hold the file as it was) or the terrain's rebuild failed.
 */
export async function saveForPack(w3, wb) {
  await w3.editors.saveAll();
  // What the app's own pack does first (map-project prepare): the script due from the last save (the Melee flag
  // follows with it), the destructables' flags, the World Editor's save's string rules (players' and forces' plain
  // names become strings, unused strings go). Without it a spec's last save could reach the pack without them.
  try { await w3.commands.execute("w3.project.preparePack"); } catch (e) { throw new Error(`the pack's preparation failed: ${e?.message ?? e}`); }
  const dirty = wb.editors.tabs.filter((t) => t.dirty).map((t) => t.path);
  if (dirty.length) throw new Error(`the save left unsaved changes in ${dirty.join(", ")} (its save failed)`);
  try { await w3.commands.execute("w3.terrain.settle"); } catch (e) { throw new Error(`the terrain's derived files weren't written: ${e?.message ?? e}`); }
}

/**
 * Runs in the page before a spec (stringified; tested with fakes): what a spec's evals may change that would reach
 * the next spec: the functions of w3.window (a stubbed showWarning or confirm) and the window's "__" globals
 * (window.__prefs, __asked). spec-isolation's restore puts them back.
 */
export function isolateSnapshot(win, w3) {
  win.__weCompareKept = { methods: Object.fromEntries(Object.getOwnPropertyNames(w3.window).map((k) => [k, w3.window[k]])), globals: Object.keys(win).filter((k) => k.startsWith("__")) };
}

/** Runs in the page after a spec: w3.window as isolateSnapshot found it, the "__" globals the spec made deleted (the
 *  runner's own __compareGroup and __driveEd stay). Returns what it put back, for the log. */
export function isolateRestore(win, w3) {
  const kept = win.__weCompareKept;
  if (!kept) return [];
  const changed = [];
  for (const k of Object.getOwnPropertyNames(w3.window)) {
    if (!Object.hasOwn(kept.methods, k)) { delete w3.window[k]; changed.push(`w3.window.${k}`); } else if (w3.window[k] !== kept.methods[k]) { w3.window[k] = kept.methods[k]; changed.push(`w3.window.${k}`); }
  }
  for (const [k, v] of Object.entries(kept.methods)) if (!Object.hasOwn(w3.window, k)) { w3.window[k] = v; changed.push(`w3.window.${k}`); }
  const own = new Set([...kept.globals, "__weCompareKept", "__compareGroup", "__driveEd"]);
  for (const k of Object.keys(win)) if (k.startsWith("__") && !own.has(k)) { delete win[k]; changed.push(`window.${k}`); }
  delete win.__weCompareKept;
  return changed;
}

/** Saves what is open and packs the project into `output`. */
async function packProject(page, output) {
  await page.evaluate(`(${saveForPack})(w3, w3Workbench)`, { timeout: 300000 });
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
      // A spec whose input is missing (main) has its error already: nothing to make.
      if (spec.error) continue;
      const dir = join(opts.work, spec.name);
      const t0 = Date.now();
      // Put back after the spec, so the next one starts from the app's: every setting the spec changes (its
      // studio.settings and its "setting" steps; the user layer as it was, absent included), the functions of
      // w3.window its evals stub, and the window globals they make (isolateSnapshot).
      const kept = {};
      let isolated = false;
      try {
        await page.evaluate(`(async () => { window.__driveEd = null; await w3.editors.closeAll(); })()`);
        await page.evaluate(`(${isolateSnapshot})(window, w3)`);
        isolated = true;
        for (const k of settingKeys(spec)) kept[k] = await page.evaluate(`w3.settings.inspect(${JSON.stringify(k)}).user`);
        for (const [k, v] of Object.entries(spec.studio.settings)) await page.evaluate(`w3.settings.set(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
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
        for (const [k, v] of Object.entries(kept)) {
          await page.evaluate(`w3.settings.set(${JSON.stringify(k)}, ${v === undefined ? "undefined" : JSON.stringify(v)})`).catch((e) => say(`${spec.name}: the setting ${k} wasn't put back: ${e.message}`));
        }
        if (isolated) {
          const back = await page.evaluate(`(${isolateRestore})(window, w3)`).catch((e) => { say(`${spec.name}: the page's state wasn't put back: ${e.message}`); return []; });
          if (back?.length) say(`${spec.name}: put back ${back.join(", ")}`);
        }
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
async function runWorldEditor(specs, opts, game) {
  const { mode, saveAccept, prefs } = specs[0].we;
  let renderer = chooseRenderer({ asked: opts.renderer, specRenderer: specs[0].we.renderer, mode, fullRun: opts.fullRun });
  const auto = opts.renderer === "auto";
  const frameCap = chooseFrameCap({ asked: opts.frameCap ?? null, specCap: specs[0].we.frameCap });
  let rest = specs.filter((s) => !s.error);
  while (rest.length) {
    // --expect-layout: the first --wait-ready on a main window or tool palette of another size or place than the
    // spec coordinates were measured in stops the process with one message (weOutcome gives it to every spec).
    const args = [join(here, "we-drive.mjs"), "--work", join(opts.work, "we-drive"), "--mode", mode, "--game", game, "--expect-layout", ...(opts.keepPrefs ? ["--keep-prefs"] : []), "--renderer", renderer, ...(frameCap !== null ? ["--frame-cap", String(frameCap)] : []), ...(saveAccept.length ? ["--save-accept", saveAccept.join(",")] : []), ...prefs.flatMap((p) => ["--pref", p])];
    // One editor for all: --map after the first opens the map in the running editor (File > Open; a restart if that
    // fails), the map before it was saved, so nothing is asked. --close after the last map, around a spec with
    // we.freshEditor or we.expectCrash (weDriveSteps). --restart-per-map (opts.restart) is the old way, an editor
    // start per map, for timing the two.
    args.push(...weDriveSteps(rest, {
      restart: opts.restart,
      mapOf: (s) => join(opts.work, s.name, s.we.from === "studio" ? "studio.w3x" : "input.w3x"),
      saveOf: (s) => join(opts.work, s.name, "we.w3x"),
    }));
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
    // we-drive's own lines, for a look afterwards (what each step answered, a crash on close).
    try { appendFileSync(join(opts.work, "we-drive", "steps.jsonl"), lines.map((l) => `${l}\n`).join("")); } catch { /* the log is a help only */ }
    // auto asked for gpu and this machine has no hardware driver: software, one line, never a failure.
    const noGpu = auto && renderer === "gpu" ? gpuMissing(outs.find((o) => o.skipped)?.skipped) : null;
    if (noGpu) { say(`no hardware Vulkan driver, using the software renderer (${noGpu})`); renderer = "software"; continue; }
    if (outs.some((o) => o.skipped)) { for (const s of rest) s.error = `the World Editor can't run here: ${outs.find((o) => o.skipped).skipped}`; return; }
    say(`the World Editor part took ${Math.round((Date.now() - t0) / 1000)} s (exit ${code})`);
    // After a failure the process stopped; the specs behind it that haven't run go again in the next process.
    const { errors, rerun, warnings, closes } = weOutcome(rest.length, outs);
    rest.forEach((s, i) => {
      if (rerun.includes(i)) return;
      const { error, warning } = crashExpectation(s.we.expectCrash, closes[i], errors[i] ?? null, warnings[i]);
      s.error = error ?? undefined;
      if (warning) { (s.warnings ??= []).push(warning); say(`${s.name}: ${warning}`); }
    });
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
  const files = spec.compare.map((c) => compareEntry(c, we, studio, { limit, decodeImage: opts.decodeImage }));
  // A parsed compare sees the codecs' JSON of both saves, so what the codecs lose cancels out: the World Editor's save
  // has to come back the same from unpack and pack (w3proj verify, in memory), else that file's result is ERROR.
  if (!files.some((f) => f.kind === "parsed" && f.status !== "ERROR" && f.status !== "MISSING")) return files;
  const v = spawnSync(cli, ["verify", join(dir, "we.w3x"), "--game", game ?? "none", "-q"], { encoding: "utf8", timeout: 600000 });
  const outcome = v.status === 0 ? {} : verifyOutcome(v.stdout);
  if (v.status !== 0 && !outcome.mismatched && !outcome.error) outcome.error = `w3proj verify exited ${v.status ?? v.signal ?? v.error?.message}: ${String(v.stderr || "").trim().split("\n").pop()}`;
  return applyRoundtrip(files, outcome);
}

/**
 * The work folder's lock: two runs in one folder would wipe each other's specs, studio-app and we-drive. Takes
 * <work>/we-compare.lock (this process's pid); one left by a process that is gone is taken over. Returns a release
 * function; throws when a live process holds it.
 */
export function lockWork(work, pid = process.pid, { graceMs = 5000, beforeRename = () => {} } = {}) {
  const file = join(work, "we-compare.lock");
  mkdirSync(work, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: "wx" });
      return () => { try { if (readFileSync(file, "utf8").trim() === String(pid)) rmSync(file, { force: true }); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let seen;
      try { seen = readFileSync(file, "utf8").trim(); } catch { continue; } // removed meanwhile: try again
      const holder = /^[1-9][0-9]*$/.test(seen) ? Number(seen) : null;
      // No pid in it: a run between its create and its write (the "wx" create and the write are two steps), unless
      // the file is older than the grace (a run that died in between).
      if (holder === null && fileAgeMs(file) < graceMs) throw new Error(`another we-compare is taking ${work} (its lock has no pid yet): wait for it, or give this run its own --work`);
      if (holder !== null && alive(holder)) throw new Error(`another we-compare (pid ${holder}) uses ${work}: wait for it, or give this run its own --work`);
      // Taken over by renaming it to a name of this run's own: of two runs that both see it stale only one can rename
      // it. What was moved is read again: when it isn't the stale lock seen above (another run took the lock between
      // the read and the rename), it is put back where it was.
      const gone = `${file}.stale-${pid}-${Date.now()}`;
      beforeRename(file); // tests: another run takes the lock just here
      try { renameSync(file, gone); } catch { continue; }
      let moved = null;
      try { moved = readFileSync(gone, "utf8").trim(); } catch { /* gone meanwhile */ }
      if (moved !== null && moved !== seen) {
        try { linkSync(gone, file); } catch { rmSync(gone, { force: true }); throw new Error(`the lock ${file} changed hands while it was taken over (pid ${moved}'s lock was moved and can't be put back): stop the other run, or give this run its own --work`); }
        rmSync(gone, { force: true });
        continue;
      }
      rmSync(gone, { force: true });
    }
  }
  throw new Error(`can't take the lock ${file}`);
}

function fileAgeMs(path) {
  try { return Date.now() - statSync(path).mtimeMs; } catch { return 0; }
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
  const differsWithoutPaths = readDiffersAllowlist(repo);
  const parsed = o.files.map((file) => ({ file, list: parseSpecFile(readFileSync(file, "utf8"), file, vars, { differsWithoutPaths }) }));
  // --shard i/n: this run's part of the files (whole files, the same split in every run given the same files).
  const files = o.shard ? shardFiles(parsed.map((p) => ({ file: p.file, specs: p.list.length })), o.shard.index, o.shard.count) : o.files;
  if (o.shard) say(`shard ${o.shard.index}/${o.shard.count}: ${files.length} of ${o.files.length} spec files`);
  const specs = parsed.filter((p) => files.includes(p.file)).flatMap((p) => p.list);
  if (!specs.length) { say("no spec to run in this shard"); return 0; }
  // A full run (the whole spec folder, or a shard) takes the GPU renderer under --renderer auto.
  o.fullRun = isFullRun(o.files, readdirSync(join(repo, "tests", "we-compare")).filter((n) => n.endsWith(".json")).map((n) => join(repo, "tests", "we-compare", n)), o.shard);
  const dup = duplicateName(specs);
  if (dup) throw new Error(`two specs are named ${dup} (names are folders: any case)`);
  // A missing input (most are made by a generator into target/) is that spec's error; the others still run.
  for (const s of specs) if (s.input.map && !existsSync(s.input.map)) s.error = missingInput(s.input.map);
  // So is a file of the checkout its "--type" texts or evals pick (an import's model): absent, both sides would import
  // nothing and match.
  for (const s of specs) if (!s.error) { const f = s.files.find((x) => !existsSync(x)); if (f) s.error = missingInput(f, repo, "file"); }
  const game = o.game ?? chosenGamePath() ?? gamePath(repo);
  // The World Editor slot: --slot N waits for that slot, --slot auto takes the first free one of --slots. The run holds
  // the slot's lock throughout (its we-drive processes use it: W3PROJ_WE_LOCK_HOLDER), so no other run gets the slot
  // between them. Without --slot (and no W3PROJ_WE_SLOT) nothing changes: slot 0, and we-drive takes the lock itself.
  o.releaseSlot = o.we && o.slot !== undefined ? await holdSlot(o) : null;
  try {
    // (--no-we --slot auto takes no slot: the default folder is then W3PROJ_WE_SLOT's, else slot 0's.)
    o.work ??= defaultWork(typeof o.slot === "number" ? o.slot : currentSlot());
    const release = lockWork(o.work);
    try {
      return await runSpecs(specs, o, game);
    } finally {
      release();
    }
  } finally {
    o.releaseSlot?.();
  }
}

/** Takes the run's slot (o.slot: a number, or "auto" over o.slots, then replaced by the slot taken) and tells the
 *  we-drive processes this run starts about it. Returns the release. */
export async function holdSlot(o, { take = takeLock, takeFree = takeFreeSlot, env = process.env, pid = process.pid } = {}) {
  let release;
  if (o.slot === "auto") ({ slot: o.slot, release } = await takeFree(o.slots, say));
  else release = await take(say, 60 * 60 * 1000, { slot: o.slot });
  env.W3PROJ_WE_SLOT = String(o.slot);
  env.W3PROJ_WE_LOCK_HOLDER = String(pid);
  say(`World Editor slot ${o.slot}`);
  // Once only: a second call would remove the lock another run has taken since.
  let held = true;
  return () => { if (!held) return; held = false; delete env.W3PROJ_WE_LOCK_HOLDER; release(); };
}

/**
 * The World Editor part of the specs marked "serial": a second editor at the same time could disturb them. The run's
 * own slot is let go first, then every existing slot's lock is taken in ascending order (takeAllSlots: waits until the
 * other runs' editors are done; the same order everywhere, so no two runs wait on each other), and the specs run on
 * slot 0 with all of them held. The locks are let go afterwards; the compare needs none.
 */
export async function runSerial(specs, o, game, { takeAll = takeAllSlots, runGroups = runWorldEditorGroups, env = process.env, pid = process.pid } = {}) {
  o.releaseSlot?.();
  o.releaseSlot = null;
  say(`${specs.length} serial spec${specs.length === 1 ? "" : "s"}: waiting for every World Editor slot, then slot 0 with no other editor`);
  const releaseAll = await takeAll(say);
  const kept = { W3PROJ_WE_SLOT: env.W3PROJ_WE_SLOT, W3PROJ_WE_LOCK_HOLDER: env.W3PROJ_WE_LOCK_HOLDER };
  env.W3PROJ_WE_SLOT = "0";
  env.W3PROJ_WE_LOCK_HOLDER = String(pid);
  try {
    await runGroups(specs, o, game);
  } finally {
    for (const [k, v] of Object.entries(kept)) if (v === undefined) delete env[k]; else env[k] = v;
    releaseAll();
  }
}

/** One we-drive process per mode and set of accepted dialogs (both are options of the whole process). */
async function runWorldEditorGroups(specs, o, game) {
  for (const k of [...new Set(specs.map(weGroupKey))]) await runWorldEditor(specs.filter((s) => weGroupKey(s) === k), o, game);
}

/** The error of a spec whose input map (or another file it names, `what`) isn't there: the generator that makes it
 *  named, when one does. */
export function missingInput(map, repoDir = repo, what = "input map") {
  const dir = join(repoDir, "tests", "fixtures", "we-specs");
  let gens = [];
  try { gens = readdirSync(dir).filter((n) => /^make-.*\.mjs$/.test(n)).map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") })); } catch { /* no generators */ }
  const gen = generatorOf(map, repoDir, gens);
  return `no ${what} at ${map}${gen ? ` (made by node tests/fixtures/we-specs/${gen}: its first lines name the arguments)` : ""}`;
}

async function runSpecs(specs, o, game) {
  for (const s of specs) rmSync(join(o.work, s.name), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  rmSync(join(o.work, "we-drive", "steps.jsonl"), { force: true });
  const cli = ensureCli();
  const t0 = Date.now();
  if (specs.some((s) => !s.error)) await runStudio(specs, o, game);
  const tStudio = Date.now();
  if (o.we) {
    await runWorldEditorGroups(specs.filter((s) => !s.serial), o, game);
    // Serial specs last, alone on slot 0 (runSerial).
    const serial = specs.filter((s) => s.serial && !s.error);
    if (serial.length) {
      try { await runSerial(serial, o, game); } catch (e) { for (const s of serial) s.error ??= `World Editor (serial): ${e.message}`; }
    }
  }
  const tWe = Date.now();
  if (specs.some((s) => s.compare.some((c) => c.as === "minimap"))) o.decodeImage = await imageDecoder(o.work);
  const results = [];
  for (const s of specs) {
    const r = { name: s.name, description: s.description, files: [], error: s.error ?? null, ...(s.warnings ? { warnings: s.warnings } : {}) };
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
  const json = { specs: results, seconds, ok, ...(o.we ? {} : { notCompared: true }), ...(typeof o.slot === "number" ? { slot: o.slot } : {}), ...(o.shard ? { shard: `${o.shard.index}/${o.shard.count}` } : {}) };
  writeFileSync(o.json ?? join(o.work, "report.json"), JSON.stringify(json, null, 2));
  console.log(`\n${results.length} spec${results.length === 1 ? "" : "s"}, ${o.we ? `${results.filter(unexpected).length} unexpected` : "NOT COMPARED (--no-we)"}; Studio ${seconds.studio} s, World Editor ${seconds.worldEditor} s, compare ${seconds.compare} s; report ${o.json ?? join(o.work, "report.json")}`);
  return code;
}

if (process.argv[1] && basename(process.argv[1]) === "we-compare.mjs") {
  try { process.exit(await main()); } catch (e) { console.error(`we-compare: ${e.message}`); process.exit(2); }
}
