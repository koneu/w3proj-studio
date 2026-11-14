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
//   --no-we         only Studio's side (its saves are in <work>/<spec>/studio.w3x)
//
// A spec file holds one spec or a list. A spec (we-compare-core.mjs `parseSpec` has the full form):
//   name        letters, digits, . _ - (the spec's folder)
//   input       { "map": "path.w3x" } (copied: the original isn't touched; ${MAIN} is the main checkout, ${REPO} this one,
//               a relative path is the spec file's folder's) or { "new": { name, width, height }, "steps": [studio steps] }:
//               Studio makes the map (new_map), runs the steps, packs it, and the World Editor opens that
//   we          { "mode": "sd|hd|de", "from": "input|studio" (studio: the editor opens the map Studio saved and re-saves it), "saveAccept": ["Warning"] (dialog titles the save answers with Return), "steps": ["--key d", ["--click", "100,100"], ...] }: we-drive steps between the map being
//               ready and the save (the save and the close are added); several specs of one mode share ONE we-drive
//               process, so one display and one lock, and ONE editor: each next map is opened in it (File > Open)
//   studio      { "settings": { key: value }, "steps": [ { "mcp": "tool", "args": {} }, { "eval": "js" }, { "sleep": ms },
//               { "open": "map/war3map.w3e.txt" }, { "terrain": true }, { "setting": [key, value] }, { "command": id } ] }:
//               the project (the input map unpacked, or the new map) is open; afterwards everything is saved and packed
//   compare     files of the map: "war3map.w3i", or { "file": "war3map.wpm", "as": "wpm", "expect": "differs", "tolerance": 0.01 (parsed: numbers this close are equal),
//               "ignore": ["doodads[3].scale", "units[].itemTable"] (parsed: paths whose differences are known and named; [] is any index) }. "as": auto
//               (the codecs' JSON when the unpack makes one, a pathing map by cells, text by lines, else bytes), parsed,
//               text, bytes, wpm. "expect": "differs" is for known differences: they don't fail the run.
//               More kinds (we-compare-w3e.mjs): w3e (war3map.w3e corner by corner), w3e-spread (the set of ground offsets,
//               for random runs), unit-heights (war3mapUnits.doo: id, x, y, z), unit-ids (war3mapUnits.doo: editor ids unique and in order, the kinds of object). Studio step { "ui": [["tab","Terrain"],
//               ["view","we"], ["tool","Paint:"], ["texture","Lgrs"], ["size",3], ["click",748,500]] } is we-compare-ui.mjs.
//
// Output: a short report on stdout (OK / UNEXPECTED per spec, MATCH / DIFFERS per file with the first differences:
// "doodads[3].angle: WE 4.71, Studio 0", counts of fields and entries) and the same as JSON. Exit 0 when every file is
// as its spec expects, 1 when not, 2 when something couldn't run. Local only (the World Editor: see we-drive.mjs).
// Never starts the game; the World Editor is we-drive's, in its sandbox, with its machine-wide lock; the crash dialog is
// never touched (we-drive).

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, until } from "./cdp.mjs";
import { buildApp, ensureCli, mcpCall, repo, smokeId, startApp } from "./appctl.mjs";
import { asExpected, autoKind, compareFile, formatReport, parseSpecFile } from "./we-compare-core.mjs";
import { unitHeights, unitIds, w3eView } from "./we-compare-w3e.mjs";
import { uiStep } from "./we-compare-ui.mjs";
import { chosenGamePath, gamePath, mainCheckout } from "../../tests/gamepath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const say = (m) => console.error(`we-compare: ${m}`);

function parseArgs(argv) {
  const o = { work: join(repo, "target", "we-compare"), game: null, json: null, limit: null, we: true, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--app") process.env.W3_APP_BIN = resolve(value());
    else if (a === "--work") o.work = resolve(value());
    else if (a === "--game") o.game = resolve(value());
    else if (a === "--json") o.json = resolve(value());
    else if (a === "--limit") o.limit = Number(value());
    else if (a === "--no-we") o.we = false;
    else if (a === "--restart-per-map") o.restart = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument ${a} (see the top of we-compare.mjs)`);
    else o.files.push(resolve(a));
  }
  return o;
}

// ---------------------------------------------------------------- Studio's side

/** Runs one Studio step in the page. */
async function studioStep(page, step, ctx) {
  if (step.mcp) await mcpCall(page, step.mcp, step.args ?? {});
  else if (step.eval) await page.evaluate(`(async () => {\n${step.eval}\n})()`, { timeout: 300000 });
  else if (step.sleep !== undefined) await sleep(step.sleep);
  else if (step.open) { await page.evaluate(`w3.editors.open(${JSON.stringify(step.open)})`); await sleep(300); }
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
          await sleep(2500);
          await packProject(page, join(dir, "input.w3x"));
        }
        for (const s of spec.studio.steps) await studioStep(page, s, spec);
        await packProject(page, join(dir, "studio.w3x"));
        say(`${spec.name}: Studio done in ${Math.round((Date.now() - t0) / 1000)} s`);
      } catch (e) {
        spec.error = `Studio: ${e.message}`;
        say(`${spec.name}: ${spec.error}`);
      } finally {
        for (const [k, v] of Object.entries(kept)) await page.evaluate(`w3.settings.set(${JSON.stringify(k)}, ${JSON.stringify(v ?? null)})`).catch(() => {});
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
    const args = [join(here, "we-drive.mjs"), "--work", join(opts.work, "we-drive"), "--mode", mode, "--game", game, ...(saveAccept.length ? ["--save-accept", saveAccept.join(",")] : [])];
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
    const lines = [];
    const code = await new Promise((ok) => {
      const child = spawn("node", args, { stdio: ["ignore", "pipe", "inherit"] });
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      });
      child.on("exit", (c) => ok(c));
    });
    const outs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (outs.some((o) => o.skipped)) { for (const s of rest) s.error = `the World Editor can't run here: ${outs.find((o) => o.skipped).skipped}`; return; }
    // Which spec each line belongs to: the --map lines start one.
    let at = -1;
    const state = rest.map(() => ({ saved: false, closed: false, failure: null }));
    for (const o of outs) {
      if (o.step === "--map" && !o.error) { at++; continue; }
      const i = Math.max(at, 0);
      if (o.error || o.crashed) state[o.step === "--map" ? Math.min(at + 1, rest.length - 1) : i].failure = o.error ?? "the World Editor crashed";
      else if (o.step === "--save") { if (o.saved) state[i].saved = true; else state[i].failure = `the save didn't finish: ${JSON.stringify(o.dialogs ?? o.timeout ?? "")}`; }
      else if (o.step === "--wait-ready" && o.ready === false) state[i].failure = `the map wasn't shown: ${JSON.stringify(o.dialogs ?? o.reason ?? "")}`;
    }
    say(`the World Editor part took ${Math.round((Date.now() - t0) / 1000)} s (exit ${code})`);
    let next = rest.length;
    rest.forEach((s, i) => {
      if (state[i].failure) { s.error = `World Editor: ${state[i].failure}`; next = Math.min(next, i + 1); }
      else if (!state[i].saved) { s.error = "World Editor: no save (the run stopped before it)"; next = Math.min(next, i + 1); }
    });
    // After a failure at spec i the process stopped; the specs behind it haven't run: they go again, without it.
    const failedAt = rest.findIndex((s, i) => state[i].failure || !state[i].saved);
    rest = failedAt < 0 ? [] : rest.slice(failedAt + 1).map((s) => { s.error = undefined; return s; }).filter((s) => !existsSync(join(opts.work, s.name, "we.w3x")) || true);
    if (code === 0) rest = [];
  }
}

// ---------------------------------------------------------------- reading and comparing

/** Both maps unpacked with the CLI (its codecs), once; `file(name)` reads one file's forms from an unpacked folder. */
function reader(cli, game, dir, map) {
  const project = join(dir, `unpacked-${map.replace(/\.w3[xm]$/i, "")}`);
  const mapFile = join(dir, map);
  rmSync(project, { recursive: true, force: true });
  const r = spawnSync(cli, ["unpack", mapFile, project, "--game", game ?? "none", "--allow-incomplete"], { encoding: "utf8", timeout: 600000 });
  if (r.status !== 0) throw new Error(`w3proj unpack ${map}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  const names = new Set(readdirSync(join(project, "map")));
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
    listed: (f) => spawnSync(cli, ["ls", mapFile], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout.split("\n").some((l) => l.trim().endsWith(` ${f}`) || l.trim() === f),
  };
}

function compareSpec(spec, cli, game, opts) {
  const dir = join(opts.work, spec.name);
  const limit = opts.limit ?? spec.limit;
  const files = [];
  const we = reader(cli, game, dir, "we.w3x"), studio = reader(cli, game, dir, "studio.w3x");
  for (const c of spec.compare) {
    let kind = c.as;
    if (kind === "auto") kind = autoKind(c.file, we.unpackedAs(c.file) === "json" && studio.unpackedAs(c.file) === "json" ? "json" : we.unpackedAs(c.file) ?? studio.unpackedAs(c.file));
    const load = (r) => {
      if (!r.listed(c.file) && !r.has(c.file)) return null;
      if (kind === "w3e" || kind === "w3e-spread" || kind === "w3e-variation") return { json: w3eView(kind, r.bytes(c.file)) };
      if (kind === "unit-heights") return r.unpackedAs(c.file) === "json" ? { json: unitHeights(r.json(c.file)) } : null;
      if (kind === "unit-ids") return r.unpackedAs(c.file) === "json" ? { json: unitIds(r.json(c.file)) } : null;
      if (kind === "parsed") return r.unpackedAs(c.file) === "json" ? { json: r.json(c.file) } : null;
      if (kind === "text") return { text: r.text(c.file) };
      return { bytes: r.bytes(c.file) };
    };
    let a, b;
    try { a = load(we); b = load(studio); } catch (e) { files.push({ file: c.file, kind, expect: c.expect, status: "DIFFERS", count: 1, diffs: [{ text: e.message }] }); continue; }
    files.push({ expect: c.expect, ...compareFile(c.file, kind, a, b, limit, c.tolerance, c.ignore) });
  }
  return files;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.files.length) {
    console.log("usage: node scripts/we-compare.mjs [options] <spec.json>...; the spec's form and the options are at the top of the file");
    return 0;
  }
  const vars = { MAIN: mainCheckout(repo), REPO: repo };
  const specs = o.files.flatMap((f) => parseSpecFile(readFileSync(f, "utf8"), f, vars));
  const dup = specs.map((s) => s.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) throw new Error(`two specs are named ${dup[0]}`);
  for (const s of specs) if (s.input.map && !existsSync(s.input.map)) throw new Error(`${s.name}: no input map at ${s.input.map}`);
  const game = o.game ?? chosenGamePath() ?? gamePath(repo);
  mkdirSync(o.work, { recursive: true });
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
  const results = [];
  for (const s of specs) {
    const r = { name: s.name, description: s.description, files: [], error: s.error ?? null };
    if (!s.error && o.we) {
      try { r.files = compareSpec(s, cli, game, o); } catch (e) { r.error = `compare: ${e.message}`; }
    }
    results.push(r);
  }
  const unexpected = (r) => r.error || r.files.some((f) => !asExpected(f));
  for (const r of results) console.log(formatReport(r, o.limit ?? specs.find((s) => s.name === r.name).limit));
  const seconds = { studio: Math.round((tStudio - t0) / 1000), worldEditor: Math.round((tWe - tStudio) / 1000), compare: Math.round((Date.now() - tWe) / 1000) };
  const json = { specs: results, seconds, ok: !results.some(unexpected) };
  writeFileSync(o.json ?? join(o.work, "report.json"), JSON.stringify(json, null, 2));
  console.log(`\n${results.length} spec${results.length === 1 ? "" : "s"}, ${results.filter(unexpected).length} unexpected; Studio ${seconds.studio} s, World Editor ${seconds.worldEditor} s, compare ${seconds.compare} s; report ${o.json ?? join(o.work, "report.json")}`);
  if (results.some((r) => r.error)) return 2;
  return json.ok ? 0 : 1;
}

if (process.argv[1] && basename(process.argv[1]) === "we-compare.mjs") {
  try { process.exit(await main()); } catch (e) { console.error(`we-compare: ${e.message}`); process.exit(2); }
}
