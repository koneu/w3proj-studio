// Measures what opening only some subterrains of a split project saves (spec "Working on Part of the Map"), in the real
// app (the hidden smoke build, Xvfb on Linux), on a large split project: per scenario (every subterrain open, one of
// them open) the time from opening the terrain editor to its first frame and to the view at rest, the JS heap (where
// the webview tells it) and the app's resident memory after the load, what the renderer holds (ground quads, water
// triangles, models and instances per group: cliffs, doodads, units), the bytes the app's processes read meanwhile,
// and after a terrain edit the save's time and the derived files' rebuild (pathing, shadows, minimap: writeDerived's
// "w3.derive" measures).
//
//   node scripts/measure-subterrains.mjs [options]
//
// Options:
//   --map FILE.w3x     the map to make the project from (default: the largest map of the corpus, W3PROJ_CORPUS or
//                      smoketest_maps of the main checkout); grown to --size tiles with the app's own Resize Map, filled
//                      with doodads (scatter_objects), creeps (place_objects) and plateaus (set_cliff_level), saved, then
//                      split by `w3proj terrain split` into a --grid × --grid layout named r<row>c<column> (r0c0 the
//                      south-west). Kept in <work>/source and made again only when missing (--remake)
//   --project DIR      a split project to measure instead (nothing is made)
//   --size N           tiles per side of the made map (default 256)
//   --grid N           subterrains per side (default 4)
//   --scenarios LIST   comma-separated: all (every subterrain open), one (only --one open) (default all,one)
//   --one NAME         the subterrain the "one" scenario opens (default r1c1)
//   --work DIR         scratch folder (default target/measure-subterrains)
//   --out FILE         also write the results there as JSON
//   --no-build         use the app as last built; --app PATH a built app (as app-drive)
//   --remake           make the project again
//
// What it doesn't measure: GPU frame times (Xvfb draws with Mesa's software GL, so frame times say nothing about a
// graphics card); the JS heap on WebKitGTK (Linux: it has no performance.memory, so it's null there; WebView2 has it);
// the bytes are what the app's processes read in all (map files and the game's storage alike), from /proc/<pid>/io on
// Linux and Win32_Process.ReadTransferCount on Windows. The first frame is found by polling the page (some tens of ms).
// Never starts the game or the World Editor (app-drive and appctl point their programs at files that don't exist).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { sleep, until } from "./cdp.mjs";
import { app, appExe, buildApp, configDirOf, LINUX, repo, smokeId, startApp } from "./appctl.mjs";
import { findMaps } from "./find-maps.mjs";
import { chosenGamePath, gamePath, mainCheckout } from "../../tests/gamepath.mjs";
import { lit } from "./jslit.mjs";

function parseArgs(argv) {
  const o = { map: null, project: null, size: 256, grid: 4, scenarios: ["all", "one"], one: "r1c1", work: join(repo, "target", "measure-subterrains"), out: null, build: true, remake: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--map") o.map = resolve(value());
    else if (a === "--project") o.project = resolve(value());
    else if (a === "--size") o.size = Number(value());
    else if (a === "--grid") o.grid = Number(value());
    else if (a === "--scenarios") o.scenarios = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--one") o.one = value();
    else if (a === "--work") o.work = resolve(value());
    else if (a === "--out") o.out = resolve(value());
    else if (a === "--no-build") o.build = false;
    else if (a === "--app") process.env.W3_APP_BIN = resolve(value());
    else if (a === "--remake") o.remake = true;
    else if (a === "--allow-stale") continue; // read by tests/binfresh.mjs
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown argument ${a} (see the top of measure-subterrains.mjs)`);
  }
  if (!(o.size % 4 === 0 && o.size >= 32 && o.size <= 480)) throw new Error("--size must be a multiple of 4 from 32 to 480");
  if (!(Number.isInteger(o.grid) && o.grid >= 1 && o.grid <= 16)) throw new Error("--grid must be 1 to 16");
  for (const s of o.scenarios) if (s !== "all" && s !== "one") throw new Error(`unknown scenario ${s} (all, one)`);
  return o;
}

/** The CLI: this checkout's debug build (built if needed) or W3PROJ_BIN. */
function cli() {
  if (process.env.W3PROJ_BIN) return process.env.W3PROJ_BIN;
  const r = spawnSync("cargo", ["build", "--quiet", "-p", "w3proj-cli"], { cwd: repo, stdio: ["ignore", process.stderr, process.stderr] });
  if (r.status !== 0) throw new Error("building the w3proj CLI failed");
  return join(repo, "target", "debug", `w3proj${process.platform === "win32" ? ".exe" : ""}`);
}

/** A map's canvas in tiles, from its war3map.w3e's header (`w3proj cat`); null when it can't be read. */
export function w3eTiles(buf) {
  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "W3E!") return null;
  let at = 4 + 4 + 1 + 4;
  const n = () => { const v = buf.readUInt32LE(at); at += 4; return v; };
  const ground = n();
  at += 4 * ground;
  if (at + 4 > buf.length) return null;
  const cliffs = n();
  at += 4 * cliffs;
  if (at + 8 > buf.length) return null;
  return [n() - 1, n() - 1];
}

/** The corpus map with the largest canvas (ties: more doodads' worth of file). */
function largestCorpusMap() {
  const corpus = process.env.W3PROJ_CORPUS ?? join(mainCheckout(repo), "smoketest_maps");
  if (!existsSync(corpus)) throw new Error(`no corpus at ${corpus}: give --map or W3PROJ_CORPUS`);
  const bin = cli();
  const sized = findMaps([corpus]).map((m) => {
    const r = spawnSync(bin, ["cat", m, "war3map.w3e"], { maxBuffer: 1 << 28 });
    const t = r.status === 0 ? w3eTiles(r.stdout) : null;
    return { m, tiles: t ? t[0] * t[1] : 0, size: statSync(m).size };
  }).sort((a, b) => b.tiles - a.tiles || b.size - a.size);
  if (!sized.length || !sized[0].tiles) throw new Error(`no readable maps in ${corpus}`);
  console.error(`measure: the corpus's largest canvas is ${basename(sized[0].m)} (${Math.round(Math.sqrt(sized[0].tiles))}² tiles or so)`);
  return sized[0].m;
}

/** Grows the open map to `size` tiles per side with the terrain editor's Resize Map (the border as it was). */
const growSource = (size) => `
  const ed = window.__driveEd, t = ed.terrain;
  const info = JSON.parse(await w3.workspace.readText("map/war3map.w3i.json"));
  // A side already that large stays as it is.
  const dx = Math.max(0, ${size} - (t.width - 1)), dy = Math.max(0, ${size} - (t.height - 1));
  if (!dx && !dy) return { from: [t.width - 1, t.height - 1], added: [0, 0, 0, 0] };
  const left = 4 * Math.floor(dx / 8), bottom = 4 * Math.floor(dy / 8);
  await ed.resizeMap([left, dx - left, bottom, dy - bottom], info.cameraComplements);
  return { from: [t.width - 1, t.height - 1], added: [left, dx - left, bottom, dy - bottom] };`;

/** Fills cell (r, c) of a grid over the open map with a plateau, doodads and creeps, by the AI tools (deterministic).
 *  One page call per cell: a call has to end within the WebDriver request's time. */
const fillSource = (grid, row, col) => `
  const ed = window.__driveEd, t = ed.terrain;
  const call = async (name, args) => {
    const r = JSON.parse(await w3.mcp.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })));
    if (r.error || r.result?.isError) throw new Error(name + ": " + JSON.stringify(r).slice(0, 400));
    return r.result.content.map((c) => c.text ?? "").join("");
  };
  let seed = ${12345 + row * 101 + col * 7};
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const doo = JSON.parse(await w3.workspace.readText("map/war3map.doo.json"));
  const count = new Map();
  for (const d of doo.doodads) count.set(d.id, (count.get(d.id) ?? 0) + 1);
  const ids = [...count].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
  const units = JSON.parse(await w3.workspace.readText("map/war3mapUnits.doo.json"));
  const ucount = new Map();
  for (const u of units.units) if (u.player === 24) ucount.set(u.id, (ucount.get(u.id) ?? 0) + 1);
  const creeps = [...ucount].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);
  if (!creeps.length) creeps.push("nftb");
  // The playable part (12 tiles in from every edge), cut into a grid: each cell gets a plateau, trees and creeps.
  const x0 = t.offsetX + 12 * 128, y0 = t.offsetY + 12 * 128, w = (t.width - 1 - 24) * 128, h = (t.height - 1 - 24) * 128;
  const n = ${grid}, cw = w / n, ch = h / n, said = [];
  {
    const r = ${row}, c = ${col};
    const left = x0 + c * cw, bottom = y0 + r * ch;
    const px = left + cw * (0.15 + 0.2 * rnd()), py = bottom + ch * (0.15 + 0.2 * rnd());
    said.push(await call("set_cliff_level", { by: 1, left: px, bottom: py, right: px + cw * 0.3, top: py + ch * 0.3, shape: "box" }).then(() => "cliff", (e) => "cliff: " + e.message));
    said.push(await call("scatter_objects", { ids, kind: "doodads", left, bottom, right: left + cw, top: bottom + ch, density: 0.35, seed: r * n + c + 1, limit: 450, shape: "box" }).then((t) => t.slice(0, 80), (e) => "scatter: " + e.message));
    const objects = Array.from({ length: 80 }, () => ({ id: creeps[Math.floor(rnd() * creeps.length)], x: left + cw * rnd(), y: bottom + ch * rnd(), player: 25 }));
    said.push(await call("place_objects", { kind: "units", objects, ignoreRoom: true }).then((t) => t.slice(0, 80), (e) => "units: " + e.message));
  }
  return said;`;

/** Makes the split project from `map` (see the options), in `dir`. */
function makeProject(o, map, dir) {
  const id = smokeId();
  const genWork = join(o.work, "generate");
  rmSync(genWork, { recursive: true, force: true });
  const drive = join(app, "scripts", "app-drive.mjs");
  const fill = [];
  for (let r = 0; r < o.grid; r++) for (let c = 0; c < o.grid; c++) fill.push("--eval", fillSource(o.grid, r, c));
  const args = [drive, ...(o.build ? [] : ["--no-build"]), "--work", genWork, "--map", map, "--terrain", "--eval", growSource(o.size), "--settle",
    "--sleep", "1000", ...fill, "--settle", "--mcp", "save_project", "--eval", "await w3Workbench.settled(); return w3.workspace.project().root"];
  console.error(`measure: making the ${o.size}×${o.size} project from ${basename(map)} (app-drive)`);
  const r = spawnSync(process.execPath, args, { cwd: app, encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, W3_SMOKE_ID: id } });
  process.stderr.write(r.stderr ?? "");
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  for (const l of lines) console.error(`  ${l.step}: ${JSON.stringify(l.error ?? l.value ?? l.text ?? l.project ?? "").slice(0, 300)}`);
  if (r.status !== 0) throw new Error("making the project failed (app-drive's output above)");
  const made = lines.find((l) => l.step === "--map")?.project;
  rmSync(dir, { recursive: true, force: true });
  cpSync(made, dir, { recursive: true });
  // The grid of subterrains over every corner (so no corner needs the default one).
  const w3e = readFileSync(join(dir, "map", "war3map.w3e.txt"), "utf8");
  const [, cw, ch] = w3e.match(/\ncorners (\d+) (\d+)\n/).map(Number);
  const cuts = (len) => Array.from({ length: o.grid + 1 }, (_, i) => (i === o.grid ? len : Math.round((i * (len - 1)) / o.grid)));
  const xs = cuts(cw), ys = cuts(ch), rects = [];
  for (let r = 0; r < o.grid; r++) for (let c = 0; c < o.grid; c++) rects.push(`r${r}c${c}:${xs[c]},${ys[r]},${xs[c + 1] - xs[c]},${ys[r + 1] - ys[r]}`);
  const split = spawnSync(cli(), ["terrain", "split", dir, ...rects.flatMap((x) => ["--rect", x])], { encoding: "utf8" });
  if (split.status !== 0) throw new Error(`w3proj terrain split failed: ${split.stdout}${split.stderr}`);
  writeFileSync(join(dir, ".measure-source"), JSON.stringify({ map, size: o.size, grid: o.grid }) + "\n");
}

// ---- the app's processes: resident memory and bytes read ----

/** The app's processes (the program and what it started: the webview's), each with its resident memory and bytes read. */
function appProcesses(work) {
  const exe = appExe();
  if (LINUX) {
    const procs = new Map();
    for (const n of readdirSync("/proc")) {
      if (!/^\d+$/.test(n)) continue;
      try {
        const stat = readFileSync(`/proc/${n}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        let mine = false;
        try { mine = readlinkSync(`/proc/${n}/exe`) === exe && readFileSync(`/proc/${n}/environ`, "latin1").includes(`W3PROJ_CONFIG_DIR=${configDirOf(work)}\0`); } catch { /* not ours to read */ }
        procs.set(Number(n), { ppid, mine });
      } catch { /* gone */ }
    }
    const pids = new Set([...procs].filter(([, p]) => p.mine).map(([pid]) => pid));
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, p] of procs) if (!pids.has(pid) && pids.has(p.ppid)) { pids.add(pid); grew = true; }
    }
    let rss = 0, read = 0;
    for (const pid of pids) {
      try {
        rss += Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024;
        read += Number(readFileSync(`/proc/${pid}/io`, "utf8").match(/rchar:\s+(\d+)/)?.[1] ?? 0);
      } catch { /* gone */ }
    }
    return { processes: pids.size, rss, read };
  }
  // Windows: Win32_Process (working set, bytes read by every read call).
  const json = execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,WorkingSetSize,ReadTransferCount | ConvertTo-Json -Compress"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const all = JSON.parse(json);
  const pids = new Set(all.filter((p) => p.ExecutablePath && resolve(p.ExecutablePath) === exe).map((p) => p.ProcessId));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!pids.has(p.ProcessId) && pids.has(p.ParentProcessId)) { pids.add(p.ProcessId); grew = true; }
  }
  const mine = all.filter((p) => pids.has(p.ProcessId));
  return { processes: mine.length, rss: mine.reduce((n, p) => n + Number(p.WorkingSetSize ?? 0), 0), read: mine.reduce((n, p) => n + Number(p.ReadTransferCount ?? 0), 0) };
}

// ---- one scenario ----

async function measure(o, source, scenario) {
  const dir = join(o.work, `run-${scenario}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(source, dir, { recursive: true });
  const layout = JSON.parse(readFileSync(join(dir, "map", "terrain", "terrain.json"), "utf8"));
  const names = layout.subterrains.map((s) => s.name);
  const open = scenario === "all" ? names : [o.one];
  if (!names.includes(o.one)) throw new Error(`no subterrain ${o.one} (there are ${names.join(", ")})`);
  if (scenario === "one") {
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "open-subterrains.json"), JSON.stringify({ format: "w3proj.open-subterrains/1", open }, null, 2) + "\n");
  }
  const sub = layout.subterrains.find((s) => s.name === o.one);
  const runWork = join(o.work, `app-${scenario}`);
  const game = chosenGamePath() ?? gamePath(repo);
  const { page, stop } = await startApp({ id: smokeId(), work: runWork, game });
  try {
    await page.evaluate(`(async () => { const h = w3Workbench.host; await Promise.all(h.extensions.filter((e) => !e.disabled).map((e) => h.activate(e))); })()`);
    await page.evaluate(`(async () => {
      const s = await w3.services.get("w3.terrain");
      s.registerToolGroup({ id: "measure", title: "measure", order: 999, create: (ed) => { window.__measureEd = ed; return { toolbar: document.createElement("div") }; } });
    })()`);
    await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${lit(dir)}); })()`);
    await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${lit(dir)}`));
    await page.evaluate(`w3Workbench.settled()`);
    const before = appProcesses(runWork);
    const t0 = Date.now();
    await page.evaluate(`(() => { window.__measureEd = null; void w3.editors.open("map/war3map.w3e.txt"); })()`);
    let frames = 0;
    await until("the first frame", async () => {
      frames += await page.evaluate(`window.__measureEd ? window.__measureEd.frameCost().frames : 0`);
      return frames > 0;
    }, 300000);
    const firstFrameMs = Date.now() - t0;
    // At rest: the game's files read for a second and the view's layers done (app-drive's --settle), then settled.
    let quietSince = 0;
    await until("the view at rest", async () => {
      const busy = await page.evaluate(`w3Workbench.game.readsPending > 0 || [...document.querySelectorAll("span.muted")].some((e) => !e.hidden && e.textContent === "Working…")`);
      if (busy) { quietSince = 0; return false; }
      quietSince ||= Date.now();
      return Date.now() - quietSince > 1000;
    }, 600000);
    await page.evaluate(`w3Workbench.settled()`);
    const restMs = quietSince - t0;
    const after = appProcesses(runWork);
    const view = await page.evaluate(`(() => {
      const ed = window.__measureEd;
      return { stats: ed.renderStats(), doodads: ed.drawnUnits("doodads").length, units: ed.drawnUnits("units").length,
        heap: performance.memory ? performance.memory.usedJSHeapSize : null };
    })()`);
    // The flat files as the editor reads them (the backend's assembly from map/terrain/), with nothing else meanwhile:
    // the time and the bytes the app read for them.
    const r0 = appProcesses(runWork).read, f0 = Date.now();
    const flatChars = await page.evaluate(`(async () => {
      let n = 0;
      for (const p of ["map/war3map.w3e.txt", "map/war3map.doo.json", "map/war3mapUnits.doo.json", "map/war3map.w3r.json"]) n += (await w3.workspace.readText(p)).length;
      return n;
    })()`);
    const flatReadMs = Date.now() - f0, flatReadBytes = appProcesses(runWork).read - r0;
    // A terrain edit in the open subterrain (raised by the AI tool, which rebuilds pathing, shadows and the minimap):
    // its time to rest and the rebuilds' ("w3.derive").
    const at = (c, i) => layout.offset[i] + 128 * c;
    const cx = at(sub.x + sub.w / 2, 0), cy = at(sub.y + sub.h / 2, 1);
    await page.evaluate(`performance.clearMeasures("w3.derive")`);
    const e0 = Date.now();
    await page.evaluate(`(async () => {
      const r = JSON.parse(await w3.mcp.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sculpt_terrain", arguments: { mode: "raise", amount: 64, left: ${cx - 512}, bottom: ${cy - 512}, right: ${cx + 512}, top: ${cy + 512} } } })));
      if (r.error || r.result?.isError) throw new Error(JSON.stringify(r).slice(0, 300));
    })()`);
    await page.evaluate(`w3Workbench.settled()`);
    const editMs = Date.now() - e0;
    const editDerive = await page.evaluate(`performance.getEntriesByName("w3.derive").map((e) => Math.round(e.duration))`);
    // A save of the terrain editor (marked changed by an empty undo step, so the save writes the terrain and makes the
    // derived files as a save after any edit does): its time to rest and the rebuilds'.
    await page.evaluate(`(() => { window.__measureEd.pushEdit({ undo() {}, redo() {}, terrain: true, objects: false }); performance.clearMeasures("w3.derive"); })()`);
    const s0 = Date.now();
    await page.evaluate(`w3.editors.saveAll()`);
    const saveCallMs = Date.now() - s0;
    await page.evaluate(`w3Workbench.settled()`);
    const saveSettledMs = Date.now() - s0;
    const derive = await page.evaluate(`performance.getEntriesByName("w3.derive").map((e) => Math.round(e.duration))`);
    const dirty = await page.evaluate(`w3.editors.isDirty("map/war3map.w3e.txt")`);
    return {
      scenario, open: open.length, of: names.length, firstFrameMs, restMs,
      heapBytes: view.heap, rssBytes: after.rss, processes: after.processes, readBytes: after.read - before.read,
      flatChars, flatReadMs, flatReadBytes,
      groundQuads: view.stats.groundQuads, waterTriangles: view.stats.waterTriangles, groups: view.stats.groups,
      doodadsDrawn: view.doodads, unitsDrawn: view.units,
      editMs, editDeriveMs: editDerive, saveCallMs, saveSettledMs, deriveMs: derive, dirtyAfterSave: dirty,
    };
  } finally {
    await stop();
    rmSync(runWork, { recursive: true, force: true });
  }
}

const mb = (n) => (n == null ? "n/a" : `${(n / 1048576).toFixed(0)} MB`);

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log("usage: node scripts/measure-subterrains.mjs [options]; the options are listed at the top of the file");
    return 0;
  }
  mkdirSync(o.work, { recursive: true });
  let source = o.project;
  if (!source) {
    const map = o.map ?? largestCorpusMap();
    source = join(o.work, "source", `${basename(map).replace(/\.w3[xm]$/i, "")}-${o.size}-${o.grid}x${o.grid}`);
    if (o.remake || !existsSync(join(source, ".measure-source"))) makeProject(o, map, source);
    else console.error(`measure: using ${source} (made before; --remake makes it again)`);
  }
  if (o.build) buildApp(smokeId(), join(o.work, "build"));
  const results = [];
  for (const s of o.scenarios) {
    console.error(`measure: scenario ${s}`);
    results.push(await measure(o, source, s));
    await sleep(500);
  }
  const doc = { project: source, commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), platform: process.platform, results };
  if (o.out) writeFileSync(o.out, JSON.stringify(doc, null, 2) + "\n");
  console.log(JSON.stringify(doc, null, 2));
  console.log("\n| scenario | open | first frame | at rest | heap | RSS | read while opening | flat files: chars, read, ms | ground quads | water tris | doodads | units | cliffs | edit (derive) | save (derive) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.scenario} | ${r.open}/${r.of} | ${r.firstFrameMs} ms | ${r.restMs} ms | ${mb(r.heapBytes)} | ${mb(r.rssBytes)} | ${mb(r.readBytes)} | ${r.flatChars}, ${mb(r.flatReadBytes)}, ${r.flatReadMs} ms | ${r.groundQuads} | ${r.waterTriangles} | ${r.doodadsDrawn} | ${r.unitsDrawn} | ${r.groups.cliffs?.instances ?? 0} | ${r.editMs} ms (${r.editDeriveMs.join("+") || "none"}) | ${r.saveSettledMs} ms (${r.deriveMs.join("+") || "none"}) |`);
  }
  return 0;
}

if (process.argv[1] && basename(process.argv[1]) === "measure-subterrains.mjs") {
  try {
    process.exit(await main());
  } catch (e) {
    console.error(`measure-subterrains: ${e.message}`);
    process.exit(1);
  }
}
