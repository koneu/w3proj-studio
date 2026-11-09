// The real app, with its real Rust backend, on a scratch copy of the mini map: opens the project,
// opens each file in its editor, saves, and packs; then makes new maps, places objects, builds them
// and holds the result against the CLI and the game's script API; then uses the New Map dialog, paints
// terrain, changes a unit and renames a trigger by mouse and keyboard, sent into the hidden window. ui-smoke runs the front end on a
// fake; this is what that can't reach. New maps need the game installed (W3PROJ_GAME).
//
// It runs a build of its own, made with these changes to tauri.conf.json:
//   - another identifier, so its settings folder isn't the one of the app you use
//   - a hidden window, so it never shows up or takes the focus while someone works
// Nothing else differs from the app, and no setting of yours is read or written.
//
//   node scripts/app-smoke.mjs            builds if needed, then runs
//   node scripts/app-smoke.mjs --no-build runs what was built last
//   node scripts/app-smoke.mjs --break    breaks a file on purpose: this run has to fail
//   --verbose shows what each editor put on screen

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { inflateSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, Hands, problems, sleep, until } from "./cdp.mjs";
import { launch } from "./webdriver.mjs";
import { ensureCli, smokeId } from "./appctl.mjs";
import { chosenGamePath, gamePath, mainCheckout } from "../../tests/gamepath.mjs";

const LINUX = process.platform === "linux";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "..");
// W3_SMOKE_DIR: another folder, when this one has a project someone opened to try out.
const work = process.env.W3_SMOKE_DIR ?? join(repo, "target", "app-smoke");
const exeName = process.platform === "win32" ? ".exe" : "";
const exe = join(repo, "target", "debug", `w3proj-studio${exeName}`);
let cli = process.env.W3PROJ_BIN ?? join(repo, "target", "release", `w3proj${exeName}`);
// W3_SMOKE_ID: another identifier; without it one per checkout, the one the gate uses (so a run by hand doesn't
// rebuild the gate's app for another identifier, and two worktrees don't share a settings folder).
const IDENTIFIER = smokeId(repo);
const FIXTURE = join(repo, "tests", "fixtures", "mini-map");

function build() {
  const conf = JSON.parse(readFileSync(join(app, "src-tauri", "tauri.conf.json"), "utf8"));
  // Linux runs it inside xvfb-run, a display nobody sees, where the window has to be shown to be drawn.
  const windows = conf.app.windows.map((w) => ({ ...w, visible: LINUX }));
  const patch = join(work, "tauri.smoke.json");
  writeFileSync(patch, JSON.stringify({ identifier: IDENTIFIER, app: { windows }, build: { beforeBuildCommand: "npm run build" } }));
  const r = spawnSync(`npx tauri build --debug --no-bundle --config "${patch}"`, { cwd: app, shell: true, stdio: "inherit" });
  if (r.status !== 0) throw new Error("the build failed");
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const game = chosenGamePath();
const installArgs = game ? ["--install", game] : [];

/** What World Editor 3.0.1 writes for a new map, by project file. */
const NEW_MAP_FILES = ["war3map.w3i.json", "war3map.doo.json", "war3mapUnits.doo.json", "war3map.w3r.json", "war3map.w3c.json", "war3map.wtg.json", "war3map.wct.txt",
  "war3map.wts", "war3map.mmp.json", "war3map.w3l.json", "war3map.w3grp", "conversation.json", "war3map.w3e.txt", "war3map.shd", "war3map.wpm", "war3mapMap.blp"];

const NEW_MAPS = [
  { args: { name: "Smoke Default" }, size: [96, 96] },
  { args: { name: "Smoke Dungeon", tileset: "D", width: 64, height: 64, hills: true, cliffLevel: 4 }, size: [64, 64] },
  { args: { name: "Smoke Lua", script: "lua", width: 128, height: 96, water: "deep" }, size: [128, 96] },
  { args: { name: "Größe 金矿", width: 64, height: 128, water: "shallow" }, size: [64, 128] },
];

/** Calls an MCP tool of the app, as an AI client would; a tool error throws. Returns the reply's text. */
function mcpTool(page) {
  return async (name, args = {}) => {
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const reply = JSON.parse(await page.evaluate(`w3.mcp.handle(${JSON.stringify(message)})`));
    const text = reply.result?.content?.[0]?.text ?? reply.error?.message ?? "";
    if (reply.error || reply.result?.isError) throw new Error(`${name}: ${text}`);
    return text;
  };
}

/** Creates maps as a user would, through the app, and holds what comes out against the tools. */
async function newMaps(page, found) {
  const folder = join(work, "new");
  mkdirSync(folder, { recursive: true });
  const tool = mcpTool(page);
  // Stands for the user pressing Create map.
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await page.evaluate(`(async () => { const h = w3Workbench.host; await Promise.all(h.extensions.filter((e) => !e.disabled).map((e) => h.activate(e))); })()`);

  const scripts = [];
  for (const { args, size } of NEW_MAPS) {
    const fail = (what) => found.push(`new map "${args.name}": ${what}`);
    try {
      await tool("new_map", { ...args, folder });
      const root = await page.evaluate(`w3.workspace.project()?.root`);
      const names = new Set(walk(join(root, "map")).map((p) => relative(join(root, "map"), p).replaceAll("\\", "/")));
      const scriptFile = args.script === "lua" ? "war3map.lua" : "war3map.j";
      for (const n of [...NEW_MAP_FILES, scriptFile]) if (!names.has(n)) fail(`no ${n}`);
      const active = await page.evaluate(`w3.editors.activePath()`);
      if (active !== "map/war3map.w3e.txt") fail(`the terrain editor didn't open (active: ${active})`);

      // The first doodad and the first unit: the files start empty.
      await tool("place_objects", { objects: [{ id: "LTlt", x: 0, y: 0 }, { id: "CPct", x: 512, y: 512 }], ignoreRoom: true });
      await tool("place_objects", { objects: [{ id: "hfoo", x: 256, y: 0, player: 1 }], ignoreRoom: true });
      await tool("place_objects", { objects: [{ id: "ratf", x: -256, y: 0, player: 1 }], ignoreRoom: true });
      await tool("save_project");

      // Build, as the button does, right after the save: the map has to have what was just saved.
      // Not awaited: the command waits for its toast's buttons.
      const output = await page.evaluate(`w3.workspace.project().default_output`);
      const map = resolve(root, output);
      await page.evaluate(`void w3.commands.execute("w3.project.pack")`);
      try {
        await until("the build", () => existsSync(map), 20000);
      } catch (e) {
        throw new Error(`no map at ${map}: ${await page.evaluate(`[...document.querySelectorAll(".notification, .toast, .notifications *")].map((e) => e.textContent).join(" | ").slice(0, 300)`)}`);
      }
      await sleep(300);
      if (args.water === "deep") await viewCommands(page, fail, join(work, "view-shots"));
      const verify = spawnSync(cli, ["verify", "-q", map, ...(game ? ["--game", game] : [])], { encoding: "utf8" });
      if (verify.status !== 0 || !/1 ok(?! \(1 incomplete)/.test(verify.stdout)) fail(`verify: ${(verify.stdout + verify.stderr).trim().slice(-300)}`);

      const cat = (name) => spawnSync(cli, ["cat", map, name], { maxBuffer: 1 << 28 });
      const script = cat(scriptFile);
      if (script.status !== 0) fail(`no ${scriptFile} in the map`);
      const file = join(folder, `${scripts.length}-${scriptFile}`);
      writeFileSync(file, script.stdout);
      scripts.push(file);
      // The script knows the unit, and the map the doodad.
      if (!script.stdout.includes(args.script === "lua" ? 'FourCC("hfoo")' : "'hfoo'")) fail("the unit isn't in the script");
      // What the World Editor's files have: see lib/terrain/owner and terrain-viewer/placement.
      const onDisk = (name) => JSON.parse(readFileSync(join(root, "map", name), "utf8"));
      if (onDisk("war3map.w3i.json").flags & 4) fail("a map with a player's unit is still a melee map");
      if (!script.stdout.includes("MAP_PLACEMENT_USE_MAP_SETTINGS")) fail("the script isn't using the map's settings for placement");
      const lifeOf = (id) => onDisk("war3map.doo.json").doodads.find((d) => d.id === id)?.life;
      if (lifeOf("CPct") !== 255 || lifeOf("LTlt") !== 100) fail(`doodad life: CPct ${lifeOf("CPct")}, LTlt ${lifeOf("LTlt")}`);
      const item = onDisk("war3mapUnits.doo.json").units.find((u) => u.id === "ratf");
      if (item?.player !== 27) fail(`the item belongs to ${item?.player}`);
      const doo = JSON.parse(readFileSync(join(root, "map", "war3map.doo.json"), "utf8"));
      if (doo.doodads.length !== 2 || doo.doodads[0].id !== "LTlt") fail(`${doo.doodads.length} doodads`);
      // Pathing covers the map: four cells per tile.
      const wpm = cat("war3map.wpm").stdout;
      const dims = [wpm.readUInt32LE(8), wpm.readUInt32LE(12)];
      if (dims[0] !== size[0] * 4 || dims[1] !== size[1] * 4) fail(`pathing is ${dims.join(" × ")}`);

      // It reads back as a project and comes out the same.
      const back = join(folder, `back-${scripts.length}`), again = join(folder, `again-${scripts.length}.w3x`);
      const unpack = spawnSync(cli, ["unpack", map, back, ...(game ? ["--game", game] : [])], { encoding: "utf8" });
      const repack = spawnSync(cli, ["pack", back, "-o", again], { encoding: "utf8" });
      if (unpack.status !== 0 || repack.status !== 0) fail(`round trip: ${unpack.stderr}${repack.stderr}`);
      else if (hash(map) !== hash(again)) fail("pack, unpack and pack changed the map");

      // Opening it again, as after a restart.
      await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(root)}); await w3.editors.open("map/war3map.w3e.txt"); })()`);
      await sleep(300);
      const again2 = await page.evaluate(`w3.editors.activePath()`);
      if (again2 !== "map/war3map.w3e.txt") fail("it doesn't open again");
    } catch (e) {
      fail(e.message);
    }
  }

  // The scripts, against the game's own API.
  const common = join(folder, "common.j"), blizzard = join(folder, "Blizzard.j");
  for (const [path, file] of [["War3.w3mod:Scripts/common.j", common], ["War3.w3mod:Scripts/Blizzard.j", blizzard]]) {
    const r = spawnSync(cli, ["game", ...installArgs, "cat", path], { maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`can't read ${path}`);
    writeFileSync(file, r.stdout);
  }
  const check = spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", new URL("./script-check/tsregister.mjs", import.meta.url).href,
    join(app, "scripts", "script-check", "check-scripts.mts"), join(app, "src", "lib"), common, blizzard, ...scripts], { encoding: "utf8" });
  if (check.status !== 0 || !check.stdout.includes(`${NEW_MAPS.length} scripts checked`)) found.push(`generated scripts: ${(check.stderr + check.stdout).trim().slice(0, 500)}`);
  return scripts.length;
}

/** Lets a project file's writes be held by the test: `hold` stops them where they begin, `release` lets them
 *  go. `state` says how many ran and how many were running at once, and whether the file's editor has
 *  unsaved changes. The writes are the workspace's, which every editor and tool saves through. */
async function gateWrites(page, path) {
  const key = JSON.stringify(path);
  await page.evaluate(`(() => {
    const path = ${key}, gates = (window.__gates ??= {});
    const g = gates[path] = { hold: null, release: null, inflight: 0, max: 0, writes: 0 };
    const space = w3Workbench.workspace, write = (space.__write ??= space.writeText);
    space.writeText = async function (p, text) {
      const g = gates[String(p).split(String.fromCharCode(92)).join("/")];
      if (!g) return write.call(this, p, text);
      g.writes++; g.max = Math.max(g.max, ++g.inflight);
      try {
        if (g.hold) await g.hold;
        return await write.call(this, p, text);
      } finally { g.inflight--; }
    };
  })()`);
  return {
    state: () => page.evaluate(`({ ...window.__gates[${key}], dirty: w3.editors.isDirty(${key}) })`),
    hold: () => page.evaluate(`(() => { const g = window.__gates[${key}]; g.hold = new Promise((r) => { g.release = r; }); })()`),
    release: () => page.evaluate(`(() => { const g = window.__gates[${key}]; g.release?.(); g.hold = null; })()`),
  };
}

/** The terrain editor's wiring around its saves and reloads, which no unit test can reach: tools that
 *  follow each other at once, footprints read again, and saves that run one at a time. */
async function terrainWiring(page, found) {
  const fail = (what) => found.push(`terrain wiring: ${what}`);
  const tool = mcpTool(page);
  const folder = join(work, "wiring");
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await tool("new_map", { name: "Wiring", width: 64, height: 64, folder });
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  const root = await page.evaluate(`w3.workspace.project()?.root`);
  const json = async (name, args) => JSON.parse(await tool(name, args));
  const place = (id, x, y) => json("place_objects", { objects: [{ id, x, y, player: 1 }] });

  // A type made by create_object is placeable by the very next call, with no wait in between: the
  // editor waits for the reload that the save of the object data sets off.
  const made = (await json("create_object", { kind: "units", base: "hfoo" })).id;
  const first = await json("place_objects", { objects: [{ id: made, x: 0, y: 0, player: 1 }], ignoreRoom: true }).catch((e) => ({ error: e.message }));
  if (first.placed !== 1 || first.skipped?.length) fail(`a unit made by create_object, placed at once: ${JSON.stringify(first)}`);

  // A footprint changed in the object data is seen with the editor still open. A big building stands
  // in the way of a second one; once its footprint is made small, the second fits.
  const hall = (await json("create_object", { kind: "units", base: "hbar" })).id;
  const one = await place(hall, 1000, 1000).catch((e) => ({ error: e.message }));
  if (one.placed !== 1) fail(`the first building: ${JSON.stringify(one)}`);
  const blocked = await place(hall, 1100, 1000).then(() => null, (e) => e.message);
  if (!/stands there/.test(blocked ?? "")) fail(`a building next to a big one wasn't refused (control): ${blocked}`);
  await tool("set_object_fields", { kind: "units", id: hall, changes: [{ field: "upat", value: "PathTextures\\2x2Default.tga" }] });
  const small = await place(hall, 1100, 1000).catch((e) => ({ error: e.message }));
  if (small.placed !== 1) fail(`the footprint change wasn't seen without reopening: ${JSON.stringify(small)}`);

  // Saves of the ground. The write of the file is held, to make an edit and another save while it runs.
  const hands = new Hands(page);
  const ground = join(root, "map", "war3map.w3e.txt");
  const gate = await gateWrites(page, "map/war3map.w3e.txt");
  const state = gate.state;
  const hold = gate.hold, release = gate.release;
  await page.evaluate(`[...document.querySelectorAll("button, .tab, [role=tab]")].find((b) => b.textContent.trim() === "Terrain")?.click()`);
  await sleep(300);
  const canvas = await hands.where(".terrain-view canvas, canvas");
  let row = 0;
  const paint = async () => {
    row += 1;
    await hands.drag({ x: canvas.x - 60, y: canvas.y - 120 + row * 40 }, { x: canvas.x + 60, y: canvas.y - 120 + row * 40 });
    await sleep(200);
  };
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const base = hash(ground);
  await paint();
  if (!(await state()).dirty) { fail("painting didn't mark the ground as changed"); return; }

  try {
    // A: an edit made while the save writes stays unsaved, and is saved by the next one.
    await hold();
    await page.evaluate(`void (window.__save = w3.editors.saveAll())`);
    await until("the write", async () => (await state()).inflight === 1, 5000);
    await paint();
    await release();
    await page.evaluate(`window.__save`);
    await sleep(300);
    const afterFirst = hash(ground);
    if (afterFirst === base) fail("the save wrote nothing");
    if (!(await state()).dirty) fail("an edit made during a save was marked as saved");
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(300);
    if ((await state()).dirty) fail("the next save left the ground marked as changed");
    if (hash(ground) === afterFirst) fail("an edit made during a save was lost: the next save wrote the same file");

    // B: saves run one at a time, even asked for while one runs.
    await paint();
    const writesBefore = (await state()).writes;
    await hold();
    await page.evaluate(`void (window.__save = w3.editors.saveAll())`);
    await until("the write", async () => (await state()).inflight === 1, 5000);
    await paint();
    await page.evaluate(`void (window.__save2 = w3.editors.saveAll())`);
    await sleep(500);
    const during = await state();
    if (during.writes - writesBefore !== 1 || during.inflight !== 1) fail(`a second save started while the first wrote: ${during.writes - writesBefore} writes, ${during.inflight} in flight`);
    await release();
    await page.evaluate(`Promise.all([window.__save, window.__save2])`);
    await sleep(300);
    const end = await state();
    if (end.max > 1) fail(`${end.max} writes of the ground ran at once`);
    if (end.writes - writesBefore !== 2) fail(`${end.writes - writesBefore} writes for two saves`);
    if (end.dirty) fail("the ground is marked as changed after two saves");
    if (hash(ground) === afterFirst) fail("the second save didn't write the edit made during the first");

  } finally {
    await release();
  }

  // The Object Editor's strings: a name kept in war3map.wts is saved there, and one typed while the
  // file is written stays unsaved.
  await tool("set_object_fields", { kind: "units", id: made, changes: [{ field: "unam", value: "TRIGSTR_001" }] });
  await page.evaluate(`void w3.commands.execute("w3.objectEditor.open", "w3u", ${JSON.stringify(made)})`);
  await until("the object's fields", () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell").length > 20`), 30000);
  await hands.click("input.obj-field-search");
  await hands.type("unam");
  await until("the name field", () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell input").length === 1`), 5000);
  const strings = join(root, "map", "war3map.wts");
  const wts = gateWrites(page, "map/war3map.wts"), objects = "map/war3map.w3u.json";
  const gated = await wts;
  const dirtyObjects = () => page.evaluate(`w3.editors.isDirty(${JSON.stringify(objects)})`);
  await retype(hands, ".obj-table .obj-value-cell input", "First Name");
  if (!(await dirtyObjects())) fail("changing a map string didn't mark the object file as changed");
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  if (!readFileSync(strings, "utf8").includes("First Name")) fail("a changed map string wasn't saved into war3map.wts");
  if (await dirtyObjects()) fail("the object file is still marked as changed after saving");
  try {
    await retype(hands, ".obj-table .obj-value-cell input", "Second Name");
    await gated.hold();
    await page.evaluate(`void (window.__save = w3.editors.saveAll())`);
    await until("the write of the strings", async () => (await gated.state()).inflight === 1, 5000);
    await retype(hands, ".obj-table .obj-value-cell input", "Third Name");
    await gated.release();
    await page.evaluate(`window.__save`);
    await sleep(300);
    if (!(await dirtyObjects())) fail("a string typed while war3map.wts was written was marked as saved");
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(300);
    if (await dirtyObjects()) fail("the next save left the object file marked as changed");
    const text = readFileSync(strings, "utf8");
    if (!text.includes("Third Name") || text.includes("Second Name")) fail("a string typed during a save was lost");
  } finally {
    await gated.release();
  }
}

/** place_objects on a new map: a dry run refuses the overlaps among its own objects that the real run refuses,
 *  and the placing itself takes the Melee flag off (not the map script's regeneration a moment after a save,
 *  which is off here, as it is with script.generateOnSave unset or a project closed right after). */
async function placeObjects(page, found) {
  const fail = (what) => found.push(`place objects: ${what}`);
  const tool = mcpTool(page);
  const folder = join(work, "placing");
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await tool("new_map", { name: "Placing", width: 64, height: 64, folder });
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  const root = await page.evaluate(`w3.workspace.project()?.root`);
  const flags = () => JSON.parse(readFileSync(join(root, "map", "war3map.w3i.json"), "utf8")).flags;
  await page.evaluate(`w3.settings.set("script.generateOnSave", false)`);
  try {
    const two = { objects: [{ id: "hbar", x: 1024, y: 1024, player: 1 }, { id: "hbar", x: 1024, y: 1024, player: 1 }] };
    const dry = JSON.parse(await tool("place_objects", { ...two, dryRun: true }));
    if (dry.wouldPlace !== 1 || dry.skipped.length !== 1) fail(`a dry run of two barracks on one spot: ${JSON.stringify(dry)}`);
    // The dry run's own marks stay out of the editor's map of what's taken.
    const again = JSON.parse(await tool("place_objects", { objects: [two.objects[0]], dryRun: true }));
    if (again.wouldPlace !== 1) fail(`a dry run left its objects in the way: ${JSON.stringify(again)}`);
    if (!(flags() & 4)) fail("a new map isn't a melee map (control)");
    const real = JSON.parse(await tool("place_objects", two));
    if (real.placed !== 1 || JSON.stringify(real.skipped) !== JSON.stringify(dry.skipped)) fail(`the real run refused other things than its dry run: ${JSON.stringify(real)} vs ${JSON.stringify(dry)}`);
    if (flags() & 4) fail("a map with a player's unit placed is still a melee map");
    // One undo step takes the unit and the flag back.
    await tool("undo_last_edit");
    if (!(flags() & 4)) fail("undoing the placing didn't make it a melee map again");
  } finally {
    await page.evaluate(`w3.settings.set("script.generateOnSave", undefined)`);
  }
}

/** Water set by the tool reaches the pathing map: units walk through the shallow rim of a lake, not
 *  across its deep middle. War3map.wpm is rewritten by the app a moment after the edit, and has to be
 *  right when the project is saved and packed straight after. */
async function waterPathing(page, found) {
  const fail = (what) => found.push(`water pathing: ${what}`);
  const tool = mcpTool(page);
  const folder = join(work, "water");
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await tool("new_map", { name: "Water", width: 64, height: 64, folder });
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  const root = await page.evaluate(`w3.workspace.project()?.root`);
  const wpmFile = join(root, "map", "war3map.wpm");
  // Cell (x, y) of the pathing map holds the world point (x * 32 + offset); the map's middle is the cell 128.
  const cell = (b, x, y) => b[16 + (128 + y) * b.readUInt32LE(8) + 128 + x];
  const before = readFileSync(wpmFile);
  if (cell(before, 0, 0) & 0x02) fail("the new map's middle can't be walked (control)");
  await tool("set_water", { mode: "lake", left: -768, bottom: -768, right: 768, top: 768 });
  // Packing straight after the tool call: saving the project has to bring the pathing map up to date.
  await tool("save_project");
  const out = join(work, "water.w3x");
  await page.evaluate(`w3.backend.invoke("project_pack", { root: ${JSON.stringify(root)}, output: ${JSON.stringify(out)} })`);
  const inMap = spawnSync(cli, ["cat", out, "war3map.wpm"], { maxBuffer: 1 << 26 });
  if (inMap.status !== 0) { fail("the CLI can't read war3map.wpm from the packed map"); return; }
  const wpm = inMap.stdout;
  if (!(cell(wpm, 0, 0) & 0x02)) fail("the deep middle of a lake can be walked in the packed map's pathing (cell flags " + cell(wpm, 0, 0).toString(16) + ")");
  // Along the row through the middle: unwalkable water in a stretch, and walkable wet cells at its ends.
  const row = []; for (let x = -30; x <= 30; x++) row.push(cell(wpm, x, 0));
  if (!row.some((v) => !(v & 0x40) && !(v & 0x02))) fail("the lake has no shallow rim that can be walked");
  if (!row.some((v) => v & 0x02)) fail("the lake has no deep part");

  // The same with the terrain tab closed straight after the edits (before the rebuild's few seconds are up): a
  // doodad that blocks, and a second lake; the pathing map has both in the pack.
  const packed = async (name) => {
    await tool("save_project");
    const file = join(work, name);
    await page.evaluate(`w3.backend.invoke("project_pack", { root: ${JSON.stringify(root)}, output: ${JSON.stringify(file)} })`);
    const r = spawnSync(cli, ["cat", file, "war3map.wpm"], { maxBuffer: 1 << 26 });
    return r.status === 0 ? r.stdout : null;
  };
  await tool("place_objects", { objects: [{ id: "LPwb", x: 1536, y: 1536 }], ignoreRoom: true });
  await tool("set_water", { mode: "lake", left: -2560, bottom: -2560, right: -1536, top: -1536 });
  await page.evaluate(`w3.editors.closeAll()`);
  const closed = await packed("water-closed.w3x");
  if (!closed) { fail("the CLI can't read war3map.wpm after the tab was closed"); return; }
  if (!(cell(closed, -64, -64) & 0x02)) fail("a lake made just before the terrain tab was closed isn't in the packed pathing map");
  let tree = false;
  for (let y = 46; y <= 50; y++) for (let x = 46; x <= 50; x++) if (cell(closed, x, y) & 0x02) tree = true;
  if (!tree) fail("a doodad placed just before the terrain tab was closed doesn't block in the packed pathing map");
  // Neither that save nor the rebuild after an edit made with the tab closed opens it again: the files are
  // written without it. remove_objects works on the files, so it needs no editor itself.
  const tab = () => page.evaluate(`w3.editors.activePath()`);
  if (await tab()) fail(`saving with the terrain tab closed opened ${await tab()}`);
  await tool("remove_objects", { kind: "doodads", left: 1400, bottom: 1400, right: 1700, top: 1700 });
  let freed = false;
  await until("the rebuild after the edit", () => {
    const b = readFileSync(wpmFile);
    let blocked = false;
    for (let y = 46; y <= 50; y++) for (let x = 46; x <= 50; x++) if (cell(b, x, y) & 0x02) blocked = true;
    freed = !blocked;
    return freed;
  }, 20000).catch(() => {});
  if (!freed) fail("the pathing map wasn't rebuilt after a doodad was removed with the terrain tab closed");
  if (await tab()) fail(`the rebuild after an edit with the terrain tab closed opened ${await tab()}`);

  // A commit straight after a tool's edit takes the rebuilt pathing map with it: nothing of the project is left uncommitted.
  const git = (...args) => spawnSync("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  await page.evaluate(`(() => { w3.window.inputBox = async () => "lake"; })()`);
  await tool("save_project");
  await page.evaluate(`w3.commands.execute("w3.scm.refresh").catch(() => {})`);
  await tool("set_water", { mode: "lake", left: 1536, bottom: -2560, right: 2560, top: -1536 });
  const err = await page.evaluate(`w3.commands.execute("w3.scm.commit").then(() => null, (e) => String(e))`);
  if (err) fail(`commit: ${err}`);
  const left = git("status", "--porcelain").stdout.trim();
  if (left) fail(`a commit straight after a tool's edit left changes uncommitted: ${left.split(/[\r\n]+/).slice(0, 4).join(" | ")}`);
  if (!git("show", "--stat", "--format=", "HEAD").stdout.includes("war3map.wpm")) fail("the commit straight after a tool's edit has no new pathing map");
}

/** Object data saved while the terrain editor opens (a tool writing then) reaches it: the first load of the placed
 *  objects is held after it read the units file, a new unit type is made meanwhile, and the editor knows it afterwards. */
async function objectsWhileOpening(page, found) {
  const fail = (what) => found.push(`objects while opening: ${what}`);
  const tool = mcpTool(page);
  const folder = join(work, "opening");
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await tool("new_map", { name: "Opening", width: 64, height: 64, folder });
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  await page.evaluate(`w3.editors.closeAll()`);
  // The next read of the units file returns what it read only once released.
  await page.evaluate(`(() => {
    const space = w3Workbench.workspace, read = (space.__read ??= space.readText);
    const g = window.__heldRead = { reads: 0 };
    g.hold = new Promise((r) => { g.release = r; });
    space.readText = async function (p) {
      const text = await read.call(this, p);
      if (g.reads === 0 && String(p).split(String.fromCharCode(92)).join("/") === "map/war3mapUnits.doo.json") { g.reads++; await g.hold; }
      return text;
    };
  })()`);
  try {
    await page.evaluate(`void w3.commands.execute("w3.terrain.open")`);
    await until("the editor's first load", () => page.evaluate(`window.__heldRead.reads === 1`), 20000);
    const made = JSON.parse(await tool("create_object", { kind: "units", base: "hfoo" })).id;
    await page.evaluate(`window.__heldRead.release()`);
    const r = await tool("place_objects", { objects: [{ id: made, x: 0, y: 0, player: 1 }], ignoreRoom: true }).then(JSON.parse, (e) => ({ error: e.message }));
    if (r.placed !== 1) fail(`a unit type made while the terrain editor opened is unknown to it: ${JSON.stringify(r)}`);
  } finally {
    await page.evaluate(`(() => { window.__heldRead?.release(); const s = w3Workbench.workspace; if (s.__read) s.readText = s.__read; })()`);
  }
}

/** The terrain painter's tile templates (Tiles…, Template, Use its tiles): another tileset's tiles make the w3e's
 *  list custom, and the tileset's own tiles again clear the flag, as the World Editor writes it. */
async function tileTemplate(page, found) {
  const fail = (what) => found.push(`tile template: ${what}`);
  const tool = mcpTool(page);
  const folder = join(work, "template");
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await tool("new_map", { name: "Template", width: 64, height: 64, folder });
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  const root = await page.evaluate(`w3.workspace.project()?.root`);
  const header = (key) => new RegExp(`^${key} (\\S+)`, "m").exec(readFileSync(join(root, "map", "war3map.w3e.txt"), "utf8"))?.[1];
  const own = header("tileset");
  if (header("custom-tilesets") !== "0") fail(`a new map's tile list is custom (control): ${header("custom-tilesets")}`);
  await page.evaluate(`[...document.querySelectorAll("button, .tab, [role=tab]")].find((b) => b.textContent.trim() === "Terrain")?.click()`);
  await sleep(300);
  await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Tiles…").click()`);
  const template = `document.querySelectorAll(".terrain-tilemgr-row")[1]?.querySelector("select")`;
  await until("the tile templates", () => page.evaluate(`(${template})?.options.length > 1`), 20000);
  const use = async (id) => {
    const ok = await page.evaluate(`(() => {
      const s = ${template};
      if (![...s.options].some((o) => o.value === ${JSON.stringify(id)})) return false;
      s.value = ${JSON.stringify(id)};
      [...document.querySelectorAll(".terrain-tilemgr button")].find((b) => b.textContent === "Use its tiles").click();
      return true;
    })()`);
    if (!ok) throw new Error(`no template ${id}`);
    await sleep(300);
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(500);
  };
  await use(own === "A" ? "B" : "A");
  if (header("custom-tilesets") !== "1") fail(`another tileset's tiles didn't make the list custom (control): ${header("custom-tilesets")}`);
  await use(own);
  if (header("custom-tilesets") !== "0") fail(`the tileset's own tiles again left the custom tiles flag at ${header("custom-tilesets")}`);
  if (header("tileset") !== own) fail(`a template changed the tileset to ${header("tileset")}`);
}

/** A new map for a terrain check, with its terrain editor open on the Terrain tab, and a tool group of the check's own that
 *  counts the terrain editors made: an edit taken in place keeps the one there. */
async function terrainMap(page, name) {
  const tool = mcpTool(page);
  const folder = join(work, name);
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await page.evaluate(`(async () => {
    const s = await w3.services.get("w3.terrain");
    window.__countEditors?.dispose();
    window.__editorsMade = 0;
    window.__countEditors = s.registerToolGroup({ id: "smoke-count", title: "Smoke", order: 999, create: (ed) => { window.__editorsMade++; window.__smokeEd = ed; return { toolbar: document.createElement("div") }; } });
  })()`);
  await tool("new_map", { name, width: 64, height: 64, folder });
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt" && !!window.__smokeEd && !!document.querySelector(".model-stage canvas")`), 30000);
  const root = await page.evaluate(`w3.workspace.project()?.root`);
  const w3e = join(root, "map", "war3map.w3e.txt");
  const kit = {
    tool, root, w3e,
    ground: () => /^ground (.*)$/m.exec(readFileSync(w3e, "utf8"))?.[1].trim().split(" ") ?? [],
    made: () => page.evaluate(`window.__editorsMade`),
    /** The side list's heading, which follows the editor's tile list. */
    heading: () => page.evaluate(`[...document.querySelectorAll(".model-side h4")].find((e) => e.textContent.startsWith("Ground textures"))?.textContent ?? ""`),
    save: async () => { await page.evaluate(`w3.editors.saveAll()`); await sleep(600); },
    undo: async () => { await page.evaluate(`w3.commands.execute("workbench.undo")`); await sleep(300); },
    tab: async (label) => { await page.evaluate(`[...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`); await sleep(300); },
    done: () => page.evaluate(`window.__countEditors?.dispose(); window.__countEditors = null;`),
  };
  // The cliff types are read: what uses a tile is known (Tiles… waits for it).
  await until("the game's cliff types", () => page.evaluate(`typeof window.__smokeEd.groundTileUse !== "function" || !!window.__smokeEd.groundTileUse()`), 30000);
  return kit;
}

/** An AI tool's edit that adds a ground tile is taken by the open terrain editor in place, as its other edits are; a map
 *  size change opens the editor again, with the camera and the selected object as they were. */
async function tilesInPlace(page, found) {
  const fail = (what) => found.push(`terrain in place: ${what}`);
  const k = await terrainMap(page, "InPlace");
  try {
    const before = k.ground(), made = await k.made();
    const tile = ["Lgrs", "Agrs", "Bdrt", "Ndrt", "Ydrt"].find((t) => !before.includes(t));
    await k.tool("paint_terrain", { tile, left: -512, bottom: -512, right: 512, top: 512 });
    await until("the painted tile on disk", () => k.ground().includes(tile), 10000).catch(() => fail(`${tile} didn't join the map's list (control): ${k.ground().join(" ")}`));
    const want = `Ground textures (${k.ground().length})`;
    await until("the editor's tile list", async () => (await k.heading()) === want, 10000).catch(async () => fail(`the editor shows "${await k.heading()}", the map has ${want}`));
    if ((await k.made()) !== made) fail("a new ground tile from an AI tool opened the terrain editor again instead of taking it in place");
    const live = await page.evaluate(`window.__smokeEd.terrain.groundTiles.join(" ")`);
    if (live !== k.ground().join(" ")) fail(`the editor's tile list is ${live}, the map's ${k.ground().join(" ")}`);
    if (!(await page.evaluate(`!window.__smokeEd.host.isConnected ? false : true`))) fail("the editor taken in place isn't on screen");

    // Another size: the editor opens again. The selected unit and the camera stay.
    await k.tool("place_objects", { objects: [{ id: "hfoo", x: 256, y: 256, player: 1 }], ignoreRoom: true });
    await k.tool("save_project");
    await page.evaluate(`w3.commands.execute("w3.terrain.showPoint", 256, 256, { id: "hfoo" })`);
    const selName = () => page.evaluate(`document.querySelector(".terrain-sel-name")?.textContent ?? null`);
    // The side panel names the selected object (the Footman).
    await until("the unit selected", async () => (await selName()) === "Footman", 10000).catch(async () => fail(`the unit wasn't selected (control): ${await selName()}`));
    await page.evaluate(`window.__smokeEd.setView({ target: [300, 200, 0], yaw: 1.1, pitch: 0.9, distance: 2345 })`);
    const view = await page.evaluate(`window.__smokeEd.view()`);
    const madeBefore = await k.made();
    await k.tool("resize_map", { right: 32 });
    await until("the editor on the new size", () => page.evaluate(`window.__editorsMade > ${madeBefore} && !!document.querySelector(".model-stage canvas")`), 30000)
      .catch(() => fail("the resize didn't open the editor again (control)"));
    await until("the unit selected again", async () => (await selName()) === "Footman", 15000).catch(async () => fail(`after the resize the selection is ${await selName()}, not the unit`));
    const after = await page.evaluate(`window.__smokeEd.view()`);
    const near = (a, b) => Math.abs(a - b) < 1e-3;
    if (!near(after.target[0], view.target[0]) || !near(after.target[1], view.target[1]) || !near(after.yaw, view.yaw) || !near(after.pitch, view.pitch) || !near(after.distance, view.distance)) {
      fail(`the camera moved with the resize: ${JSON.stringify(view)} became ${JSON.stringify(after)}`);
    }
  } finally {
    await k.done();
  }
}

/** Tiles…: Remove unused takes out the tiles no corner or cliff uses, Clean up removes a used one too with the tile chosen
 *  in its place, and Remove Unused Tiles on Save does it on save (off unless chosen). One undo step each. */
async function tileCleanup(page, found) {
  const fail = (what) => found.push(`tile cleanup: ${what}`);
  const k = await terrainMap(page, "Cleanup");
  try {
    const tile = ["Lgrs", "Agrs", "Bdrt", "Ndrt"].find((t) => !k.ground().includes(t));
    await k.tool("paint_terrain", { tile, left: -512, bottom: -512, right: 512, top: 512 });
    await until("the painted tile", async () => k.ground().includes(tile) && (await k.heading()) === `Ground textures (${k.ground().length})`, 10000);
    const full = k.ground();
    const use = await page.evaluate(`window.__smokeEd.groundTileUse()`);
    const used = full.filter((_, i) => use.ground[i] + use.cliffs[i] > 0);
    if (used.length < 2 || used.length === full.length) { fail(`a new map should use some of its tiles, not all (control): ${full.join(" ")}, used ${used.join(" ")}`); return; }
    // Saving with the setting off (the default) keeps them.
    await page.evaluate(`window.__smokeEd.terrainChanged()`);
    if (!(await page.evaluate(`w3.editors.isDirty("map/war3map.w3e.txt")`))) fail("the terrain wasn't left unsaved for the save (control)");
    await k.save();
    if (k.ground().join(" ") !== full.join(" ")) fail(`saving with Remove Unused Tiles on Save off changed the list: ${k.ground().join(" ")}`);

    await k.tab("Terrain");
    await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Tiles…").click()`);
    const button = (text) => `[...document.querySelectorAll(".terrain-tilemgr button")].find((b) => b.textContent.startsWith(${JSON.stringify(text)}))`;
    await until("Remove unused", () => page.evaluate(`!!${button("Remove unused")} && !${button("Remove unused")}.disabled`), 10000);
    const label = await page.evaluate(`${button("Remove unused")}.textContent`);
    if (label !== `Remove unused (${full.length - used.length})`) fail(`the button says "${label}" for ${full.length - used.length} unused tiles`);
    await page.evaluate(`${button("Remove unused")}.click()`);
    await sleep(300);
    await k.save();
    if (k.ground().join(" ") !== used.join(" ")) fail(`Remove unused left ${k.ground().join(" ")}, the map uses ${used.join(" ")}`);
    await k.undo();
    await k.save();
    if (k.ground().join(" ") !== full.join(" ")) fail(`one undo didn't bring the unused tiles back: ${k.ground().join(" ")}`);

    // Clean up: the unused ones come ticked; the painted tile is ticked too, and goes to another used tile.
    await until("Clean up", () => page.evaluate(`!!${button("Clean up")}`), 5000);
    await page.evaluate(`${button("Clean up")}.click()`);
    await until("the ticks", () => page.evaluate(`document.querySelectorAll(".terrain-tilemgr-row input[type=checkbox]").length === ${full.length}`), 5000);
    const into = used.find((t) => t !== tile);
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll(".terrain-tilemgr-row")].find((r) => r.querySelector(".terrain-tilemgr-name")?.textContent.endsWith("(${tile})"));
      const box = row.querySelector("input[type=checkbox]");
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    })()`);
    await until("its replacement", () => page.evaluate(`!!document.querySelector(".terrain-tilemgr-replace")`), 5000);
    await page.evaluate(`(() => {
      const sel = document.querySelector(".terrain-tilemgr-replace");
      sel.value = String(${full.indexOf(into)});
      sel.dispatchEvent(new Event("change"));
    })()`);
    const removeLabel = await page.evaluate(`[...document.querySelectorAll(".terrain-tilemgr button")].find((b) => /^Remove \\d+ tiles?$/.test(b.textContent))?.textContent`);
    if (removeLabel !== `Remove ${full.length - used.length + 1} tiles`) fail(`the cleanup's button says "${removeLabel}"`);
    const painted = await page.evaluate(`window.__smokeEd.groundTileUsage()[${full.indexOf(tile)}]`);
    const intoBefore = await page.evaluate(`window.__smokeEd.groundTileUsage()[${full.indexOf(into)}]`);
    await page.evaluate(`[...document.querySelectorAll(".terrain-tilemgr button")].find((b) => /^Remove \\d+ tiles?$/.test(b.textContent)).click()`);
    await sleep(300);
    await k.save();
    const kept = used.filter((t) => t !== tile);
    if (k.ground().join(" ") !== kept.join(" ")) fail(`Clean up left ${k.ground().join(" ")}, wanted ${kept.join(" ")}`);
    const intoAfter = await page.evaluate(`window.__smokeEd.groundTileUsage()[window.__smokeEd.terrain.groundTiles.indexOf(${JSON.stringify(into)})]`);
    if (intoAfter !== intoBefore + painted) fail(`${into} has ${intoAfter} corners after taking ${tile}'s ${painted} (it had ${intoBefore})`);

    // Undo, then Remove Unused Tiles on Save: the save takes them out, and one undo puts them back.
    await k.undo();
    await page.evaluate(`w3.settings.set("terrain.removeUnusedTilesOnSave", true)`);
    try {
      await k.save();
      if (k.ground().join(" ") !== used.join(" ")) fail(`with Remove Unused Tiles on Save the save left ${k.ground().join(" ")}, the map uses ${used.join(" ")}`);
    } finally {
      await page.evaluate(`w3.settings.set("terrain.removeUnusedTilesOnSave", false)`);
    }
    await k.undo();
    await k.save();
    if (k.ground().join(" ") !== full.join(" ")) fail(`one undo after the save didn't bring the unused tiles back: ${k.ground().join(" ")}`);

    // The command does the same.
    const err = await page.evaluate(`w3.commands.execute("w3.terrain.removeUnusedTiles").then(() => null, (e) => String(e))`);
    if (err) fail(`Remove Unused Ground Tiles: ${err}`);
    await k.save();
    if (k.ground().join(" ") !== used.join(" ")) fail(`the command left ${k.ground().join(" ")}`);
    await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Tiles…")?.click()`);
  } finally {
    await k.done();
  }
}

/** What the checks of the terrain viewer's height tools share: a new map opened in the editor, and the ways a person
 *  works on it (commands, keys and mouse sent into the hidden window) with the saved files to judge by. */
async function heightKit(page, name) {
  const tool = mcpTool(page), hands = new Hands(page);
  const folder = join(work, "heights", name);
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await tool("new_map", { name, width: 64, height: 64, folder });
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  const root = await page.evaluate(`w3.workspace.project()?.root`);
  const kit = {
    tool, hands, root, FIXED: 4,
    run: (id, ...args) => page.evaluate(`w3.commands.execute(${JSON.stringify(id)}, ...${JSON.stringify(args)}).then(() => null, (e) => String(e))`),
    save: async () => { await page.evaluate(`w3.editors.saveAll()`); await sleep(500); },
    read: (file) => JSON.parse(readFileSync(join(root, "map", file), "utf8")),
    doodads: () => kit.read("war3map.doo.json").doodads,
    units: () => kit.read("war3mapUnits.doo.json").units,
    look: async (x, y, ref) => {
      await page.evaluate(`(async () => (await w3.services.get("w3.terrain")).look.get("map/war3map.w3e.txt")(${x}, ${y}${ref ? `, ${JSON.stringify(ref)}` : ""}))()`);
      // The object is selected once the view has drawn it, which can be later: the keys and commands that follow act on
      // the selection. Its position boxes show where it stands.
      if (ref) {
        const at = `(() => { const i = document.querySelectorAll(".terrain-sel-triple input"); return i.length >= 2 ? [Number(i[0].value), Number(i[1].value)] : null; })()`;
        await until(`${ref.id} at ${ref.x}, ${ref.y} selected`, async () => { const p = await page.evaluate(at); return p && Math.abs(p[0] - ref.x) <= 32 && Math.abs(p[1] - ref.y) <= 32; }, 20000)
          .catch(async (e) => { throw new Error(`${e.message} (the position boxes say ${JSON.stringify(await page.evaluate(at))})`); });
      }
    },
    tab: async (label) => { await page.evaluate(`[...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent === ${JSON.stringify(label)}).click()`); await sleep(300); },
    focusMap: () => page.evaluate(`document.querySelector(".model-stage canvas").focus()`),
    setting: (key) => page.evaluate(`w3.settings.get(${JSON.stringify(key)})`),
    box: (label) => page.evaluate(`[...document.querySelectorAll(".model-toggle")].find((l) => l.textContent.trim() === ${JSON.stringify(label)})?.querySelector("input")?.checked`),
    toasts: () => page.evaluate(`[...document.querySelectorAll(".notification, .toast")].map((e) => e.textContent).join(" | ")`),
    clearToasts: () => page.evaluate(`document.querySelectorAll(".notification, .toast").forEach((e) => e.remove())`),
    docHash: () => hash(join(root, "map", "war3map.doo.json")),
    /** Moves the pointer to the middle of the map view and clicks there: the point the view looks at. */
    clickMiddle: async () => {
      const c = await hands.where(".model-stage canvas");
      await hands.mouse("mouseMoved", c.x, c.y);
      await hands.click(".model-stage canvas");
    },
    /** Packs the saved project and has the CLI verify the map. */
    verify: async (fail) => {
      const map = join(folder, `${name}.w3x`);
      await page.evaluate(`w3.backend.invoke("project_pack", { root: ${JSON.stringify(root)}, output: ${JSON.stringify(map)} })`);
      await until("the pack", () => existsSync(map), 20000);
      const verify = spawnSync(cli, ["verify", "-q", map, ...(game ? ["--game", game] : [])], { encoding: "utf8" });
      if (verify.status !== 0 || !/1 ok(?! \(1 incomplete)/.test(verify.stdout)) fail(`verify: ${(verify.stdout + verify.stderr).trim().slice(-300)}`);
    },
    /** The Advanced switches go back to what they were, for the next check. */
    reset: () => Promise.all(["terrain.preserveCopiedHeight", "terrain.enforceWaterLimits", "terrain.enforceCameraBounds"].flatMap((key) => ["user", "project"].map((layer) => page.evaluate(`w3.settings.set(${JSON.stringify(key)}, undefined, ${JSON.stringify(layer)})`)))),
  };
  return kit;
}

/** Preserve Copied Object Height: a doodad with a fixed height, 64 over the ground (four Ctrl+PageUp), copied and pasted
 *  twice at the same kind of spot, first with the setting on and then off. The two pastes differ only by the setting,
 *  which is what shows it made the difference. The toolbar box and the command are the same setting. */
async function heightsPreserve(page, found) {
  const fail = (what) => found.push(`height tools (preserve): ${what}`);
  const k = await heightKit(page, "Preserve");
  await k.tool("place_objects", { objects: [{ id: "LTlt", x: 0, y: 0 }, { id: "LTlt", x: 256, y: 0 }], ignoreRoom: true });
  await k.save();
  const ground = k.doodads()[0].position[2];
  await k.tab("Select");
  await k.look(256, 0, { id: "LTlt", x: 256, y: 0 });
  await sleep(500);
  await k.focusMap();
  for (let i = 0; i < 4; i++) await k.hands.key("PageUp", "PageUp", 33, 2);
  await k.save();
  const fixedOne = k.doodads().find((d) => d.position[0] === 256);
  if (fixedOne.position[2] !== ground + 64 || !(fixedOne.flags & k.FIXED)) return fail(`the fixed doodad to copy: ${JSON.stringify([fixedOne.position, fixedOne.flags])}`);
  const known = new Set(k.doodads().map((d) => JSON.stringify(d.position)));
  const fresh = () => k.doodads().filter((d) => !known.has(JSON.stringify(d.position)));
  await k.hands.key("c", "KeyC", 67, 2);

  if ((await k.setting("terrain.preserveCopiedHeight")) === false || (await k.box("Keep pasted height")) !== true) fail("Preserve Copied Object Height isn't on by default");
  await k.look(-1024, 0);
  await sleep(400);
  await k.focusMap();
  await k.hands.key("v", "KeyV", 86, 2);
  await k.clickMiddle();
  await k.save();
  const kept = fresh();
  if (kept.length !== 1 || kept[0].position[2] !== ground + 64 || !(kept[0].flags & k.FIXED)) fail(`a pasted fixed doodad with Preserve Copied Object Height on: ${JSON.stringify(kept.map((d) => [d.position, d.flags]))}`);

  await k.run("w3.terrain.togglePreserveCopiedHeight");
  if ((await k.setting("terrain.preserveCopiedHeight")) !== false || (await k.box("Keep pasted height")) !== false) fail("the toggle command didn't switch Preserve Copied Object Height off, or the toolbar box didn't follow");
  await k.look(-1024, 512);
  await sleep(400);
  await k.clickMiddle();
  await k.save();
  const loose = fresh().filter((d) => JSON.stringify(d.position) !== JSON.stringify(kept[0]?.position));
  if (loose.length !== 1 || loose[0].position[2] !== ground || (loose[0].flags & k.FIXED)) fail(`a pasted fixed doodad with Preserve Copied Object Height off: ${JSON.stringify(loose.map((d) => [d.position, d.flags]))}`);

  // The toolbar box switches it on again, and gives the keys back to the map.
  await k.hands.click(".model-toggle", "Keep pasted height");
  if ((await k.setting("terrain.preserveCopiedHeight")) !== true) fail("the toolbar box didn't switch Preserve Copied Object Height on");
  if (!(await page.evaluate(`document.activeElement === document.querySelector(".model-stage canvas")`))) fail("the Preserve Copied Object Height box kept the keyboard");
  await k.hands.key("Escape", "Escape", 27);

  // A project that keeps its own value (.w3proj/settings.json) wins over the user's: the switch has to change that one.
  await page.evaluate(`w3.settings.set("terrain.preserveCopiedHeight", true, "project")`);
  await k.run("w3.terrain.togglePreserveCopiedHeight");
  if ((await k.setting("terrain.preserveCopiedHeight")) !== false || (await k.box("Keep pasted height")) !== false) fail("the toggle command did nothing while the project keeps its own Preserve Copied Object Height");
  await k.hands.click(".model-toggle", "Keep pasted height");
  if ((await k.setting("terrain.preserveCopiedHeight")) !== true) fail("the toolbar box did nothing while the project keeps its own Preserve Copied Object Height");
  await k.verify(fail);
  await k.reset();
}

/** Set Uniform Doodad Heights and Reset Fixed Object Heights, by command on a selection made with Ctrl+A: the height is
 *  asked for (a word that isn't a number changes nothing), the doodads take it and hold it, a unit in the selection is
 *  left alone, and each is one undo step. A reset with nothing fixed makes no change at all. */
async function heightsUniform(page, found) {
  const fail = (what) => found.push(`height tools (uniform): ${what}`);
  const k = await heightKit(page, "Uniform");
  await k.tool("place_objects", { objects: [{ id: "LTlt", x: 0, y: 0 }, { id: "LTlt", x: 256, y: 0 }, { id: "LTlt", x: 0, y: 512 }], ignoreRoom: true });
  await k.tool("place_objects", { objects: [{ id: "hfoo", x: 512, y: 0, player: 1 }], ignoreRoom: true });
  await k.save();
  const start = k.doodads(), footman = k.units().find((u) => u.id === "hfoo");
  if (start.length !== 3 || !footman) return fail(`the map has ${start.length} doodads and ${footman ? "a" : "no"} footman`);
  const ground = start[0].position[2], hash0 = k.docHash();
  if (start.some((d) => d.flags & k.FIXED)) fail("a doodad is placed with a fixed height");
  await k.tab("Select");
  await k.focusMap();
  await k.hands.key("a", "KeyA", 65, 2);
  await sleep(300);

  await page.evaluate(`(() => { window.__typed = "abc"; w3.window.inputBox = async () => window.__typed; })()`);
  await k.run("w3.terrain.setUniformDoodadHeights");
  await k.save();
  if (k.docHash() !== hash0) fail("a height that isn't a number changed the doodads");
  await page.evaluate(`window.__typed = "150"`);
  const err = await k.run("w3.terrain.setUniformDoodadHeights");
  if (err) fail(`Set Uniform Doodad Heights: ${err}`);
  await k.save();
  const uniform = k.doodads();
  if (uniform.some((d) => d.position[2] !== 150 || !(d.flags & k.FIXED))) fail(`uniform heights: ${uniform.map((d) => `${d.position[2]}/${d.flags}`).join(" ")}`);
  if (k.units().find((u) => u.id === "hfoo").position[2] !== footman.position[2]) fail("Set Uniform Doodad Heights moved a unit");
  await k.run("workbench.undo");
  await k.save();
  if (k.docHash() !== hash0) fail("one undo didn't take Set Uniform Doodad Heights back");
  await k.run("workbench.redo");
  await k.save();
  if (k.doodads().some((d) => d.position[2] !== 150)) fail("redo didn't set the uniform heights again");

  const none = await k.run("w3.terrain.resetFixedObjectHeights");
  if (none) fail(`Reset Fixed Object Heights: ${none}`);
  await k.save();
  if (k.doodads().some((d, i) => d.position[2] !== ground || (d.flags & k.FIXED) || d.position[0] !== start[i].position[0])) fail(`reset heights: ${k.doodads().map((d) => `${d.position[2]}/${d.flags}`).join(" ")}`);
  await k.run("w3.terrain.resetFixedObjectHeights");
  if (await page.evaluate(`w3.editors.isDirty("map/war3map.doo.json") || w3.editors.unsavedPaths().length > 0`)) fail("a reset with nothing fixed made a change");
  await k.run("workbench.undo");
  await k.save();
  if (k.doodads().some((d) => d.position[2] !== 150 || !(d.flags & k.FIXED))) fail("one undo didn't take Reset Fixed Object Heights back");
  await k.run("workbench.redo");
  await k.save();
  await k.verify(fail);
}

/** Three things of the terrain viewer that only the real app shows:
 *  - the Camera Objects layer draws a camera made in the Cameras tab before it is saved (the layer against itself off,
 *    and the file on disk still without it, show it's the unsaved one);
 *  - terrain_screenshot, in a project with two terrain files, takes the tab in front and doesn't switch to the other;
 *  - a click on an object without a model (drawn as the World Editor's checkered cube) selects it, as a selection box does. */
async function terrainSelectCameras(page, found) {
  const fail = (what) => found.push(`terrain select and cameras: ${what}`);
  const k = await heightKit(page, "SelectCameras");
  const TXT = "map/war3map.w3e.txt", BIN = "map/war3map.w3e";
  const active = () => page.evaluate(`w3.editors.activePath()`);
  const cameras = () => k.read("war3map.w3c.json").cameras ?? [];

  // Cameras: a still picture (no water, no animation), the plain view against itself first.
  await page.evaluate(`w3.settings.set("terrain.animate", false)`);
  await page.evaluate(`[...document.querySelectorAll(".model-toggle")].filter((l) => ["Water", "Effects"].includes(l.textContent.trim()) && l.querySelector("input").checked).forEach((l) => l.querySelector("input").click())`);
  await k.tab("Select");
  await k.look(0, 0);
  await k.clearToasts();
  await sleep(1500);
  await mapPicture(page);
  const plain = await mapPicture(page), noise = await pixelsApart(page, plain, await mapPicture(page));
  if (noise > 200) fail(`the same view gave two pictures ${noise} pixels apart`);
  if (cameras().length) fail(`a new map has ${cameras().length} cameras`);
  await k.tab("Cameras");
  await page.evaluate(`[...document.querySelectorAll(".terrain-group-tools button")].find((b) => b.textContent === "Create from view").click()`);
  await sleep(300);
  // Back on Select, the Cameras tab draws nothing of its own: what shows is the layer.
  await k.tab("Select");
  const err = await k.run("w3.terrain.toggleCameraObjects");
  if (err) fail(`Toggle Camera Objects: ${err}`);
  const shown = await pixelsApart(page, plain, await mapPicture(page));
  await k.run("w3.terrain.toggleCameraObjects");
  if (cameras().length) fail("the camera was saved before the picture, so the picture proves nothing");
  else if (shown < 150 + noise) fail(`the Camera Objects layer doesn't show the unsaved camera (${shown} pixels changed, noise ${noise})`);
  await k.save();
  if (cameras().length !== 1) fail(`saved, the map has ${cameras().length} cameras`);

  // Two terrain files: the binary one, from the packed map, next to the text one.
  const map = join(work, "heights", "SelectCameras.w3x");
  const packed = spawnSync(cli, ["pack", k.root, "-o", map], { encoding: "utf8" });
  const w3e = packed.status === 0 ? spawnSync(cli, ["cat", map, "war3map.w3e"]) : null;
  if (!w3e || w3e.status !== 0 || !w3e.stdout.length) return fail(`no binary war3map.w3e: ${packed.stderr}${w3e?.stderr ?? ""}`);
  writeFileSync(join(k.root, "map", "war3map.w3e"), w3e.stdout);
  await page.evaluate(`w3.workspace.refresh()`);
  for (const path of [BIN, TXT]) {
    await page.evaluate(`w3.editors.open(${JSON.stringify(path)}, "w3.terrainViewer")`);
    await until(`the editor of ${path}`, async () => (await active()) === path, 30000);
  }
  await sleep(1000);
  await k.tool("terrain_screenshot", { maxSize: 64 }).catch((e) => fail(e.message));
  if ((await active()) !== TXT) fail(`terrain_screenshot switched from the text terrain's tab to ${await active()}`);
  await k.tool("terrain_screenshot", { maxSize: 64, file: BIN }).catch((e) => fail(`with file: ${e.message}`));
  if ((await active()) !== BIN) fail(`terrain_screenshot of ${BIN} left ${await active()} in front`);
  const wrong = await k.tool("terrain_screenshot", { maxSize: 64, file: "map/war3map.j" }).then(() => null, (e) => e.message);
  if (!wrong || !/terrain files/.test(wrong)) fail(`terrain_screenshot of a file that isn't terrain: ${wrong ?? "a picture"}`);
  await page.evaluate(`w3.editors.closeAll()`);
  rmSync(join(k.root, "map", "war3map.w3e"));
  await page.evaluate(`w3.workspace.refresh()`);

  // An object without a model: a footman given an id no table knows, written as another tool would.
  await k.tool("place_objects", { objects: [{ id: "hfoo", x: 512, y: 512, player: 1 }], ignoreRoom: true });
  await k.save();
  const units = k.read("war3mapUnits.doo.json");
  for (const u of units.units) if (u.id === "hfoo") { u.id = "Zzzz"; if (u.skinId !== undefined) u.skinId = "Zzzz"; }
  await page.evaluate(`w3.workspace.writeText("map/war3mapUnits.doo.json", ${JSON.stringify(JSON.stringify(units))})`);
  await page.evaluate(`w3.commands.execute("w3.terrain.open")`);
  await until("the terrain editor", async () => (await active()) === TXT, 20000);
  await k.tab("Select");
  await k.look(512, 512);
  const at = `(() => { const i = document.querySelectorAll(".terrain-sel-triple input"); return i.length >= 2 ? [Number(i[0].value), Number(i[1].value)] : null; })()`;
  const name = `document.querySelector(".terrain-sel-name")?.textContent ?? ""`;
  if (await page.evaluate(at)) fail("something was selected before the click");
  // Clicked until it's selected: the cube is drawn once the reloaded file is in. A click that can't select it never will.
  await until("Zzzz selected by a click on its cube", async () => {
    await k.clickMiddle();
    await sleep(300);
    const p = await page.evaluate(at);
    return p && Math.abs(p[0] - 512) <= 32 && Math.abs(p[1] - 512) <= 32 && (await page.evaluate(name)) === "Zzzz";
  }, 20000).catch(async (e) => fail(`${e.message} (the selection: ${JSON.stringify(await page.evaluate(at))} "${await page.evaluate(name)}")`));
  await page.evaluate(`w3.editors.closeAll()`);
}

/** The World Editor's View items in the terrain view (viewmodes.ts), by their keys in the map: game view (V) hides the
 *  start location, the regions and the other editor marks and shows its badge, refuses the layer toggles while on,
 *  stays for the next editor (a setting) and brings the choice back when off; Ctrl+R shows the regions instead of
 *  reloading the window; Ctrl+T goes round the terrain's looks; Ctrl+D, Ctrl+U, P and Ctrl+Shift+L show and hide
 *  doodads, units, ground pathing and light ranges, the toolbar's and the side panel's boxes follow, and none of it is
 *  an edit. Judged on pictures of the view against the plain one (the same view twice is the noise). */
async function viewModes(page, found) {
  const fail = (what) => found.push(`view modes: ${what}`);
  const k = await heightKit(page, "ViewModes");
  const TXT = "map/war3map.w3e.txt";
  const state = () => page.evaluate(`(async () => (await w3.services.get("w3.terrain")).viewCommands.get(w3.editors.activePath())?.state() ?? null)()`);
  const key = async (name, code, vk, modifiers = 0) => { await k.focusMap(); await k.hands.key(name, code, vk, modifiers); await sleep(400); };
  const CTRL = 2, SHIFT = 8;
  // A tree and a lit brazier (LObz: a light reaching 200) west of the start location, a footman east of it, a region north.
  await k.tool("place_objects", { objects: [{ id: "LTlt", x: -384, y: 0 }, { id: "LObz", x: -384, y: -384 }], ignoreRoom: true });
  await k.tool("place_objects", { objects: [{ id: "hfoo", x: 384, y: 0, player: 1 }], ignoreRoom: true });
  await k.save();
  const start = k.units().find((u) => u.id === "sloc");
  if (!start) return fail("the new map has no start location");
  const regions = k.read("war3map.w3r.json");
  regions.regions = [{ left: -256, bottom: 256, right: 256, top: 640, name: "Smoke Region", index: 0, weather: "0x00000000", sound: "", color: { red: 255, green: 60, blue: 60, alpha: 255 }, ...(regions.version >= 7 ? { trailer: [0, 0] } : {}) }];
  await page.evaluate(`w3.workspace.writeText("map/war3map.w3r.json", ${JSON.stringify(JSON.stringify(regions))})`);
  await page.evaluate(`w3.settings.set("terrain.animate", false)`);
  await page.evaluate(`[...document.querySelectorAll(".model-toggle")].filter((l) => ["Water", "Effects"].includes(l.textContent.trim()) && l.querySelector("input").checked).forEach((l) => l.querySelector("input").click())`);
  await k.tab("Select");
  await k.look(start.position[0], start.position[1] + 128);
  await k.clearToasts();
  await sleep(1500);
  await mapPicture(page);
  let plain = await mapPicture(page), noise = await pixelsApart(page, plain, await mapPicture(page));
  if (noise > 200) return fail(`the same view gave two pictures ${noise} pixels apart`);
  const changed = async () => (await pixelsApart(page, plain, await mapPicture(page))) - noise;
  // The window isn't reloaded by Ctrl+R in the map: this stays.
  await page.evaluate(`window.__viewModesMark = 1`);

  // Game view by its key: the start location and its town hall go, the badge shows, the boxes grey out.
  await key("v", "KeyV", 86);
  let s = await state();
  if (!s?.gameView || s.shown.starts || !s.shown.lighting || !s.shown.fog) fail(`V didn't turn game view on: ${JSON.stringify(s && { gameView: s.gameView, shown: s.shown })}`);
  if ((await k.setting("terrain.gameView")) !== true) fail("game view isn't kept as the setting terrain.gameView");
  if (!(await page.evaluate(`!document.querySelector(".terrain-gameview-badge")?.hidden`))) fail("no Game View badge over the view");
  if ((await changed()) < 300) fail("game view didn't change the picture (the start location should be gone)");
  if (!(await page.evaluate(`[...document.querySelectorAll(".model-toggle")].find((l) => l.textContent.trim() === "Regions")?.querySelector("input")?.disabled`))) fail("the Regions box can be used in game view");
  // View > Shadows is greyed in game view, as in the World Editor.
  if (!(await page.evaluate(`[...document.querySelectorAll(".model-toggle")].find((l) => l.textContent.trim() === "Shadows")?.querySelector("input")?.disabled`))) fail("the Shadows box can be used in game view");
  const refused = await page.evaluate(`(async () => (await w3.services.get("w3.terrain")).viewCommands.get(w3.editors.activePath()).toggleLayer("regions"))()`);
  if (typeof refused !== "string" || (await state()).regions) fail(`a layer toggle in game view: ${JSON.stringify(refused)}`);
  // The start location can't be picked where it isn't drawn.
  await k.look(start.position[0], start.position[1]);
  await k.clickMiddle();
  await sleep(300);
  if (await page.evaluate(`document.querySelector(".terrain-sel-name")?.textContent === "Start location"`)) fail("the hidden start location was selected by a click");
  // Remembered: the next editor opens in game view.
  await page.evaluate(`w3.editors.closeAll()`);
  await page.evaluate(`w3.commands.execute("w3.terrain.open")`);
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === ${JSON.stringify(TXT)}`), 20000);
  await sleep(500);
  s = await state();
  if (!s?.gameView || s.shown.starts) fail("a terrain editor opened again isn't in game view");
  await page.evaluate(`[...document.querySelectorAll(".model-toggle")].filter((l) => ["Water", "Effects"].includes(l.textContent.trim()) && l.querySelector("input").checked).forEach((l) => l.querySelector("input").click())`);
  await k.tab("Select");
  await k.look(start.position[0], start.position[1] + 128);
  await key("v", "KeyV", 86);
  s = await state();
  if (s.gameView || !s.shown.starts || (await k.setting("terrain.gameView")) !== false) fail("V again didn't turn game view off");
  if (!(await page.evaluate(`document.querySelector(".terrain-gameview-badge")?.hidden`))) fail("the badge stays after game view");
  await k.clearToasts();
  if ((await changed()) > 150) fail("after game view the picture isn't the plain one again");

  /** A View key: the state (against `s`, taken before) changes and the picture by at least `least` pixels. */
  const trial = async (label, field, press, least) => {
    await press();
    const on = await state();
    if (on[field] === s[field]) fail(`${label} didn't change ${field} (${JSON.stringify(on[field])})`);
    const diff = await changed();
    if (diff < least) fail(`${label} changed ${diff} pixels`);
    return on;
  };
  s = await state();
  await trial("Ctrl+R", "regions", () => key("r", "KeyR", 82, CTRL), 500);
  if (!(await page.evaluate(`window.__viewModesMark === 1`))) fail("Ctrl+R in the map reloaded the window");
  await key("r", "KeyR", 82, CTRL);
  if ((await changed()) > 150) fail("Ctrl+R twice isn't the plain picture");
  // The Regions tab draws the regions itself, and the Pathing tab the ground pathing: the box and the state say they're
  // shown, and the layer can't be turned off under the tab; back on Select it's the choice again, off or on as it was.
  const toggleUnder = (layer) => page.evaluate(`(async () => (await w3.services.get("w3.terrain")).viewCommands.get(w3.editors.activePath()).toggleLayer(${JSON.stringify(layer)}))()`);
  for (const [tab, label, layer, before] of [["Regions", "Regions", "regions", false], ["Pathing", "Ground pathing", "pathing", false], ["Pathing", "Ground pathing", "pathing", true]]) {
    const what = `the ${tab} tab (${label} ${before ? "on" : "off"} before)`;
    const layerBox = `(() => { const i = [...document.querySelectorAll(".model-toggle")].find((l) => l.textContent.trim() === ${JSON.stringify(label)})?.querySelector("input"); return i ? { checked: i.checked, disabled: i.disabled } : null; })()`;
    if (before && (await toggleUnder(layer)) !== true) { fail(`${label} couldn't be turned on before ${what}`); continue; }
    await k.tab(tab);
    let rb = await page.evaluate(layerBox), rs = await state();
    if (!rb?.checked || !rb.disabled || !rs[layer] || !rs.shown[layer]) fail(`with ${what} open the ${label} box is ${JSON.stringify(rb)} and the state ${rs[layer]}/${rs.shown[layer]}`);
    const underTab = await toggleUnder(layer);
    if (typeof underTab !== "string") fail(`the ${label} layer toggled under ${what}: ${JSON.stringify(underTab)}`);
    await k.tab("Select");
    rb = await page.evaluate(layerBox);
    rs = await state();
    if (rb?.checked !== before || rb?.disabled || rs[layer] !== before || rs.shown[layer] !== before) fail(`back on Select after ${what} the ${label} box is ${JSON.stringify(rb)} and the state ${rs[layer]}/${rs.shown[layer]}`);
    if (before) await toggleUnder(layer);
  }
  s = await state();
  let t = await trial("Ctrl+T", "terrain", () => key("t", "KeyT", 84, CTRL), 20000);
  if (t.terrain !== "wireframe") fail(`Ctrl+T gave ${t.terrain}`);
  await key("t", "KeyT", 84, CTRL);
  if ((await state()).terrain !== "hidden") fail("Ctrl+T twice isn't hidden terrain");
  await key("t", "KeyT", 84, CTRL);
  if ((await state()).terrain !== "textured" || (await changed()) > 150) fail("Ctrl+T three times isn't the textured picture again");
  for (const [label, field, press, least, at] of [
    ["Ctrl+U", "units", () => key("u", "KeyU", 85, CTRL), 300],
    // The tree in the middle of the view and zoomed in: seen from the start location it was under a hundred pixels, as
    // near the noise as the threshold was (round 4). Close up the tree and its shadow image make about 670.
    ["Ctrl+D", "doodads", () => key("d", "KeyD", 68, CTRL), 300, [-384, 0]],
    ["P", "pathing", () => key("p", "KeyP", 80), 300],
    ["Ctrl+Shift+L", "lightRanges", () => key("L", "KeyL", 76, CTRL | SHIFT), 100],
  ]) {
    if (at) {
      await k.look(at[0], at[1]);
      for (let i = 0; i < 3; i++) await key("ArrowUp", "ArrowUp", 38, CTRL);
      await sleep(800);
      await mapPicture(page);
      plain = await mapPicture(page);
      noise = await pixelsApart(page, plain, await mapPicture(page));
    }
    s = await state();
    const on = await trial(label, field, press, least);
    // Hidden doodads leave no shadow images on the ground (the tree's and the brazier's).
    if (field === "doodads" && !(s.shadowImages >= 1 && on.shadowImages === 0)) fail(`Ctrl+D left shadow images on the ground: ${s.shadowImages} before, ${on.shadowImages} after`);
    if (field === "units" && await page.evaluate(`[...document.querySelectorAll(".model-side label.model-row")].find((l) => /Units/.test(l.textContent))?.querySelector("input")?.checked`)) fail("the side panel's Units box didn't follow Ctrl+U");
    await press();
    if ((await changed()) > 150) fail(`${label} twice isn't the plain picture`);
    if (at) {
      for (let i = 0; i < 3; i++) await key("ArrowDown", "ArrowDown", 40, CTRL);
      await k.look(start.position[0], start.position[1] + 128);
      await sleep(800);
      await mapPicture(page);
      plain = await mapPicture(page);
      noise = await pixelsApart(page, plain, await mapPicture(page));
    }
  }
  // The camera keys, with nothing selected (viewmodes.ts cameraKey): Up scrolls north, Shift+Up further, Ctrl+Up and
  // Ctrl+Down zoom in and back, Ctrl+Left turns; Page Up moves nothing.
  await key("Escape", "Escape", 27);
  const cam = async () => (await state()).camera;
  let c0 = await cam();
  await key("ArrowUp", "ArrowUp", 38);
  let c1 = await cam();
  const step = c1.target[1] - c0.target[1];
  if (!(step > 0) || Math.abs(c1.target[0] - c0.target[0]) > 1) fail(`Up moved the camera by ${c1.target[0] - c0.target[0]}, ${step}`);
  await key("ArrowUp", "ArrowUp", 38, SHIFT);
  const c2 = await cam();
  if (!(c2.target[1] - c1.target[1] > 3 * step)) fail(`Shift+Up moved ${c2.target[1] - c1.target[1]}, Up ${step}`);
  c0 = await cam();
  await key("ArrowUp", "ArrowUp", 38, CTRL);
  c1 = await cam();
  if (!(c1.distance < c0.distance) || Math.hypot(c1.target[0] - c0.target[0], c1.target[1] - c0.target[1]) > 1) fail(`Ctrl+Up: distance ${c0.distance} → ${c1.distance}`);
  await key("ArrowDown", "ArrowDown", 40, CTRL);
  if (Math.abs((await cam()).distance - c0.distance) > 1e-6 * c0.distance) fail("Ctrl+Down didn't undo Ctrl+Up's zoom");
  await key("ArrowLeft", "ArrowLeft", 37, CTRL);
  if (!((await cam()).yaw > c0.yaw)) fail("Ctrl+Left didn't turn the view");
  await key("ArrowRight", "ArrowRight", 39, CTRL);
  c1 = await cam();
  await key("PageUp", "PageUp", 33);
  const c3 = await cam();
  if (c3.distance !== c1.distance || c3.target.join() !== c1.target.join() || c3.yaw !== c1.yaw) fail("Page Up moved the camera with nothing selected");

  // The toolbar's box is the same item as the key.
  await k.hands.click(".model-toggle", "Light ranges");
  if (!(await state()).lightRanges) fail("the Light ranges box didn't turn them on");
  await k.hands.click(".model-toggle", "Light ranges");
  // Looking isn't editing.
  await sleep(300);
  if (await page.evaluate(`w3.editors.isDirty(${JSON.stringify(TXT)}) || w3.editors.unsavedPaths().length > 0`)) fail("the View keys left unsaved changes");
  await page.evaluate(`w3.settings.set("terrain.gameView", undefined, "user")`);
  await page.evaluate(`w3.editors.closeAll()`);
}

/** Unit Properties in the Selection panel (propspanel.ts), typed and chosen in the hidden window: a hero's hit points,
 *  level, a skill, its attributes and an item picked into its inventory; a gold mine's gold; a waygate's destination and
 *  colour; a destructable's life; drops for everything at once after Ctrl+A. Showing the panel changes nothing, values
 *  not edited keep their defaults (-1), a refused value leaves no change and no undo step, each edit is one undo step,
 *  and the packed map verifies. The unit file gets the layout with hero attributes and item tables (subversion 11, as
 *  the World Editor saves an 8/11 map), the map an item table and a region. */
async function unitProperties(page, found) {
  const fail = (what) => found.push(`unit properties: ${what}`);
  const k = await heightKit(page, "UnitProps");
  const TXT = "map/war3map.w3e.txt";
  await k.tool("place_objects", { objects: [{ id: "Hpal", x: 0, y: 0, player: 1 }, { id: "ngol", x: 768, y: 0 }, { id: "nwgt", x: 0, y: 768 }, { id: "hfoo", x: 768, y: 768, player: 1 }], ignoreRoom: true });
  await k.tool("place_objects", { objects: [{ id: "LTlt", x: -768, y: 0 }], ignoreRoom: true });
  await k.save();
  const units = k.read("war3mapUnits.doo.json"), info = k.read("war3map.w3i.json"), regions = k.read("war3map.w3r.json");
  if (!Array.isArray(info.itemTables)) return fail(`a new map's war3map.w3i has no item tables: ${Object.keys(info).join(", ")}`);
  units.subversion = 11;
  units.units = units.units.map((u) => {
    const out = {};
    for (const [key, v] of Object.entries(u)) {
      out[key] = v;
      if (key === "mana") out.itemTable = -1;
      if (key === "level") Object.assign(out, { strength: 0, agility: 0, intelligence: 0 });
    }
    return out;
  });
  info.itemTables = [{ number: 3, name: "Smoke Loot", sets: [[{ chance: 100, id: "ratf" }]] }];
  regions.regions.push({ left: 512, bottom: 512, right: 640, top: 640, name: "Smoke Gate", index: 0, weather: "0x00000000", sound: "",
    color: { blue: 255, green: 128, red: 128, alpha: 255 }, ...(regions.version >= 7 ? { trailer: [0, 0] } : {}) });
  await page.evaluate(`w3.editors.closeAll()`);
  for (const [file, doc] of [["war3mapUnits.doo.json", units], ["war3map.w3i.json", info], ["war3map.w3r.json", regions]]) {
    await page.evaluate(`w3.workspace.writeText(${JSON.stringify(`map/${file}`)}, ${JSON.stringify(JSON.stringify(doc, null, 2))})`);
  }
  await page.evaluate(`w3.commands.execute("w3.terrain.open")`);
  await until("the terrain editor", async () => (await page.evaluate(`w3.editors.activePath()`)) === TXT, 20000);
  await k.tab("Select");

  const at = (prop) => `.terrain-props [data-prop="${prop}"]`;
  const value = (prop) => page.evaluate(`document.querySelector(${JSON.stringify(at(prop))})?.value ?? null`);
  const shown = (prop) => page.evaluate(`!!document.querySelector(${JSON.stringify(at(prop))})`);
  const panel = () => until("the properties panel", () => page.evaluate(`!!document.querySelector(".terrain-props")`), 20000);
  /** After a change the objects are drawn again and the panel made anew. */
  const settled = async () => { await sleep(700); await panel(); };
  const select = async (ref) => { await k.look(ref.x, ref.y, ref); await panel(); };
  const typeInto = async (prop, text) => { await retype(k.hands, at(prop), text); await settled(); };
  const choose = async (prop, v) => {
    await page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(at(prop))}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change")); })()`);
    await settled();
  };
  const dirty = () => page.evaluate(`w3.editors.isDirty(${JSON.stringify(TXT)})`);
  const undo = async () => { await page.evaluate(`w3.commands.execute("workbench.undo")`); await settled(); };
  const unit = (id) => k.units().find((u) => u.id === id);

  // The hero: what applies shows, what doesn't (gold, colour) doesn't; showing it changes nothing.
  const before = hash(join(k.root, "map", "war3mapUnits.doo.json"));
  await select({ id: "Hpal", x: 0, y: 0 });
  for (const p of ["hp", "mana", "level", "attr-default", "skill-AHhb", "slot-5", "acquire", "drops-mode"]) if (!(await shown(p))) fail(`the Paladin's ${p} isn't shown`);
  for (const p of ["gold", "color", "waygate", "life"]) if (await shown(p)) fail(`the Paladin shows ${p}`);
  // Its skills in the World Editor's order: Resurrection, the ultimate, last (the game's table has it third).
  const skillOrder = await page.evaluate(`[...document.querySelectorAll('.terrain-props [data-prop^="skill-"]')].map((e) => e.dataset.prop).join()`);
  if (skillOrder !== "skill-AHhb,skill-AHds,skill-AHad,skill-AHre") fail(`the Paladin's skills are listed ${skillOrder}, the World Editor lists the ultimate last`);
  if (await dirty()) fail("selecting the Paladin and showing its properties made the map changed");
  await k.save();
  if (hash(join(k.root, "map", "war3mapUnits.doo.json")) !== before) fail("saving after only looking changed war3mapUnits.doo");

  await typeInto("hp", "40");
  if (!(await dirty())) fail("a property edit didn't mark the map changed");
  await typeInto("level", "3");
  await typeInto("skill-AHhb", "2");
  await k.hands.click(at("attr-default"));
  await settled();
  await typeInto("attr-0", "30");
  await k.save();
  let h = unit("Hpal");
  if (h.hp !== 40 || h.level !== 3 || h.strength !== 30 || !(h.agility > 0 && h.intelligence > 0)) fail(`the Paladin after the edits: ${JSON.stringify([h.hp, h.level, h.strength, h.agility, h.intelligence])}`);
  if (JSON.stringify(h.abilities) !== JSON.stringify([{ id: "AHhb", autocast: 0, level: 2 }])) fail(`the Paladin's skills: ${JSON.stringify(h.abilities)}`);
  if (h.mana !== -1 || h.itemTable !== -1 || h.color !== -1 || h.targetAcquisition !== -1 || h.itemSets.length) fail(`values not edited lost their defaults: ${JSON.stringify([h.mana, h.itemTable, h.color, h.targetAcquisition, h.itemSets])}`);

  // An item picked with the object browser goes into the slot.
  await k.hands.click(at("slot-0"));
  await until("the item browser", () => page.evaluate(`document.querySelectorAll(".picker-rows > *").length > 5`), 20000);
  await k.hands.click("input.picker-search");
  await k.hands.type("ankh");
  await sleep(300);
  await k.hands.key("Enter", "Enter", 13);
  await settled();
  await k.save();
  if (JSON.stringify(unit("Hpal").inventory) !== JSON.stringify([{ slot: 0, id: "ankh" }])) fail(`the Paladin's inventory: ${JSON.stringify(unit("Hpal").inventory)}`);
  // One undo takes the item back, and only that.
  await undo();
  await k.save();
  h = unit("Hpal");
  if (h.inventory.length || h.strength !== 30) fail(`one undo after the item: ${JSON.stringify([h.inventory, h.strength])}`);
  // A value out of range is refused whole: nothing changes, and the next undo is the strength's again, back to what
  // unchecking Default gave it (the Paladin's at level 3: 22 + 2 × 2.7).
  await typeInto("hp", "150");
  await k.save();
  if (unit("Hpal").hp !== 40) fail(`hit points 150 % were taken: ${unit("Hpal").hp}`);
  if (Number(await value("hp")) !== 40) fail(`after the refusal the box shows ${await value("hp")}, not the hit points`);
  await k.clearToasts();
  await undo();
  await k.save();
  if (unit("Hpal").strength !== 27 || unit("Hpal").hp !== 40) fail(`the undo after a refused value: ${JSON.stringify([unit("Hpal").strength, unit("Hpal").hp])}`);
  await undo();
  await k.save();
  if (unit("Hpal").strength !== 0) fail(`two undos: the attributes aren't the default again (${unit("Hpal").strength})`);

  // A gold mine has gold and no hit points; a waygate a destination and a colour.
  await select({ id: "ngol", x: 768, y: 0 });
  if (await shown("hp")) fail("the gold mine shows hit points (the World Editor doesn't: it's invulnerable)");
  await typeInto("gold", "9000");
  await select({ id: "nwgt", x: 0, y: 768 });
  await choose("waygate", "0");
  await choose("color", "3");
  await k.save();
  if (unit("ngol").gold !== 9000) fail(`the gold mine's gold: ${unit("ngol").gold}`);
  if (unit("nwgt").waygate !== 0 || unit("nwgt").color !== 3) fail(`the waygate: ${JSON.stringify([unit("nwgt").waygate, unit("nwgt").color])}`);

  // A destructable's life, in war3map.doo.
  await select({ id: "LTlt", x: -768, y: 0 });
  await typeInto("life", "30");
  await k.save();
  const tree = k.doodads().find((d) => d.id === "LTlt");
  if (tree?.life !== 30) fail(`the tree's life: ${tree?.life}`);

  // A footman's Defend placed switched on (the World Editor's Active box): a level-0 entry with autocast 1, and one undo
  // takes it off again. The Paladin's skills have no box (its inventory can't be switched on).
  await select({ id: "hfoo", x: 768, y: 768 });
  if (!(await shown("active-Adef"))) fail("the footman's Defend has no Active box");
  else {
    await k.hands.click(at("active-Adef"));
    await settled();
    await k.save();
    if (JSON.stringify(unit("hfoo").abilities) !== JSON.stringify([{ id: "Adef", autocast: 1, level: 0 }])) fail(`the footman's Defend switched on: ${JSON.stringify(unit("hfoo").abilities)}`);
    if (!(await page.evaluate(`document.querySelector(${JSON.stringify(at("active-Adef"))})?.checked`))) fail("the Active box isn't ticked after the change");
    await undo();
    await k.save();
    if (unit("hfoo").abilities.length) fail(`one undo didn't take Defend's Active off: ${JSON.stringify(unit("hfoo").abilities)}`);
  }
  await select({ id: "Hpal", x: 0, y: 0 });
  if (await page.evaluate(`!!document.querySelector('.terrain-props [data-prop^="active-"]')`)) fail("the Paladin shows an Active box");

  // Everything at once (Ctrl+A): only what they all have, the drops; own sets, then the map's table, each one step.
  await k.focusMap();
  await k.hands.key("a", "KeyA", 65, 2);
  await until("the properties of the selection", () => page.evaluate(`/objects/.test(document.querySelector(".terrain-props legend")?.textContent ?? "")`), 20000);
  if (await shown("hp") || await shown("gold")) fail("several objects of different kinds show fields not all of them have");
  await choose("drops-mode", "custom");
  await choose("drops-mode", "table");
  await k.save();
  const dropping = () => [...k.units().filter((u) => u.id !== "sloc"), ...k.doodads()];
  if (!dropping().every((o) => o.itemTable === 3 && o.itemSets.length === 0)) fail(`drops from the map's table: ${JSON.stringify(dropping().map((o) => [o.id, o.itemTable, o.itemSets]))}`);
  await undo();
  await k.save();
  if (!dropping().every((o) => o.itemTable === -1 && JSON.stringify(o.itemSets) === "[[]]")) fail(`one undo back to own (empty) sets: ${JSON.stringify(dropping().map((o) => [o.id, o.itemTable, o.itemSets]))}`);
  if (unit("sloc") && JSON.stringify(unit("sloc").itemSets) !== "[]") fail("the start location took drops");

  // The same through the AI tool set_object_properties: what the panel offers, with its checks, all or nothing.
  const indexOf = (id) => k.units().findIndex((u) => u.id === id);
  const paladin = { index: indexOf("Hpal"), id: "Hpal" }, footman = { index: indexOf("hfoo"), id: "hfoo" };
  await k.tool("set_object_properties", { kind: "units", items: [paladin], properties: { level: 4, skills: { AHhb: 2, AHds: 1 }, hp: 60, inventory: [{ slot: 3, item: "ankh" }], active: {} } })
    .catch((e) => fail(`set_object_properties on the Paladin: ${e.message}`));
  h = unit("Hpal");
  if (h.level !== 4 || h.hp !== 60 || JSON.stringify(h.abilities) !== JSON.stringify([{ id: "AHhb", autocast: 0, level: 2 }, { id: "AHds", autocast: 0, level: 1 }]) || JSON.stringify(h.inventory) !== JSON.stringify([{ slot: 2, id: "ankh" }])) {
    fail(`set_object_properties on the Paladin wrote ${JSON.stringify([h.level, h.hp, h.abilities, h.inventory])}`);
  }
  const unitsBefore = hash(join(k.root, "map", "war3mapUnits.doo.json"));
  const refusals = [
    [[footman], { gold: 5 }, /hfoo has no gold/],
    [[paladin, footman], { level: 2 }, /Nothing was changed.*hfoo has no level/],
    [[paladin], { level: 5, hp: 0 }, /hp: Hit points go from 1 to 100/],
    [[footman], { active: { Ahea: true } }, /isn't one of this unit's abilities/],
  ];
  for (const [items, properties, why] of refusals) {
    const r = await k.tool("set_object_properties", { kind: "units", items, properties }).then(() => "accepted", (e) => e.message);
    if (!why.test(r)) fail(`set_object_properties ${JSON.stringify(properties)}: ${r}`);
  }
  if (hash(join(k.root, "map", "war3mapUnits.doo.json")) !== unitsBefore) fail("a refused set_object_properties changed war3mapUnits.doo");
  await k.verify(fail);
  await page.evaluate(`w3.editors.closeAll()`);
  // This check views a gold mine and a tree with the game's tables read: kept, they'd leave gameReadsOnce's scene
  // nothing to read from the game (its control). The game's files are forgotten, as after a patch.
  await page.evaluate(`w3Workbench.game.reload()`);
}

/** Item tables for unit drops, reached from where they're used: the unit file's older layout (no item table field) offers
 *  only own sets and says why; with the newer layout and no tables, choosing "Map item table" offers to make one, which
 *  Map Properties makes (one undo step there) and opens for editing, and the footman then drops from it (one undo step in
 *  the terrain editor). "Edit item tables…", "or use a map item table…" and the command Item Tables… open Map Properties
 *  at the item tables. */
async function itemTablesAccess(page, found) {
  const fail = (what) => found.push(`item tables: ${what}`);
  const k = await heightKit(page, "ItemTables");
  const TXT = "map/war3map.w3e.txt", W3I = "map/war3map.w3i.json";
  await k.tool("place_objects", { objects: [{ id: "hfoo", x: 0, y: 0, player: 1 }], ignoreRoom: true });
  await k.save();
  const at = (prop) => `.terrain-props [data-prop="${prop}"]`;
  const shown = (prop) => page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(at(prop))}); return !!e && !e.closest("[hidden]"); })()`);
  const value = (prop) => page.evaluate(`document.querySelector(${JSON.stringify(at(prop))})?.value ?? null`);
  const options = (prop) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${at(prop)} option`)})].map((o) => o.value)`);
  const panel = () => until("the properties panel", () => page.evaluate(`!!document.querySelector(${JSON.stringify(at("drops-mode"))})`), 20000);
  const settled = async () => { await sleep(700); await panel(); };
  const choose = async (prop, v) => {
    await page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(at(prop))}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change")); })()`);
    await sleep(300);
  };
  const active = () => page.evaluate(`w3.editors.activePath()`);
  const dirty = (path) => page.evaluate(`w3.editors.isDirty(${JSON.stringify(path)})`);
  const toTerrain = async () => { await page.evaluate(`w3.editors.open(${JSON.stringify(TXT)})`); await until("the terrain editor in front", async () => (await active()) === TXT, 20000); };
  const footman = () => k.units().find((u) => u.id === "hfoo");
  /** Map Properties in front, at Techtree & Tables, with the item tables (or one of them) scrolled into its view. */
  const atItemTables = async (how, anchor = "item-tables") => {
    await until(`Map Properties in front (${how})`, async () => (await active()) === W3I, 20000).catch((e) => fail(e.message));
    const where = await page.evaluate(`(() => {
      const pane = [...document.querySelectorAll(".editor-pane")].find((p) => !p.hidden && p.querySelector(".map-info"));
      const section = pane?.querySelector(".form-nav-item.active")?.textContent ?? null;
      const target = pane ? [...pane.querySelectorAll("[data-anchor]")].find((x) => x.dataset.anchor === ${JSON.stringify(anchor)}) : null;
      if (!target) return { section, target: false };
      let box = target.parentElement;
      while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
      const r = target.getBoundingClientRect(), v = (box ?? document.documentElement).getBoundingClientRect();
      return { section, target: true, inView: r.top >= v.top - 2 && r.top < v.bottom, focused: target.contains(document.activeElement) };
    })()`);
    if (where.section !== "Techtree & Tables" || !where.target || !where.inView) fail(`${how}: Map Properties isn't at ${anchor} (${JSON.stringify(where)})`);
    return where;
  };

  // The unit file of a new map: if it has the older layout, "Map item table" isn't offered, and the panel says why.
  await k.tab("Select");
  await k.look(0, 0, { id: "hfoo", x: 0, y: 0 });
  await panel();
  const oldLayout = !("itemTable" in footman());
  if (oldLayout) {
    if ((await options("drops-mode")).includes("table")) fail("a unit file without item tables offers \"Map item table\"");
    if (!(await shown("drops-hint")) || !/Reign of Chaos/.test(await page.evaluate(`document.querySelector(${JSON.stringify(at("drops-hint"))})?.textContent ?? ""`))) fail("the older layout doesn't say why only own sets are offered");
  }

  // The newer layout (subversion 11, as unitProperties makes it), and a map without item tables.
  const units = k.read("war3mapUnits.doo.json"), info = k.read("war3map.w3i.json");
  if (!Array.isArray(info.itemTables)) return fail(`a new map's war3map.w3i has no item tables: ${Object.keys(info).join(", ")}`);
  units.subversion = 11;
  units.units = units.units.map((u) => {
    const out = {};
    for (const [key, v] of Object.entries(u)) {
      out[key] = v;
      if (key === "mana" && !("itemTable" in u)) out.itemTable = -1;
      if (key === "level" && !("strength" in u)) Object.assign(out, { strength: 0, agility: 0, intelligence: 0 });
    }
    return out;
  });
  info.itemTables = [];
  await page.evaluate(`w3.editors.closeAll()`);
  for (const [file, doc] of [["war3mapUnits.doo.json", units], ["war3map.w3i.json", info]]) {
    await page.evaluate(`w3.workspace.writeText(${JSON.stringify(`map/${file}`)}, ${JSON.stringify(JSON.stringify(doc, null, 2))})`);
  }
  await page.evaluate(`w3.commands.execute("w3.terrain.open")`);
  await until("the terrain editor", async () => (await active()) === TXT, 20000);
  await k.tab("Select");
  await k.look(0, 0, { id: "hfoo", x: 0, y: 0 });
  await panel();
  if (await shown("drops-hint")) fail("the newer layout still says only own sets can be given");
  if (!(await options("drops-mode")).includes("table")) return fail("the newer layout doesn't offer \"Map item table\"");

  // No tables yet: choosing one offers to make one, and changes nothing by itself.
  if (await shown("table-offer")) fail("the offer to make an item table shows before \"Map item table\" was chosen");
  await choose("drops-mode", "table");
  if (!(await shown("table-offer"))) return fail("choosing \"Map item table\" with no tables doesn't offer to make one");
  if ((await value("drops-mode")) !== "none") fail(`with no table made the drops show ${await value("drops-mode")}`);
  if (await dirty(TXT)) fail("choosing \"Map item table\" with no tables changed the map");
  await k.hands.click(at("create-table"));
  const made = await atItemTables("Create an item table", "item-table-0");
  if (!made.focused) fail("the new item table isn't open for editing (its name box hasn't the keys)");
  if (!(await dirty(W3I))) fail("making an item table didn't leave Map Properties changed");
  await until("the footman to drop from the new table", () => dirty(TXT), 10000).catch(() => fail("the footman wasn't given the new table (the terrain editor is unchanged)"));
  // Making it is one undo step in Map Properties: undone, the table goes and nothing is left to save; redone, it's back.
  // (Before saving: a save of the terrain opens Map Properties again, as it does for the start locations it shows.)
  const tableShown = () => page.evaluate(`[...document.querySelectorAll(".map-info [data-anchor]")].some((x) => x.dataset.anchor === "item-table-0")`);
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await sleep(300);
  if (await tableShown() || await dirty(W3I)) fail(`one undo in Map Properties after Create: the table ${await tableShown() ? "is still there" : "went"}, the editor ${await dirty(W3I) ? "is" : "isn't"} changed`);
  await page.evaluate(`w3.commands.execute("workbench.redo")`);
  await sleep(300);
  if (!(await tableShown()) || !(await dirty(W3I))) fail("a redo in Map Properties didn't bring the new table back");
  await k.save();
  const table = k.read("war3map.w3i.json").itemTables;
  if (JSON.stringify(table) !== JSON.stringify([{ number: 0, name: "Item Table", sets: [[]] }])) fail(`the map's item tables after Create: ${JSON.stringify(table)}`);
  if (footman().itemTable !== 0 || footman().itemSets.length) fail(`the footman after Create: ${JSON.stringify([footman().itemTable, footman().itemSets])}`);

  // Back in the terrain editor the footman shows the table by name, with the button that edits the tables.
  await toTerrain();
  await settled();
  if ((await value("drops-mode")) !== "table" || (await value("drops-table")) !== "0") fail(`the panel after Create: ${await value("drops-mode")} ${await value("drops-table")}`);
  if (!/Item Table \(#0\)/.test(await page.evaluate(`document.querySelector(${JSON.stringify(`${at("drops-table")} option:checked`)})?.textContent ?? ""`))) fail("the footman's table isn't shown by its name");
  if (!(await shown("edit-tables"))) fail("no \"Edit item tables…\" next to the map item table");
  else {
    // Map Properties shown at another section first: the button goes to the item tables all the same.
    await page.evaluate(`w3.commands.execute("w3.mapInfo.open", "description")`);
    await toTerrain();
    await settled();
    await k.hands.click(at("edit-tables"));
    await atItemTables("Edit item tables…");
  }

  // The command (palette and Scenario menu), from anywhere.
  if (!(await page.evaluate(`w3Workbench.commands.all().some((c) => c.id === "w3.mapInfo.itemTables" && c.title === "Item Tables…")`))) fail("the command palette has no Item Tables…");
  if (await page.evaluate(`w3Workbench.commands.all().some((c) => c.id === "w3.mapInfo.createItemTable")`)) fail("the palette lists the panel's Create an Item Table");
  await page.evaluate(`w3.commands.execute("w3.mapInfo.open", "players")`);
  await toTerrain();
  const ran = await k.run("w3.mapInfo.itemTables");
  if (ran) fail(`Item Tables…: ${ran}`);
  await atItemTables("Item Tables…");
  // Map Properties' own command takes the section and the place in it; a section it hasn't is refused.
  await page.evaluate(`w3.commands.execute("w3.mapInfo.open", "forces")`);
  await toTerrain();
  if (await k.run("w3.mapInfo.open", "techtree", "item-tables")) fail("w3.mapInfo.open with a section and anchor failed");
  await atItemTables("w3.mapInfo.open techtree item-tables");
  if (!/no section/.test(await k.run("w3.mapInfo.open", "nonsense") ?? "")) fail("w3.mapInfo.open took a section it hasn't");

  // Own sets: the link to the map's tables.
  await toTerrain();
  await settled();
  await choose("drops-mode", "custom");
  await settled();
  if (!(await shown("use-map-table"))) fail("own sets show no \"or use a map item table…\"");
  else {
    await toTerrain();
    await k.hands.click(at("use-map-table"));
    await atItemTables("or use a map item table…");
  }

  // Undo in the terrain editor: the table again, then the drops as before Create.
  await toTerrain();
  await settled();
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await settled();
  await k.save();
  if (footman().itemTable !== 0) fail(`one undo after own sets: the footman's table is ${footman().itemTable}`);
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await settled();
  await k.save();
  if (footman().itemTable !== -1 || footman().itemSets.length) fail(`the undo of the table's choice: ${JSON.stringify([footman().itemTable, footman().itemSets])}`);
  await k.verify(fail);
  await page.evaluate(`w3.editors.closeAll()`);
}

/** Units are drawn by their type, as the World Editor draws them: a gryphon at its flying height (UnitData moveHeight
 *  240) over the ground, a footman on it, whatever height the placement file holds; ground raised under the gryphon
 *  takes it along at once. Drawing them so writes nothing: saving after only looking leaves the units file as it was. */
async function flyingHeights(page, found) {
  const fail = (what) => found.push(`flying heights: ${what}`);
  const k = await heightKit(page, "Flying");
  await k.tool("place_objects", { objects: [{ id: "hgry", x: 0, y: 0, player: 1 }, { id: "hfoo", x: 512, y: 0, player: 1 }], ignoreRoom: true });
  await k.save();
  // The footman stored far above the ground, as another tool might write it: drawn on the ground all the same.
  const units = k.read("war3mapUnits.doo.json");
  const foot = units.units.find((u) => u.id === "hfoo"), gry = units.units.find((u) => u.id === "hgry");
  if (!foot || !gry) return fail(`placed: ${units.units.map((u) => u.id).join(", ")}`);
  const ground = gry.position[2];
  foot.position[2] = ground + 600;
  await page.evaluate(`w3.workspace.writeText("map/war3mapUnits.doo.json", ${JSON.stringify(JSON.stringify(units, null, 2))})`);
  await page.evaluate(`(async () => {
    const s = await w3.services.get("w3.terrain");
    window.__flyGroup?.dispose();
    window.__flyGroup = s.registerToolGroup({ id: "smoke-fly", title: "smoke-fly", order: 998, create: (ed) => { window.__flyEd = ed; return { toolbar: document.createElement("div") }; } });
  })()`);
  const drawn = (id) => page.evaluate(`window.__flyEd?.drawnUnits().find((u) => u.id === ${JSON.stringify(id)}) ?? null`);
  try {
    const reloaded = `(async () => (await w3.services.get("w3.terrain")).placedObjects()?.units.some((u) => u.id === "hfoo" && u.position[2] === ${ground + 600}) ?? false)()`;
    await until("the gryphon and the footman drawn", async () => (await page.evaluate(reloaded)) && (await drawn("hgry")) && (await drawn("hfoo")), 20000)
      .catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify([await drawn("hgry"), await drawn("hfoo")])}`); });
    // Drawn after the reload: a moment later.
    await sleep(500);
    const f = await drawn("hfoo"), g = await drawn("hgry");
    if (Math.abs(f.z - ground) > 1) fail(`the footman stored at ${ground + 600} is drawn at ${f.z}, not on the ground ${ground}`);
    if (Math.abs(g.z - (ground + 240)) > 1) fail(`the gryphon (stored at ${gry.position[2]}) is drawn at ${g.z}, not at its flying height 240 over the ground ${ground}`);
    const before = hash(join(k.root, "map", "war3mapUnits.doo.json"));
    await k.save();
    if (hash(join(k.root, "map", "war3mapUnits.doo.json")) !== before) fail("saving after only looking changed the units file");
    // The ground under the gryphon raised by 128 (the corners round (0, 0)), as a finished stroke: it flies along.
    const raised = await page.evaluate(`(() => {
      const ed = window.__flyEd, t = ed.terrain, cx = Math.round((0 - t.offsetX) / 128), cy = Math.round((0 - t.offsetY) / 128);
      const corners = [];
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) corners.push(y * t.width + x);
      const was = corners.map((i) => t.corners[i].height);
      const set = (d) => corners.forEach((i, n) => { t.corners[i].height = was[n] + d; });
      set(128);
      return ed.commitTerrain({ corners, undo: () => set(0), redo: () => set(128) });
    })()`);
    if (!raised) return fail("the raise was refused");
    const after = await drawn("hgry");
    if (Math.abs(after.z - (ground + 128 + 240)) > 1) fail(`with the ground raised by 128 the gryphon is drawn at ${after.z}, not ${ground + 128 + 240}`);
  } finally {
    await page.evaluate(`window.__flyGroup?.dispose(); window.__flyGroup = null; window.__flyEd = null;`);
  }
  await k.save();
  await page.evaluate(`w3.editors.closeAll()`);
}

/** The Cameras tab: two cameras selected with a click and a Shift+click show the values they share and an empty field
 *  where they differ; a value typed there goes to both as one undo step. Duplicate copies the selected cameras with new
 *  names, one step. A value typed for one camera shows through it in the view at once, before it's an edit. */
async function cameraEditing(page, found) {
  const fail = (what) => found.push(`camera editing: ${what}`);
  const k = await heightKit(page, "CameraEditing");
  const TXT = "map/war3map.w3e.txt", SHIFT = 8;
  const cameras = () => k.read("war3map.w3c.json").cameras ?? [];
  const dirty = () => page.evaluate(`w3.editors.isDirty(${JSON.stringify(TXT)}) || w3.editors.unsavedPaths().length > 0`);
  const view = () => page.evaluate(`(async () => (await w3.services.get("w3.terrain")).viewCommands.get(${JSON.stringify(TXT)})?.state().camera ?? null)()`);
  const button = (label) => page.evaluate(`(() => { const b = [...document.querySelectorAll(".terrain-group-tools button")].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return "missing"; b.click(); return "clicked"; })()`);
  /** A camera field (its label: X, Y, Dist, …): its input, given a value and the event. */
  const field = (label) => `[...document.querySelectorAll(".terrain-camera-field")].find((l) => l.firstChild?.textContent === ${JSON.stringify(label)})?.querySelector("input")`;
  const type = (label, value, event) => page.evaluate(`(() => { const i = ${field(label)}; if (!i) return false; i.value = ${JSON.stringify(String(value))}; i.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return true; })()`);
  const shown = (label) => page.evaluate(`${field(label)}?.value ?? null`);
  const clickAt = async (x, y, modifiers = 0) => {
    await k.look(x, y);
    await sleep(300);
    const c = await k.hands.where(".model-stage canvas");
    await k.hands.mouse("mouseMoved", c.x, c.y, 0, modifiers);
    await k.hands.click(".model-stage canvas", null, modifiers);
    await sleep(200);
  };

  await k.tab("Cameras");
  await k.look(0, 0);
  await sleep(300);
  if ((await button("Create from view")) === "missing") return fail("no Create from view button");
  await k.look(1024, 0);
  await sleep(300);
  await button("Create from view");
  await k.save();
  const made = cameras();
  if (made.length !== 2) return fail(`two cameras made from views gave ${made.length}`);
  const [a, b] = made;
  if (Math.abs(a.targetX - b.targetX) < 500) return fail(`the two cameras aren't apart (control): ${a.targetX}, ${b.targetX}`);

  // Several at once: a click, then a Shift+click.
  await clickAt(a.targetX, a.targetY);
  await clickAt(b.targetX, b.targetY, SHIFT);
  const count = await page.evaluate(`document.querySelector(".terrain-camera-count")?.textContent ?? ""`);
  if (count !== "2 cameras") return fail(`a click and a Shift+click on two cameras selected "${count}"`);
  if ((await shown("X")) !== "") fail(`the X field shows "${await shown("X")}" for two cameras with different X`);
  if ((await shown("AoA")) !== String(Math.round(a.angleOfAttack * 100) / 100)) fail(`the shared angle of attack shows "${await shown("AoA")}", not ${a.angleOfAttack}`);
  await type("Dist", 2222, "change");
  await k.save();
  const both = cameras();
  if (both.some((c) => c.distance !== 2222)) fail(`a distance typed for two cameras gave ${both.map((c) => c.distance).join(", ")}`);
  if (both[0].targetX !== a.targetX || both[1].targetX !== b.targetX) fail("setting the distance for two cameras changed their X");
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await sleep(300);
  await k.save();
  if (cameras().map((c) => c.distance).join() !== [a.distance, b.distance].join()) fail(`one undo of the shared distance left ${cameras().map((c) => c.distance).join(", ")}`);

  // Duplicate the two (still selected after the undo): two copies with new names, one step.
  if ((await page.evaluate(`document.querySelector(".terrain-camera-count")?.textContent ?? ""`)) !== "2 cameras") fail("the undo didn't keep the two cameras selected");
  if ((await button("Duplicate")) === "missing") return fail("no Duplicate button");
  await k.save();
  const four = cameras();
  if (four.length !== 4) fail(`Duplicate of two cameras gave ${four.length} cameras`);
  else {
    if (new Set(four.map((c) => c.name)).size !== 4) fail(`the copies' names aren't new: ${four.map((c) => c.name).join(", ")}`);
    const same = (x, y) => JSON.stringify({ ...x, name: "" }) === JSON.stringify({ ...y, name: "" });
    if (!same(four[2], four[0]) || !same(four[3], four[1])) fail(`the copies differ from their cameras: ${JSON.stringify(four[2])} / ${JSON.stringify(four[0])}`);
  }
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await sleep(300);
  await k.save();
  if (cameras().length !== 2) fail(`one undo of Duplicate left ${cameras().length} cameras`);
  if (await dirty()) fail("unsaved after saving the undone Duplicate");

  // Live: a value typed for one camera shows through it before it's an edit. Clicking it (which changes the panel above
  // the map from two cameras' to one's) is no edit either: it once moved the camera by the panel's height.
  await clickAt(a.targetX, a.targetY);
  if (await dirty()) fail(`a click selecting a camera made an edit: ${JSON.stringify(cameras().map((c) => [c.targetX, c.targetY]))}`);
  const before = await view();
  await type("Dist", 3333, "input");
  await sleep(300);
  const live = await view();
  if (!live || Math.abs(live.distance - 3333) > 1) fail(`typing a distance didn't show it in the view: ${JSON.stringify(live)} (before ${JSON.stringify(before)})`);
  if (live && Math.abs(live.target[0] - a.targetX) > 1) fail(`the live view isn't through the camera: target ${live.target}`);
  if (await dirty()) fail("a value being typed is already an edit");
  await type("Dist", 3333, "change");
  if (!(await dirty())) fail("the value, entered, isn't an edit");
  // The preview of a value ends with it: the view is the user's again once it's entered, the field left, or the panel
  // made again by an undo (which takes the field away without a blur); it once stayed at the previewed camera.
  const userView = async (when) => {
    await sleep(300);
    const now = await view();
    if (!now || Math.abs(now.distance - before.distance) > 1 || Math.abs(now.target[0] - before.target[0]) > 1 || Math.abs(now.target[1] - before.target[1]) > 1) {
      fail(`${when}, the view stays at the previewed camera: ${JSON.stringify(now)} (the user's: ${JSON.stringify(before)})`);
    }
  };
  await userView("after a value is entered");
  await k.save();
  if (cameras()[0].distance !== 3333) fail(`the entered distance saved as ${cameras()[0].distance}`);
  await type("Dist", 4444, "input");
  await sleep(300);
  if (Math.abs(((await view())?.distance ?? 0) - 4444) > 1) fail("typing a second distance didn't show it in the view (control)");
  await type("Dist", 4444, "blur");
  await userView("after the field is left");
  await type("Dist", 5555, "input");
  await k.save();
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await userView("after a save and an undo while a value was being typed");
  await k.save();
  if (cameras()[0].distance !== a.distance) fail(`the undo gave the distance ${cameras()[0].distance}, not ${a.distance}`);
  await page.evaluate(`w3.editors.closeAll()`);
}

/** Adjust Cliff Levels and Reset Height Field on the whole map, by their commands: each one undo step, what stands on the
 *  ground follows it, a doodad with a height of its own stays (as in the World Editor), a shift past the levels the map
 *  can have is refused with nothing changed, and undoing gives every file back byte for byte. */
async function wholeMapGround(page, found) {
  const fail = (what) => found.push(`whole-map ground: ${what}`);
  const k = await heightKit(page, "WholeGround");
  const TXT = "map/war3map.w3e.txt";
  await k.tool("place_objects", { objects: [{ id: "LTlt", x: 0, y: 0 }, { id: "LTlt", x: 512, y: 512 }], ignoreRoom: true });
  await k.tool("place_objects", { objects: [{ id: "hfoo", x: 256, y: 0, player: 1 }], ignoreRoom: true });
  await k.tool("sculpt_terrain", { mode: "raise", amount: 96, left: -512, bottom: -512, right: 512, top: 512 });
  await k.save();
  if (k.doodads().length !== 2) return fail(`the trees weren't placed: ${k.doodads().length}`);
  // The second tree given a height of its own (Set Uniform Doodad Heights on it alone).
  await k.tab("Select");
  await k.look(512, 512, { id: "LTlt", x: 512, y: 512 });
  await sleep(300);
  const set = await k.run("w3.terrain.setUniformDoodadHeights", 700);
  if (set) return fail(`Set Uniform Doodad Heights: ${set}`);
  await k.save();
  if (k.doodads().find((d) => d.position[0] === 512)?.position[2] !== 700) return fail(`the fixed tree (control): ${JSON.stringify(k.doodads().map((d) => d.position))}`);
  const files = ["war3map.w3e.txt", "war3map.doo.json", "war3mapUnits.doo.json"];
  const contents = () => files.map((f) => readFileSync(join(k.root, "map", f), "utf8"));
  const kept = contents();
  /** The files that aren't as they were at the start, and where they first differ. */
  const changedFiles = () => contents().flatMap((c, i) => {
    if (c === kept[i]) return [];
    let at = 0;
    while (at < c.length && c[at] === kept[i][at]) at++;
    return [`${files[i]} at ${at}: "${kept[i].slice(Math.max(0, at - 30), at + 30)}" → "${c.slice(Math.max(0, at - 30), at + 30)}"`];
  });
  const hashes = () => changedFiles().join(" | ");
  const original = "";
  const text = () => readFileSync(join(k.root, "map", "war3map.w3e.txt"), "utf8");
  const section = (name) => { const m = new RegExp(`^\\[${name}\\][^\\n]*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text()); return m ? m[0] : ""; };
  // A grid of one value is written "[layer] all 2".
  const levels = () => { const s = section("layer"), all = /^\[layer\] all (\S)/.exec(s); return all ? [all[1]] : [...s.replace(/^\[layer\][^\n]*\n?/, "").replace(/\s/g, "")]; };
  const before = { levels: levels(), tree: k.doodads().find((d) => d.position[0] === 0).position[2], foot: k.units().find((u) => u.id === "hfoo").position[2] };
  if (!section("height").includes("[height]") || /\[height\] all 0/.test(section("height"))) fail(`the raised ground isn't in the terrain (control): ${section("height").slice(0, 80)}`);
  const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";
  const lv = (ch) => DIGITS.indexOf(ch);
  if (!before.levels.length || before.levels.some((c) => lv(c) < 0)) return fail(`the cliff levels can't be read (control): ${section("layer").slice(0, 80)}`);

  // Up by one: every level one higher, the tree and the footman 128 higher, the fixed tree where it was.
  let err = await k.run("w3.terrain.adjustCliffLevels", 1);
  if (err) fail(`Adjust Cliff Levels: ${err}`);
  await k.save();
  const up = levels();
  if (up.length !== before.levels.length || up.some((c, i) => lv(c) !== lv(before.levels[i]) + 1)) fail(`levels after +1: ${up.slice(0, 8).join("")}… (before ${before.levels.slice(0, 8).join("")}…)`);
  const tree = k.doodads().find((d) => d.position[0] === 0).position[2], foot = k.units().find((u) => u.id === "hfoo").position[2];
  if (Math.abs(tree - (before.tree + 128)) > 0.01) fail(`the tree went from ${before.tree} to ${tree}, not 128 up`);
  if (Math.abs(foot - (before.foot + 128)) > 0.01) fail(`the footman went from ${before.foot} to ${foot}, not 128 up`);
  if (k.doodads().find((d) => d.position[0] === 512).position[2] !== 700) fail("the tree with a height of its own moved");
  // One undo takes it all back, byte for byte.
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await sleep(300);
  await k.save();
  if (hashes() !== original) fail(`one undo of Adjust Cliff Levels didn't give the files back as they were: ${hashes()}`);

  // Past the bottom: refused, nothing changed, nothing to save.
  await k.clearToasts();
  err = await k.run("w3.terrain.adjustCliffLevels", -20);
  if (err) fail(`a refused shift threw: ${err}`);
  await sleep(300);
  if (!/Not done/.test(await k.toasts())) fail(`a shift past level 0 wasn't refused with a message: "${await k.toasts()}"`);
  if (await page.evaluate(`w3.editors.isDirty(${JSON.stringify(TXT)}) || w3.editors.unsavedPaths().length > 0`)) fail("a refused shift left unsaved changes");

  // Reset Height Field: flat over the levels, the tree back on the (now flat) ground, then undone.
  err = await k.run("w3.terrain.resetHeightField");
  if (err) fail(`Reset Height Field: ${err}`);
  await k.save();
  if (!/^\[height\] all 0$/m.test(text())) fail(`after Reset Height Field the heights are ${section("height").slice(0, 80)}`);
  const flatTree = k.doodads().find((d) => d.position[0] === 0).position[2];
  if (Math.abs(flatTree - (lv(before.levels[0]) - 2) * 128) > 0.01) fail(`after the reset the tree stands at ${flatTree}`);
  if (k.doodads().find((d) => d.position[0] === 512).position[2] !== 700) fail("the reset moved the tree with a height of its own");
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await sleep(300);
  await k.save();
  if (hashes() !== original) fail(`one undo of Reset Height Field didn't give the files back as they were: ${hashes()}`);
  await page.evaluate(`w3.editors.closeAll()`);
}

/** Enforce Camera Bounds and Enforce Water Height Limits. Each is run on and off against the same input, which is what
 *  shows the setting made the difference: a nudge, a paste and a placement against the camera bounds, and deep water
 *  drawn on ground raised so high that its surface would pass the limit of the stored level. */
async function heightsLimits(page, found) {
  const fail = (what) => found.push(`height tools (limits): ${what}`);
  const k = await heightKit(page, "Limits");
  const { hands } = k;
  const bounds = k.read("war3map.w3i.json").cameraBounds;
  const [bl, bb, br, bt] = bounds;
  if (!(bl < br && bb < bt)) return fail(`camera bounds ${bounds}`);
  await k.tool("place_objects", { objects: [{ id: "LTlt", x: 0, y: 0 }, { id: "LTlt", x: br - 40, y: 0 }], ignoreRoom: true });
  await k.save();
  const count = () => k.doodads().length;
  const nearEdge = () => k.doodads().find((d) => d.position[1] === 0 && d.position[0] > br - 100 && d.position[0] < br + 400);
  await k.tab("Select");
  await k.look(0, 0, { id: "LTlt", x: 0, y: 0 });
  await sleep(500);
  await k.focusMap();
  await hands.key("c", "KeyC", 67, 2);

  // A nudge: the doodad 40 inside the bound moves right.
  await k.look(br - 40, 0, { id: "LTlt", x: br - 40, y: 0 });
  await sleep(500);
  await k.focusMap();
  await k.run("w3.terrain.toggleEnforceCameraBounds");
  if ((await k.setting("terrain.enforceCameraBounds")) !== true || (await k.box("Camera bounds")) !== true) fail("the toggle command didn't switch Enforce Camera Bounds on");
  for (let i = 0; i < 3; i++) await hands.key("ArrowRight", "ArrowRight", 39, 2);
  await k.save();
  if (nearEdge()?.position[0] !== br) fail(`three nudges to the right with Enforce Camera Bounds on left the doodad at ${nearEdge()?.position[0]}, the bound is ${br}`);
  await k.run("w3.terrain.toggleEnforceCameraBounds");
  await hands.key("ArrowRight", "ArrowRight", 39, 2);
  await k.save();
  if (nearEdge()?.position[0] !== br + 32) fail(`a nudge with Enforce Camera Bounds off left the doodad at ${nearEdge()?.position[0]}, wanted ${br + 32}`);

  // A paste outside the bounds.
  await k.run("w3.terrain.toggleEnforceCameraBounds");
  await k.look(br + 400, 0);
  await sleep(400);
  await k.clearToasts();
  const n0 = count();
  await k.focusMap();
  await hands.key("v", "KeyV", 86, 2);
  await k.clickMiddle();
  await k.save();
  if (count() !== n0) fail("a paste outside the camera bounds placed a doodad with Enforce Camera Bounds on");
  if (!/camera bounds/.test(await k.toasts())) fail(`no word on the refused paste: "${await k.toasts()}"`);
  // On the map and a doodad: only the camera bounds are the reason, and the word says no other.
  if (/playable|off the map/.test(await k.toasts())) fail(`the refused paste names reasons that don't hold: "${await k.toasts()}"`);
  await k.run("w3.terrain.toggleEnforceCameraBounds");
  await hands.click(".model-stage canvas");
  await k.save();
  if (count() !== n0 + 1) fail(`the same paste with Enforce Camera Bounds off placed ${count() - n0} doodads`);
  await hands.key("Escape", "Escape", 27);

  // A placement from the Objects tab: inside the bounds it works (control), outside it's refused.
  const edgeX = nearEdge().position[0];
  await k.look(edgeX, 0, { id: "LTlt", x: edgeX, y: 0 });
  await sleep(400);
  await k.run("w3.terrain.selectInPalette");
  await sleep(300);
  const hint = await page.evaluate(`document.querySelector(".terrain-place-hint")?.textContent`);
  if (!/Placing/.test(hint ?? "")) return fail(`the Objects tab says "${hint}" after Select In Tool Palette`);
  await k.run("w3.terrain.toggleEnforceCameraBounds");
  await k.look(br - 1200, 256);
  await sleep(400);
  const n1 = count();
  await hands.click(".model-stage canvas");
  await sleep(500);
  await k.save();
  if (count() !== n1 + 1) fail(`a placement inside the camera bounds placed ${count() - n1} doodads (${await k.toasts()})`);
  await k.look(br + 600, 256);
  await sleep(400);
  await k.clearToasts();
  await hands.click(".model-stage canvas");
  await sleep(500);
  await k.save();
  if (count() !== n1 + 1) fail("a placement outside the camera bounds worked with Enforce Camera Bounds on");
  if (!/camera bounds/.test(await k.toasts())) fail(`no word on the refused placement: "${await k.toasts()}"`);
  await k.run("w3.terrain.toggleEnforceCameraBounds");
  await hands.click(".model-stage canvas");
  await sleep(500);
  await k.save();
  if (count() !== n1 + 2) fail(`the same placement with Enforce Camera Bounds off placed ${count() - n1 - 1} doodads (${await k.toasts()})`);
  await k.tab("Select");

  // A typed position: inside the bounds it's taken. Once the bounds are narrowed in the w3i (saved elsewhere, so the
  // editor has to read them again) the same kind of number is refused with a word, and the box shows the real position again.
  await k.run("w3.terrain.toggleEnforceCameraBounds");
  const at = (x) => k.doodads().some((d) => d.position[0] === x && d.position[1] === 0);
  const typeX = async (x) => { await k.look(...(x.from)); await sleep(500); await k.clearToasts(); await retype(hands, ".terrain-sel-triple input", String(x.to)); await k.save(); };
  await typeX({ from: [0, 0, { id: "LTlt", x: 0, y: 0 }], to: br - 300 });
  if (!at(br - 300)) fail("a typed X inside the camera bounds wasn't taken");
  const w3i = await page.evaluate(`w3.workspace.readText("map/war3map.w3i.json")`);
  const narrow = JSON.parse(w3i);
  narrow.cameraBounds[2] = br - 400; narrow.cameraBounds[6] = br - 400;
  await page.evaluate(`w3.workspace.writeText("map/war3map.w3i.json", ${JSON.stringify(JSON.stringify(narrow))})`);
  await sleep(800);
  await typeX({ from: [br - 300, 0, { id: "LTlt", x: br - 300, y: 0 }], to: br - 100 });
  if (at(br - 100) || !at(br - 300)) fail("a typed X past the narrowed camera bounds was taken: the editor still has the old bounds");
  if (!/camera bounds/.test(await k.toasts())) fail(`no word on the refused position: "${await k.toasts()}"`);
  const shown = await page.evaluate(`document.querySelector(".terrain-sel-triple input")?.value`);
  if (Number(shown) !== br - 300) fail(`the position box kept the refused text: "${shown}"`);
  await page.evaluate(`w3.workspace.writeText("map/war3map.w3i.json", ${JSON.stringify(w3i)})`);
  await sleep(800);
  await k.run("w3.terrain.toggleEnforceCameraBounds");
  await k.save();

  // Water: four raises of 1000 make a mound whose top is past 2048, where the stored level of a surface at its height ends.
  for (let i = 0; i < 4; i++) {
    const raise = await k.tool("sculpt_terrain", { mode: "raise", amount: 1000, left: 256, bottom: 256, right: 2304, top: 2304, shape: "box" }).then(() => null, (e) => e.message);
    if (raise) return fail(`raising the ground: ${raise}`);
  }
  await k.save();
  const w3e = join(k.root, "map", "war3map.w3e.txt"), raised = hash(w3e);
  await k.tab("Terrain");
  await page.evaluate(`document.querySelector('button.tool-button[title^="Deep:"]').click()`);
  await k.clearToasts();
  // The middle of the picture is the point looked at, which for the mound is its very tip; so a stroke on the mound
  // starts a little below it, on the upper slope, which is above 2048 as well. `down` is how far, in pixels.
  const stroke = async (x, y, down = 0) => {
    await k.look(x, y);
    await sleep(600);
    const c = await hands.where(".model-stage canvas");
    await hands.drag({ x: c.x - (down ? 6 : 40), y: c.y + down }, { x: c.x + (down ? 6 : 40), y: c.y + down });
    await sleep(500);
    await k.save();
  };
  await hands.click(".model-toggle", "Water limits");
  if ((await k.setting("terrain.enforceWaterLimits")) !== true) fail("the toolbar box didn't switch Enforce Water Height Limits on");
  await stroke(-1024, -1024);
  const low = hash(w3e);
  if (low === raised) fail("deep water on low ground changed nothing with Enforce Water Height Limits on");
  await stroke(1280, 1280, 45);
  if (hash(w3e) !== low) fail("deep water past the limit was drawn with Enforce Water Height Limits on");
  if (!/water/i.test(await k.toasts())) fail(`no word on the refused water: "${await k.toasts()}"`);
  await k.run("w3.terrain.toggleEnforceWaterLimits");
  if ((await k.setting("terrain.enforceWaterLimits")) !== false || (await k.box("Water limits")) !== false) fail("the toggle command didn't switch Enforce Water Height Limits off");
  await stroke(1280, 1280, 45);
  if (hash(w3e) === low) fail("the same stroke with Enforce Water Height Limits off drew nothing");
  await k.tab("Select");

  // A paste whose ground would put water past the limit is refused whole, with the objects that stand on it. The source is the
  // mound with the water drawn on it above, and trees over it (the area dragged out below covers some of them).
  const trees = [];
  for (let x = 896; x <= 1664; x += 128) for (let y = 896; y <= 1664; y += 128) trees.push({ id: "LTlt", x, y });
  await k.tool("place_objects", { objects: trees, ignoreRoom: true });
  await k.save();
  await k.clearToasts();
  await hands.click(".chip", "Area");
  await k.look(1280, 1280);
  await sleep(700);
  const c = await hands.where(".model-stage canvas");
  await hands.drag({ x: c.x - 15, y: c.y + 45 }, { x: c.x + 15, y: c.y + 75 });
  const areaShown = () => page.evaluate(`/\\d+ × \\d+ tiles/.test(document.querySelector(".terrain-selection")?.textContent ?? "")`);
  await until("the area", areaShown, 8000).catch(() => fail("no area was selected for the copy"));
  await k.focusMap();
  await hands.key("c", "KeyC", 67, 2);
  await hands.key("Escape", "Escape", 27);
  // The paste needs a ground tile the map no longer has: the most used one (the mound's) is taken out of the list now
  // (Tiles…, ✕, Remove). When the paste is refused that tile goes again, and the side list says so at once.
  await k.tab("Terrain");
  await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Tiles…").click()`);
  const tileRows = `[...document.querySelectorAll(".terrain-tilemgr-row")].filter((r) => r.querySelector("img"))`;
  await until("the map's tile list", () => page.evaluate(`${tileRows}.length > 1`), 10000);
  const gone = await page.evaluate(`(() => {
    const rows = ${tileRows}, share = (r) => parseFloat(r.querySelector(".muted")?.textContent ?? "0");
    const top = rows.reduce((a, b) => (share(b) > share(a) ? b : a));
    top.querySelector('button[title^="Remove from the map"]').click();
    return top.querySelector(".terrain-tilemgr-name").textContent;
  })()`);
  await until("the removal's question", () => page.evaluate(`!!document.querySelector(".terrain-tilemgr-row.removing")`), 5000);
  await page.evaluate(`[...document.querySelectorAll(".terrain-tilemgr-row.removing button")].find((b) => b.textContent === "Remove").click()`);
  await sleep(300);
  await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Tiles…").click()`);
  await k.save();
  const groundLine = () => /^ground (.*)$/m.exec(readFileSync(w3e, "utf8"))?.[1].trim().split(" ") ?? [];
  const goneId = /\((\w{4})\)$/.exec(gone)?.[1];
  if (!goneId || groundLine().includes(goneId)) fail(`the tile ${gone} wasn't taken out of the map's list (control): ${groundLine().join(" ")}`);
  await k.tab("Select");
  await k.look(1024, -1536);
  await sleep(500);
  await k.run("w3.terrain.toggleEnforceWaterLimits");
  if ((await k.setting("terrain.enforceWaterLimits")) !== true) fail("Enforce Water Height Limits wasn't switched on again");
  const w3eNow = hash(w3e), treesNow = count();
  await k.clearToasts();
  await k.focusMap();
  await hands.key("v", "KeyV", 86, 2);
  await k.clickMiddle();
  await k.save();
  if (hash(w3e) !== w3eNow) fail("a paste with water past the limit changed the ground with Enforce Water Height Limits on");
  if (count() !== treesNow) fail("a paste whose ground was refused still placed its objects");
  if (!/water/i.test(await k.toasts())) fail(`no word on the refused paste: "${await k.toasts()}"`);
  // The side list: its rows and count are the map's tiles, without the one the refused paste added and took out again.
  await sleep(500);
  const side = await page.evaluate(`(() => {
    const head = [...document.querySelectorAll(".model-side h4")].find((e) => e.textContent.startsWith("Ground textures"));
    return { head: head.textContent, rows: [...head.nextElementSibling.querySelectorAll(".model-row")].map((r) => r.children[1].textContent.trim()) };
  })()`);
  const kept = groundLine();
  if (kept.includes(goneId)) fail(`the refused paste left ${goneId} in the map's tile list`);
  if (side.head !== `Ground textures (${kept.length})` || side.rows.join(" ") !== kept.join(" ")) fail(`after the refused paste the side list shows ${side.head}: ${side.rows.join(" ")}; the map has ${kept.join(" ")}`);
  await k.run("w3.terrain.toggleEnforceWaterLimits");
  await k.clickMiddle();
  await k.save();
  if (hash(w3e) === w3eNow || count() <= treesNow) fail(`the same paste with Enforce Water Height Limits off: ground ${hash(w3e) === w3eNow ? "unchanged" : "changed"}, ${count() - treesNow} objects`);
  await hands.key("Escape", "Escape", 27);
  await k.tab("Select");
  await k.verify(fail);
  await k.reset();
}

/** Map Size and Camera Bounds can be taken back: a resize larger through the MCP tool, one smaller through the Map Size tab,
 *  each undone with Ctrl+Z in the reopened editor (and the command), then redone, with every file of the map byte for byte
 *  what it was before the resize / after it. A shrink names what it cuts off and makes a checkpoint. */
async function resizeUndo(page, found) {
  const fail = (what) => found.push(`resize undo: ${what}`);
  const tool = mcpTool(page), hands = new Hands(page);
  const folder = join(work, "resize-undo");
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; window.__warned = []; w3.window.showWarning = async (m) => { window.__warned.push(m); return "Apply"; }; })()`);
  await tool("new_map", { name: "ResizeUndo", width: 64, height: 64, folder });
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  const root = await page.evaluate(`w3.workspace.project()?.root`);
  const state = () => {
    const files = snapshot(join(root, "map"));
    const pathing = join(root, ".w3proj", "pathing.json");
    return new Map([...files, ...(existsSync(pathing) ? [[".w3proj/pathing.json", hash(pathing)]] : [])]);
  };
  const differ = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  const size = () => { const w3e = readFileSync(join(root, "map", "war3map.w3e.txt"), "utf8"); return w3e.length; };
  /** The editor on the file is open again and drawn. */
  const editorUp = async () => {
    await sleep(800);
    await until("the editor to open again", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt" && !!document.querySelector(".model-stage canvas") && !!document.querySelector(".terrain-tab")`), 30000);
    await sleep(1500);
  };
  const settledState = async () => { await sleep(1500); return state(); };
  /** Waits until the files are what `want` is (an undo is asynchronous), then lets them settle and checks again. */
  const reaches = async (want, label) => {
    let last = [];
    try { await until(label, async () => (last = differ(state(), want)).length === 0, 30000); } catch { fail(`${label}: differs in ${last.join(", ")}`); return false; }
    await editorUp();
    last = differ(await settledState(), want);
    if (last.length) { fail(`${label}: changed again after the editor opened: ${last.join(", ")}`); return false; }
    return true;
  };
  const ctrl = async (key, code, vk, shift) => {
    await page.evaluate(`document.querySelector(".model-stage canvas").focus()`);
    await hands.key(key, code, vk, 2 | (shift ? 8 : 0));
  };
  const doodadIds = () => JSON.parse(readFileSync(join(root, "map", "war3map.doo.json"), "utf8")).doodads.map((d) => d.id);

  // Something in the strip that a shrink from the left will cut off.
  await tool("place_objects", { objects: [{ id: "LPwb", x: -3900, y: 0 }], ignoreRoom: true });
  await tool("save_project");
  await sleep(500);
  if (!doodadIds().includes("LPwb")) { fail("the doodad wasn't placed (control)"); return; }
  const base = await settledState();
  const baseSize = size();

  // Larger, by the tool; undone by Ctrl+Z.
  await tool("resize_map", { right: 32, top: 32 });
  await editorUp();
  const grown = await settledState();
  if (size() <= baseSize || !differ(base, grown).includes("war3map.w3e.txt")) { fail("the resize changed nothing (control)"); return; }
  await ctrl("z", "KeyZ", 90, false);
  if (await reaches(base, "undo of the larger map by Ctrl+Z")) {
    await ctrl("z", "KeyZ", 90, true);
    await reaches(grown, "redo of the larger map by Ctrl+Shift+Z");
  }
  // The same by the commands, and Ctrl+Z with nothing left to undo does nothing.
  const run = (id) => page.evaluate(`w3.commands.execute(${JSON.stringify(id)}).then(() => null, (e) => String(e))`);
  const err = await run("w3.terrainMapSize.undo");
  if (err) fail(`Undo Resize: ${err}`);
  if (await reaches(base, "undo of the larger map by the command")) {
    await ctrl("z", "KeyZ", 90, false);
    await sleep(1500);
    const still = differ(state(), base);
    if (still.length) fail(`Ctrl+Z with no resize to undo changed ${still.join(", ")}`);
    const again = await run("w3.terrainMapSize.redo");
    if (again) fail(`Redo Resize: ${again}`);
    await reaches(grown, "redo of the larger map by the command");
  }

  // Smaller, by the Map Size tab: it names what is cut off, and the shrink is undone.
  await page.evaluate(`window.__warned.length = 0`);
  await hands.click(".terrain-tab", "Map Size");
  await sleep(500);
  await page.evaluate(`(() => { const i = document.querySelectorAll(".mapsize-num")[0]; i.value = "-32"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(200);
  await hands.click(".mapsize-buttons button.primary");
  await until("the question", () => page.evaluate(`window.__warned.length > 0`), 10000).catch(() => fail("the Map Size tab asked nothing"));
  const question = await page.evaluate(`window.__warned[0] ?? ""`);
  if (!/Shrink the map\? This removes 3072 tiles of terrain .* and 1 object /.test(question)) fail(`the shrink asked "${question}"`);
  if (!/checkpoint/.test(question) || !/Ctrl\+Z/.test(question)) fail(`the shrink question doesn't say how it is taken back: "${question}"`);
  await editorUp();
  const shrunk = await settledState();
  if (doodadIds().includes("LPwb")) fail("the shrink didn't remove the doodad outside (control)");
  if (!differ(grown, shrunk).includes("war3map.doo.json")) fail("the shrink didn't change the doodads (control)");
  const checkpoints = existsSync(join(root, "build", "checkpoints")) ? readdirSync(join(root, "build", "checkpoints")) : [];
  if (!checkpoints.length) fail("the shrink made no checkpoint");
  await ctrl("z", "KeyZ", 90, false);
  if (await reaches(grown, "undo of the shrink by Ctrl+Z")) {
    if (!doodadIds().includes("LPwb")) fail("the doodad cut off by the shrink isn't back after the undo");
    await ctrl("z", "KeyZ", 90, true);
    await reaches(shrunk, "redo of the shrink by Ctrl+Shift+Z");
  }
  // An edit by a tool and a resize straight after it: the rebuild of pathing, shadows and minimap still due is done first
  // (not on the new files), the undo that follows is not met by a question about files changed since, and nothing is written
  // to the old terrain afterwards (the three grids all have the size of the terrain).
  // (Through the Map Size tab, which makes no checkpoint for a larger map: a checkpoint settles the rebuild too.)
  await hands.click(".terrain-tab", "Map Size");
  await sleep(500);
  await page.evaluate(`(() => { const i = document.querySelectorAll(".mapsize-num")[1]; i.value = "32"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(200);
  await tool("place_objects", { objects: [{ id: "LPwb", x: 1500, y: 1500 }], ignoreRoom: true });
  // The rebuild is due three seconds after the edit: Apply is pressed when it is about to start.
  await sleep(2700);
  await hands.click(".mapsize-buttons button.primary");
  await editorUp();
  const raced = await settledState();
  await page.evaluate(`window.__warned.length = 0`);
  await ctrl("z", "KeyZ", 90, false);
  await until("the undo after the edit", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 30000);
  await editorUp();
  const undone = await settledState();
  if ((await page.evaluate(`window.__warned.length`)) > 0) fail(`the undo straight after an edit and a resize asked: ${await page.evaluate(`window.__warned[0]`)}`);
  if (!differ(raced, undone).includes("war3map.w3e.txt")) fail("the undo after the edit and the resize changed nothing (control)");
  // Longer than the delay of the rebuild: a late one would write over the restored files.
  await sleep(5000);
  const late = differ(undone, state());
  if (late.length) fail(`files changed after the undo, by a rebuild still due from before: ${late.join(", ")}`);
  const grid = () => {
    const w3e = readFileSync(join(root, "map", "war3map.w3e.txt"), "utf8");
    const [, w, h] = /corners ([0-9]+) ([0-9]+)/.exec(w3e) ?? [];
    const wpm = readFileSync(join(root, "map", "war3map.wpm"));
    const shd = readFileSync(join(root, "map", "war3map.shd"));
    return { tiles: [Number(w) - 1, Number(h) - 1], wpm: [wpm.readUInt32LE(8), wpm.readUInt32LE(12)], shd: shd.length };
  };
  const g = grid();
  if (g.wpm[0] !== g.tiles[0] * 4 || g.wpm[1] !== g.tiles[1] * 4) fail(`the pathing map is ${g.wpm.join(" x ")} cells for a terrain of ${g.tiles.join(" x ")} tiles`);
  if (g.shd !== g.tiles[0] * 4 * g.tiles[1] * 4) fail(`the shadow map has ${g.shd} cells for a terrain of ${g.tiles.join(" x ")} tiles`);
  if (!doodadIds().includes("LPwb")) fail("the doodad placed before the resize is gone after the undo");
  // What is due after the undo changes nothing: the files were already what the rebuild makes.
  await page.evaluate(`w3.commands.execute("w3.terrain.settle")`);
  const after = differ(undone, state());
  if (after.length) fail(`the files weren't up to date after the undo: ${after.join(", ")} changed when the rebuild ran`);
  const kit = { root };
  const map = join(folder, "ResizeUndo.w3x");
  await page.evaluate(`w3.editors.saveAll()`);
  await page.evaluate(`w3.backend.invoke("project_pack", { root: ${JSON.stringify(kit.root)}, output: ${JSON.stringify(map)} })`);
  await until("the pack", () => existsSync(map), 20000);
  const verify = spawnSync(cli, ["verify", "-q", map, ...(game ? ["--game", game] : [])], { encoding: "utf8" });
  if (verify.status !== 0 || !/1 ok(?! \(1 incomplete)/.test(verify.stdout)) fail(`verify: ${(verify.stdout + verify.stderr).trim().slice(-300)}`);
  await page.evaluate(`w3.editors.closeAll()`);
}

/** The map's part of the window, as PNG data (base64), once the view has had a moment to draw. */
async function mapPicture(page) {
  await sleep(700);
  const r = await page.evaluate(`(() => { const b = document.querySelector(".model-stage canvas").getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height, scale: 1 }; })()`);
  const shot = await page.send("Page.captureScreenshot", { format: "png", clip: r });
  return shot.data;
}

/** How many pixels two pictures differ in, by more than rounding: counted in the page, which can decode PNGs. */
function pixelsApart(page, a, b) {
  return page.evaluate(`(async () => {
    const load = (data) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = "data:image/png;base64," + data; });
    const pixels = async (data) => { const i = await load(data), c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    const [p, q] = await Promise.all([pixels(${JSON.stringify(a)}), pixels(${JSON.stringify(b)})]);
    const pixelsWidth = (await load(${JSON.stringify(a)})).width;
    let n = 0;
    // Not the outer two rows and columns: the canvas sits at a fraction of a pixel, and its edge pixels come out as
    // part page, part picture, which now and then differs between two captures of the same scene. Everything inside is compared.
    const w = pixelsWidth, margin = 2;
    for (let i = 0; i < p.length; i += 4) {
      const x = (i / 4) % w, y = Math.floor(i / 4 / w);
      if (x < margin || y < margin || x >= w - margin || y >= p.length / 4 / w - margin) continue;
      if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 24) n++;
    }
    return n;
  })()`);
}

/** The terrain viewer's View commands, through the command palette's own entry point: what each shows is
 *  judged on the window's picture (which has to change when a layer goes on, and come back when it goes off),
 *  and where the camera goes on the editor's own state. The pictures stay in `shots` to look at. */
async function viewCommands(page, fail, shots) {
  const bad = (what) => fail(`view commands: ${what}`);
  mkdirSync(shots, { recursive: true });
  const run = (id) => page.evaluate(`w3.commands.execute(${JSON.stringify(id)}).then(() => null, (e) => String(e))`);
  const state = () => page.evaluate(`(async () => (await w3.services.get("w3.terrain")).viewCommands.get(w3.editors.activePath())?.state() ?? null)()`);
  const picture = async (name) => {
    const data = await mapPicture(page);
    writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64"));
    return data;
  };
  const differ = (a, b) => pixelsApart(page, a, b);
  // No water (it ripples) and no animation, so that the same view is the same picture.
  await page.evaluate(`w3.settings.set("terrain.animate", false)`);
  await page.evaluate(`[...document.querySelectorAll(".model-toggle")].filter((l) => ["Water", "Effects"].includes(l.textContent.trim())).forEach((l) => l.querySelector("input").click())`);
  await sleep(300);
  const start = await state();
  if (!start) return bad("the terrain editor has no view commands");
  // A camera object to see (close to the unit placed at 256, 0), kept to put back.
  const cameras = await page.evaluate(`w3.workspace.readText("map/war3map.w3c.json")`);
  await page.evaluate(`w3.workspace.writeText("map/war3map.w3c.json", JSON.stringify({ format: "w3proj.cameras/1", version: 3, cameras: [{ name: "Smoke Camera", targetX: 0, targetY: 0, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 600, roll: 0, fieldOfView: 70, farZ: 5000, nearZ: 100 }] }))`);
  // Closing the toasts: they sit over the map.
  await page.evaluate(`document.querySelectorAll(".notification, .toast").forEach((e) => e.remove())`);

  /** Each of these changes the picture, and pressing it again brings the plain picture back. */
  const trial = async (plain, noise, id, key, name, least) => {
    const err = await run(id);
    if (err) return bad(`${id}: ${err}`);
    const on = await state();
    if (!on[key] || (key === "grid" && on.grid !== name.slice(5))) bad(`${id} didn't switch ${key} on (${JSON.stringify(on[key])})`);
    const changed = await differ(plain, await picture(name));
    if (changed < least + noise) bad(`${name} changed ${changed} pixels on screen`);
    await run(id);
    if (key === "grid" ? (await state()).grid !== "none" : (await state())[key]) bad(`${id} twice left ${key} on`);
    const back = await differ(plain, await picture(`${name}-off`));
    if (back > noise + 100) bad(`${name} off isn't the plain picture again (${back} pixels differ)`);
  };
  /** The same view twice differs by almost nothing: the control that tells a layer's difference from noise. */
  const settle = async (name) => {
    // Textures and models load while the first pictures are taken: let the view settle first.
    await sleep(1500);
    await picture(`${name}-warmup`);
    const plain = await picture(name), noise = await differ(plain, await picture(`${name}-again`));
    if (noise > 200) bad(`the same view gave two pictures ${noise} pixels apart, so no layer can be judged`);
    return { plain, noise };
  };

  // The whole map, water and all: the layers that cover ground.
  await run("w3.terrain.viewEntireMap");
  const far = await settle("plain");
  await trial(far.plain, far.noise, "w3.terrain.toggleNavalPathing", "naval", "naval", 2000);
  await trial(far.plain, far.noise, "w3.terrain.toggleHeightMap", "heights", "height-map", 2000);

  // Close to the unit: what is thin, and the grids, whose lines would vanish from far away.
  await page.evaluate(`(async () => (await w3.services.get("w3.terrain")).look.get(w3.editors.activePath())(256, 0, { id: "hfoo", x: 256, y: 0 }))()`);
  await sleep(300);
  const nothing = await run("w3.terrain.viewSelection");
  if (nothing) bad(`View Selection with a selection: ${nothing}`);
  const near = await state();
  if (Math.hypot(near.camera.target[0] - 256, near.camera.target[1]) > 120) bad(`View Selection looks at ${near.camera.target}`);
  const close = await settle("selection");
  await trial(close.plain, close.noise, "w3.terrain.toggleCameraObjects", "cameras", "cameras", 150);
  await trial(close.plain, close.noise, "w3.terrain.toggleSmallGrid", "grid", "grid-small", 400);
  await trial(close.plain, close.noise, "w3.terrain.toggleMediumGrid", "grid", "grid-medium", 400);
  await trial(close.plain, close.noise, "w3.terrain.toggleLargeGrid", "grid", "grid-large", 400);
  // The grid box in the toolbar and the commands are the same thing.
  await run("w3.terrain.toggleSmallGrid");
  const shown = await page.evaluate(`document.querySelector('select[title^="Grid"] option:checked')?.textContent`);
  await run("w3.terrain.toggleSmallGrid");
  if (!/^Small grid/.test(shown ?? "")) bad(`the grid box said "${shown}" after Toggle Small Grid`);
  // View > Shadows, on by default: off takes the footman's shadow away, on brings the same picture back, and the
  // toolbar box follows the command.
  const shadowBox = () => page.evaluate(`[...document.querySelectorAll(".model-toggle")].find((l) => l.textContent.trim() === "Shadows")?.querySelector("input")?.checked ?? null`);
  if ((await shadowBox()) !== true) bad(`the Shadows box isn't checked at first (${await shadowBox()})`);
  // HD with the map's lighting: the models' real shadows from the sun (the footman casts into the sun's shadow map).
  const hd = (await page.evaluate(`w3.settings.get("game.graphicsMode")`)) !== "sd";
  const lit = (await page.evaluate(`w3.settings.get("terrain.lighting.enabled")`)) !== false;
  const sunOn = (await state()).sunShadows;
  if (hd && lit && !(sunOn.drawn && sunOn.casters >= 1 && sunOn.texel > 0)) bad(`HD casts no real shadows next to the footman: ${JSON.stringify(sunOn)}`);
  const shadowsErr = await run("w3.terrain.toggleShadows");
  if (shadowsErr) bad(`w3.terrain.toggleShadows: ${shadowsErr}`);
  await sleep(300);
  const unshaded = await differ(close.plain, await picture("shadows-off"));
  const sunOff = (await state()).sunShadows;
  if (sunOff.drawn) bad(`the real shadows stayed after Toggle Shadows: ${JSON.stringify(sunOff)}`);
  if (unshaded < 150 + close.noise) bad(`Toggle Shadows changed only ${unshaded} pixels next to the footman`);
  if ((await shadowBox()) !== false) bad("the Shadows box stayed checked after Toggle Shadows");
  await run("w3.terrain.toggleShadows");
  await sleep(300);
  const shadedAgain = await differ(close.plain, await picture("shadows-on"));
  if (shadedAgain > close.noise + 100) bad(`shadows on again isn't the first picture (${shadedAgain} pixels differ)`);

  const hands = new Hands(page);
  const canvasFocused = () => page.evaluate(`document.activeElement === document.querySelector(".model-stage canvas")`);

  // Focus: after a click on a toolbar control the keys belong to the map again, so an arrow key pans.
  const before = (await state()).camera.target;
  await hands.click(".model-toggle", "Camera objects");
  if (!(await canvasFocused())) bad("a toolbar box kept the keyboard");
  await hands.key("ArrowRight", "ArrowRight", 39);
  const after = (await state()).camera.target;
  if (Math.hypot(after[0] - before[0], after[1] - before[1]) < 1) bad("an arrow key after a click on a toolbar box didn't pan");
  await hands.click(".model-toggle", "Camera objects");
  await hands.click(".model-toggle", "Fog");
  if (!(await canvasFocused())) bad("the Fog box kept the keyboard");
  await hands.click(".model-toggle", "Fog");
  await page.evaluate(`(() => { const s = document.querySelector('select[title^="Grid"]'); s.focus(); s.value = "large"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  if (!(await canvasFocused())) bad("the grid box kept the keyboard");
  if ((await state()).grid !== "large") bad("the grid box didn't set the grid");
  await run("w3.terrain.toggleLargeGrid");
  await hands.click("button[title='View Entire Map']");
  if (!(await canvasFocused())) bad("the View Entire Map button kept the keyboard");

  // The naval layer follows ground painting: after a stroke it shows what a fresh toggle shows.
  await run("w3.terrain.viewSelection");
  await run("w3.terrain.toggleNavalPathing");
  const painted0 = await picture("naval-before-paint");
  await page.evaluate(`[...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent === "Terrain").click()`);
  await sleep(300);
  await page.evaluate(`document.querySelector('button.tool-button[title^="Dry:"]').click()`);
  const c = await hands.where(".model-stage canvas");
  const stroke = (dy) => hands.drag({ x: c.x - 120, y: c.y + dy }, { x: c.x + 120, y: c.y + dy });
  const afresh = async (name) => {
    await run("w3.terrain.toggleNavalPathing");
    await sleep(300);
    await run("w3.terrain.toggleNavalPathing");
    await sleep(2500);
    return picture(name);
  };
  let lagged0 = painted0;
  for (const [i, dy] of [[1, -80], [2, 80]]) {
    await stroke(dy);
    await sleep(2500);
    const lagged = await picture(`paint-${i}`);
    if ((await differ(lagged0, lagged)) < 300) bad(`stroke ${i} changed nothing on screen`);
    const exact = await afresh(`paint-${i}-fresh`);
    const gap = await differ(lagged, exact);
    if (gap > close.noise + 100) bad(`after stroke ${i} the naval layer differs from a fresh one in ${gap} pixels`);
    lagged0 = exact;
  }

  // No growth: strokes and object edits with every layer on keep as many buffers and arrays alive as after the first.
  // The ones made after the counting starts are kept in sets, so an old free can't hide a new leak.
  await run("w3.terrain.toggleHeightMap");
  await run("w3.terrain.toggleSmallGrid");
  await run("w3.terrain.toggleCameraObjects");
  await sleep(2500);
  await page.evaluate(`(() => {
    const gl = WebGL2RenderingContext.prototype, live = (window.__live = { buffers: new Set(), arrays: new Set() });
    for (const [make, free, key] of [["createBuffer", "deleteBuffer", "buffers"], ["createVertexArray", "deleteVertexArray", "arrays"]]) {
      const m = gl[make], f = gl[free];
      gl[make] = function (...a) { (live[key + "Made"] = (live[key + "Made"] || 0) + 1); const o = m.apply(this, a); if (o) live[key].add(o); return o; };
      gl[free] = function (...a) { live[key].delete(a[0]); return f.apply(this, a); };
    }
  })()`);
  const openTab = (name) => page.evaluate(`[...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent === ${JSON.stringify(name)}).click()`);
  /** Deleting the unit and undoing it (object edits, which rebuild the placed objects), then strokes of the Dry tool. */
  const edits = async (nudges, dys) => {
    await openTab("Select");
    await page.evaluate(`document.querySelector(".model-stage canvas").focus()`);
    for (let i = 0; i < nudges; i++) {
      await page.evaluate(`(async () => (await w3.services.get("w3.terrain")).look.get(w3.editors.activePath())(256, 0, { id: "hfoo", x: 256, y: 0 }))()`);
      await sleep(600);
      await page.evaluate(`document.querySelector(".model-stage canvas").focus()`);
      await hands.key("Delete", "Delete", 46);
      await sleep(800);
      await run("workbench.undo");
      await sleep(1000);
    }
    await openTab("Terrain");
    await sleep(300);
    for (const dy of dys) { await stroke(dy); await sleep(1500); }
    await sleep(2500);
  };
  const count = () => page.evaluate(`({ buffers: window.__live.buffers.size, arrays: window.__live.arrays.size })`);
  await edits(1, [-120]);
  const warm = await count();
  await edits(3, [-40, 40, 120]);
  const grown = await count();
  if (grown.buffers > warm.buffers || grown.arrays > warm.arrays) bad(`three strokes and three deleted and restored objects left ${grown.buffers - warm.buffers} more GPU buffers and ${grown.arrays - warm.arrays} more vertex arrays in use`);
  for (const id of ["w3.terrain.toggleHeightMap", "w3.terrain.toggleSmallGrid", "w3.terrain.toggleCameraObjects", "w3.terrain.toggleNavalPathing"]) await run(id);
  // Every stroke is one step, and the nudges were undone: undoing the strokes leaves the project as it was saved.
  for (let i = 0; i < 6; i++) await run("workbench.undo");
  await sleep(500);
  if (await page.evaluate(`w3.editors.isDirty("map/war3map.w3e.txt") || w3.editors.unsavedPaths().length > 0`)) bad("undoing the strokes and objects of the view test left unsaved changes");
  await page.evaluate(`[...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent === "Select").click()`);
  await sleep(300);

  // The whole map is in view from further away than an object, and centred (new maps lie around the origin).
  const err = await run("w3.terrain.viewEntireMap");
  if (err) bad(`View Entire Map: ${err}`);
  const whole = await state();
  if (Math.hypot(whole.camera.target[0], whole.camera.target[1]) > 200) bad(`View Entire Map looks at ${whole.camera.target}`);
  if (!(near.camera.distance < whole.camera.distance / 2)) bad(`View Selection stays far away (${near.camera.distance} against ${whole.camera.distance})`);
  await picture("entire-map");
  // Select In Tool Palette (the unit is selected again: deleting it took the selection away): the Objects tab opens, with the unit's type chosen.
  await page.evaluate(`(async () => (await w3.services.get("w3.terrain")).look.get(w3.editors.activePath())(256, 0, { id: "hfoo", x: 256, y: 0 }))()`);
  await sleep(500);
  await run("w3.terrain.selectInPalette");
  await sleep(300);
  const tab = await page.evaluate(`document.querySelector(".terrain-tab.on")?.textContent`), hint = await page.evaluate(`document.querySelector(".terrain-place-hint")?.textContent`);
  if (tab !== "Objects") bad(`Select In Tool Palette left the "${tab}" tab open`);
  if (!/Placing .*hfoo/.test(hint ?? "")) bad(`the Objects tab says "${hint}" after Select In Tool Palette`);
  await picture("palette");
  await page.evaluate(`[...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent === "Select").click()`);
  await sleep(200);
  await page.evaluate(`w3.workspace.writeText("map/war3map.w3c.json", ${JSON.stringify(cameras)})`);
  await page.evaluate(`w3.settings.set("terrain.animate", true)`);
  await page.evaluate(`[...document.querySelectorAll(".model-toggle")].filter((l) => ["Water", "Effects"].includes(l.textContent.trim())).forEach((l) => l.querySelector("input").click())`);
}

/** The New Map dialog and the terrain painter, by mouse and keyboard. */
async function byHand(page, found) {
  const hands = new Hands(page), folder = join(work, "by-hand");
  mkdirSync(folder, { recursive: true });
  const fail = (what) => found.push(`by hand: ${what}`);
  const errorText = () => page.evaluate(`document.querySelector(".newmap-error")?.textContent ?? ""`);
  const dialogOpen = () => page.evaluate(`!!document.querySelector(".newmap-dialog")`);
  const openDialog = async () => {
    await page.evaluate(`void w3.commands.execute("w3.map.new")`);
    await until("the New Map dialog", dialogOpen, 20000);
  };

  // Stands for the folder picker, which is the system's.
  await page.evaluate(`(() => { w3.window.pickFolder = async () => ${JSON.stringify(folder)}; })()`);

  // Cancel and Esc leave everything as it was.
  const before = await page.evaluate(`w3.workspace.project()?.root`);
  await openDialog();
  await hands.click(".newmap-buttons button", "Cancel");
  if (await dialogOpen()) fail("Cancel left the dialog open");
  await openDialog();
  await hands.key("Escape", "Escape", 27);
  if (await dialogOpen()) fail("Esc left the dialog open");

  // What can't work is refused, with a reason.
  await openDialog();
  await hands.click(".newmap-buttons button", "Create");
  if (!/where/.test(await errorText())) fail(`no folder gave "${await errorText()}"`);
  await hands.click(".newmap-dialog button", "Browse…");
  await sleep(100);
  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".newmap-row")];
    const select = (label) => rows.find((r) => r.textContent.startsWith(label)).querySelector("select");
    const set = (label, value) => { const e = select(label); e.value = value; e.dispatchEvent(new Event("change", { bubbles: true })); e.dispatchEvent(new Event("input", { bubbles: true })); };
    set("Cliff level", "0"); set("Water", "deep");
  })()`);
  await hands.click(".newmap-buttons button", "Create");
  if (!/Deep water needs/.test(await errorText())) fail(`deep water on level 0 gave "${await errorText()}"`);
  if ((await page.evaluate(`w3.workspace.project()?.root`)) !== before) fail("a refused map changed the project");

  // Filled in by hand, and created with Enter.
  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".newmap-row")];
    const set = (label, value) => { const e = rows.find((r) => r.textContent.startsWith(label)).querySelector("select"); e.value = value; e.dispatchEvent(new Event("change", { bubbles: true })); e.dispatchEvent(new Event("input", { bubbles: true })); };
    set("Cliff level", "2"); set("Water", "none"); set("Tileset", "A");
    const [w, h] = rows.find((r) => r.textContent.startsWith("Size")).querySelectorAll("select");
    w.value = "64"; w.dispatchEvent(new Event("input", { bubbles: true }));
    h.value = "128"; h.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await hands.click("input.newmap-input");
  await hands.key("a", "KeyA", 65, 2);
  await hands.type("Typed Map");
  await hands.key("Tab", "Tab", 9);
  await hands.type("Someone");
  await hands.key("Enter", "Enter", 13);
  const root = await until("the map", () => page.evaluate(`(() => { const r = w3.workspace.project()?.root; return r && r !== ${JSON.stringify(before)} && w3.editors.activePath() ? r : null; })()`));
  if (!root.replaceAll("\\", "/").endsWith("/by-hand/Typed Map")) fail(`it went to ${root}`);
  const info = JSON.parse(readFileSync(join(root, "map", "war3map.w3i.json"), "utf8"));
  const wts = readFileSync(join(root, "map", "war3map.wts"), "utf8");
  const shown = (v) => (/^TRIGSTR_/.test(v) ? wts : v);
  if (!shown(info.name).includes("Typed Map")) fail(`its name is ${info.name}`);
  if (!shown(info.author).includes("Someone")) fail(`its author is ${info.author}`);
  if (info.tileset !== "A") fail(`its tileset is ${info.tileset}`);
  const wpm = readFileSync(join(root, "map", "war3map.wpm"));
  if (wpm.readUInt32LE(8) !== 64 * 4 || wpm.readUInt32LE(12) !== 128 * 4) fail("its size isn't the one chosen");

  // Painting: a drag on the canvas changes the ground, saving keeps it, undo takes it back.
  const ground = join(root, "map", "war3map.w3e.txt");
  const untouched = hash(ground);
  await until("the terrain view", () => page.evaluate(`[...document.querySelectorAll("button, .tab")].some((b) => b.textContent.trim() === "Terrain")`), 20000);
  await sleep(500);
  await page.evaluate(`[...document.querySelectorAll("button, .tab, [role=tab]")].find((b) => b.textContent.trim() === "Terrain").click()`);
  await sleep(300);
  const canvas = await hands.where(".terrain-view canvas, canvas");
  await hands.drag({ x: canvas.x - 60, y: canvas.y + 20 }, { x: canvas.x + 60, y: canvas.y + 20 });
  await sleep(300);
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const painted = hash(ground);
  if (painted === untouched) fail("painting changed nothing on disk");
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await sleep(300);
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  if (hash(ground) !== untouched) fail(`undo didn't take the paint back (${hash(ground) === painted ? "nothing happened" : "the file differs"})`);

  // Noise: held on the ground it roughens it while the button is down, and the whole stroke is one undo step.
  await page.evaluate(`document.querySelector('button.tool-button[title^="Noise:"]').click()`);
  if (await page.evaluate(`[...document.querySelectorAll(".terrain-tool-opt")].find((l) => l.textContent.startsWith("Strength"))?.hidden !== false`)) fail("Noise has no Strength slider");
  await hands.drag({ x: canvas.x - 40, y: canvas.y + 20 }, { x: canvas.x + 40, y: canvas.y + 20 });
  await sleep(300);
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const noisy = hash(ground);
  if (noisy === untouched) fail("a Noise stroke changed nothing on disk");
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await sleep(300);
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  if (hash(ground) !== untouched) fail(`one undo didn't take the whole Noise stroke back (${hash(ground) === noisy ? "nothing happened" : "the file differs"})`);

  await objectByHand(page, hands, root, fail);
  await triggerByHand(page, hands, root, fail);
}

/** Replaces all of a text field's text, as selecting it and typing does; Tab commits. */
async function retype(hands, selector, text) {
  await hands.click(selector);
  await hands.key("a", "KeyA", 65, 2);
  await hands.type(text);
  await hands.key("Tab", "Tab", 9);
  await sleep(150);
}

/** The Object Editor: finds the Footman, changes its hit points, saves. */
async function objectByHand(page, hands, root, fail) {
  const file = join(root, "map", "war3map.w3u.json");
  // A new map has no unit data yet: the kind's row in the side view makes the file.
  await page.evaluate(`w3.editors.closeAll()`);
  if (!existsSync(file)) await page.evaluate(`w3.workspace.writeText("map/war3map.w3u.json", JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: [] }))`);
  await page.evaluate(`w3.editors.open("map/war3map.w3u.json")`);
  await until("the object list", () => page.evaluate(`!!document.querySelector("input.obj-search")`), 30000);

  // Edit standard…, then the Footman in the picker.
  await hands.click(".obj-toolbar-buttons button", "Edit standard…");
  await until("the picker", () => page.evaluate(`document.querySelectorAll(".picker-rows > *").length > 20`), 20000);
  await hands.click("input.picker-search");
  await hands.type("hfoo");
  await sleep(300);
  await hands.key("Enter", "Enter", 13);
  await until("its fields", () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell").length > 20`), 15000);

  await hands.click("input.obj-field-search");
  await hands.type("uhpm");
  await until("the field", () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell input").length === 1`), 5000);
  await retype(hands, ".obj-table .obj-value-cell input", "777");
  await limits(page, hands, file, fail);
  if (!(await page.evaluate(`w3.editors.isDirty("map/war3map.w3u.json")`))) fail("changing a field didn't mark the file as changed");
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const objects = JSON.parse(readFileSync(file, "utf8"));
  const mod = objects.original.find((o) => o.base === "hfoo")?.mods.find((m) => m.field === "uhpm");
  if (mod?.value !== 777) fail(`the Footman's hit points are ${JSON.stringify(mod)}`);
}

/** Hit points stop at 500000 in the World Editor: past that the field warns and still saves. */
async function limits(page, hands, file, fail) {
  const flagged = () => page.evaluate(`document.querySelectorAll("tr.obj-over").length`);
  const tooltip = () => page.evaluate(`document.querySelector(".obj-table .obj-value-cell input").title`);
  if (await flagged()) fail("777 hit points were marked as outside the limits");
  if (!/range: 1 to 500000/.test(await tooltip())) fail(`the field's tooltip is "${await tooltip()}"`);
  await retype(hands, ".obj-table .obj-value-cell input", "999999");
  if ((await flagged()) !== 1) fail("999999 hit points weren't marked as outside the limits");
  if (!/Outside/.test(await tooltip())) fail(`the warning's tooltip is "${await tooltip()}"`);
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const saved = JSON.parse(readFileSync(file, "utf8")).original.find((o) => o.base === "hfoo")?.mods.find((m) => m.field === "uhpm");
  if (saved?.value !== 999999) fail(`a value past the limit was saved as ${JSON.stringify(saved)}`);
  // The filter, with no field search in the way.
  await page.evaluate(`(() => { const e = document.querySelector("input.obj-field-search"); e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await until("all the fields", () => page.evaluate(`document.querySelectorAll(".obj-table tr").length > 20`), 5000);
  await hands.click(".obj-detail-toolbar label", "Outside limits (1)");
  await until("the filter", () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell input").length === 1`), 5000);
  await hands.click(".obj-detail-toolbar label", "Outside limits (1)");
  await hands.click("input.obj-field-search");
  await hands.type("uhpm");
  await until("the field", () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell input").length === 1`), 5000);
  await retype(hands, ".obj-table .obj-value-cell input", "777");
  if (await flagged()) fail("the mark stayed after going back inside the limits");
  await speedLimits(page, hands, fail);
}

/** Movement Speed may be typed up to 522, but the game moves a unit at MaxUnitSpeed at most (400, the game's
 *  Gameplay Constants): 450 warns. The map's own Gameplay Constants (war3mapMisc.txt) count first: at 500 there,
 *  450 is fine. */
async function speedLimits(page, hands, fail) {
  const flagged = () => page.evaluate(`document.querySelectorAll("tr.obj-over").length`);
  const tooltip = () => page.evaluate(`document.querySelector(".obj-table .obj-value-cell input").title`);
  const search = async (text) => {
    await page.evaluate(`(() => { const e = document.querySelector("input.obj-field-search"); e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await hands.click("input.obj-field-search");
    await hands.type(text);
    await until(`the field ${text}`, () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell input").length === 1`), 5000);
  };
  await search("umvs");
  await retype(hands, ".obj-table .obj-value-cell input", "350");
  if (await flagged()) fail(`a Movement Speed of 350 was marked: "${await tooltip()}"`);
  await retype(hands, ".obj-table .obj-value-cell input", "450");
  if ((await flagged()) !== 1) fail("a Movement Speed of 450 wasn't marked, though the game moves units at 400 at most");
  if (!/400 at most.*Unit Speed - Maximum, the game's default/.test(await tooltip())) fail(`the speed warning's tooltip is "${await tooltip()}"`);
  // The map raises the limit: the mark goes once the file is saved, with the editor left open. The map's own file
  // (if it has one) is put back afterwards.
  const had = await page.evaluate(`w3.workspace.readText("map/war3mapMisc.txt").catch(() => null)`);
  await page.evaluate(`w3.workspace.writeText("map/war3mapMisc.txt", "[Misc]\\r\\nMaxUnitSpeed=500\\r\\n")`);
  await until("the map's Gameplay Constants", async () => (await flagged()) === 0, 5000)
    .catch(async () => fail(`with MaxUnitSpeed 500 in the map, 450 is still marked: "${await tooltip()}"`));
  await page.evaluate(`w3.workspace.writeText("map/war3mapMisc.txt", "[Misc]\\r\\nMaxUnitSpeed=420\\r\\n")`);
  await until("the lower constant", async () => (await flagged()) === 1, 5000).catch(() => fail("with MaxUnitSpeed 420 in the map, 450 isn't marked"));
  if (!/420 at most.*set by this map/.test(await tooltip())) fail(`the map constant's tooltip is "${await tooltip()}"`);
  await page.evaluate(had === null ? `w3.workspace.delete("map/war3mapMisc.txt")` : `w3.workspace.writeText("map/war3mapMisc.txt", ${JSON.stringify(had)})`);
  await retype(hands, ".obj-table .obj-value-cell input", "270");
  await search("uhpm");
}

/** The Trigger Editor: renames the map's trigger, switches it off, and Build carries both. */
async function triggerByHand(page, hands, root, fail) {
  await page.evaluate(`w3.editors.closeAll()`);
  await page.evaluate(`w3.editors.open("map/war3map.wtg.json")`);
  await until("the trigger tree", () => page.evaluate(`[...document.querySelectorAll(".trig-tree-rows .trig-label")].some((e) => e.textContent === "Initialization")`), 20000);
  // The category starts closed, so its arrow comes first.
  await page.evaluate(`[...document.querySelectorAll(".trig-tree-rows .trig-label")].find((e) => e.textContent === "Initialization").parentElement.querySelector(".trig-caret").setAttribute("data-smoke", "caret")`);
  await hands.click("[data-smoke=caret]");
  await until("the trigger's row", () => page.evaluate(`[...document.querySelectorAll(".trig-tree-rows .trig-label")].some((e) => e.textContent.trim() === "Melee Initialization")`), 5000);
  await hands.click(".trig-tree-rows .trig-label", "Melee Initialization");
  await until("the trigger", () => page.evaluate(`document.querySelector("input.trig-name")?.value === "Melee Initialization"`), 5000);
  await retype(hands, "input.trig-name", "Typed Trigger");
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const output = await page.evaluate(`w3.workspace.project().default_output`);
  const map = resolve(root, output);
  await page.evaluate(`void w3.commands.execute("w3.project.pack")`);
  await until("the build", () => existsSync(map), 20000);
  await sleep(300);
  const script = spawnSync(cli, ["cat", map, "war3map.j"], { maxBuffer: 1 << 28 }).stdout.toString("latin1");
  if (!script.includes("function InitTrig_Typed_Trigger takes")) fail("the renamed trigger isn't in the script");
  if (script.includes("InitTrig_Melee_Initialization")) fail("the old trigger name is still in the script");
  if (!script.includes("BlzCreateUnitWithSkin") && !script.includes("function main")) fail("the script looks empty");

  // Convert to Custom Text: asked first (No leaves it), then the trigger is the script the map script had for it, so the
  // packed war3map.j stays the same; one undo turns it back.
  const wtgFile = join(root, "map", "war3map.wtg.json");
  const typed = () => JSON.parse(readFileSync(wtgFile, "utf8")).items.find((i) => i.name === "Typed Trigger");
  const dirty = () => page.evaluate(`w3.editors.isDirty("map/war3map.wtg.json")`);
  await page.evaluate(`(() => { window.__asked = []; w3.window.confirm = async (m) => { window.__asked.push(m); return false; }; })()`);
  await hands.click("button.trig-convert");
  await sleep(300);
  if (!/can't be turned back/.test(await page.evaluate(`window.__asked[0] ?? ""`))) fail(`Convert to Custom Text didn't ask first: ${await page.evaluate(`JSON.stringify(window.__asked)`)}`);
  if (await dirty()) fail("answering No to Convert to Custom Text changed the trigger file");
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await hands.click("button.trig-convert");
  await until("the converted trigger's script", () => page.evaluate(`!document.querySelector("button.trig-convert") && !!document.querySelector(".trig-code, .trig-code-edit")`), 5000)
    .catch(() => fail("the trigger doesn't show as custom text after converting"));
  if (!(await dirty())) fail("converting didn't mark the trigger file as changed");
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const t = typed();
  if (!t?.isCustom || t.ecas.length || !t.runOnInit) fail(`the converted trigger is ${JSON.stringify(t)?.slice(0, 300)}`);
  rmSync(map, { force: true });
  await page.evaluate(`void w3.commands.execute("w3.project.pack")`);
  await until("the build", () => existsSync(map), 20000);
  await sleep(300);
  const after = spawnSync(cli, ["cat", map, "war3map.j"], { maxBuffer: 1 << 28 }).stdout.toString("latin1");
  if (after !== script) {
    const a = script.split("\r\n"), b = after.split("\r\n"), at = a.findIndex((l, k) => l !== b[k]);
    fail(`war3map.j changed with the conversion, from line ${at + 1}: "${a[at]}" became "${b[at]}"`);
  }
  await page.evaluate(`w3.commands.execute("workbench.undo")`);
  await sleep(300);
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  if (typed()?.isCustom !== false || !typed()?.ecas.length) fail("one undo didn't turn the converted trigger back into a GUI trigger");
}

/** Test Map when the game can't start: the user is told why, whichever way it was asked for, and
 *  nothing is left uncaught in the page (the run's `problems` list would show it). */
async function testMapWithoutGame(page, found) {
  const hands = new Hands(page);
  await page.evaluate(`w3.settings.set("game.path", "C:/no/such/Warcraft III.exe")`);
  const ways = {
    "the command": () => page.evaluate(`w3Workbench.run("w3.project.testMap")`),
    "the status bar": () => hands.click('.statusbar-item[data-id="w3.project.test"]'),
    "Ctrl+F5": () => hands.key("F5", "F5", 116, 2),
  };
  for (const [way, go] of Object.entries(ways)) {
    await page.evaluate(`document.querySelectorAll(".toast").forEach((t) => t.remove())`);
    await go();
    const toast = await until(`the error toast (${way})`, () => page.evaluate(`document.querySelector(".toast.error")?.textContent ?? null`), 60000);
    if (!/not found/.test(toast)) found.push(`test map (${way}): the toast says "${toast.slice(0, 200)}"`);
    await sleep(500);
  }
  // The Test Map options: a wrong one stops before packing, naming the setting; the backend takes only the game's
  // Test Map flags, and with good ones gets as far as starting the program (which isn't there).
  await page.evaluate(`w3.settings.set("testMap.assetMode", "4k")`);
  const wrong = await page.evaluate(`w3.commands.execute("w3.project.testMap").then(() => null, (e) => String(e))`);
  if (!/testMap\.assetMode/.test(wrong ?? "")) found.push(`test map: a wrong asset mode gave ${JSON.stringify(wrong)}`);
  await page.evaluate(`w3.settings.set("testMap.assetMode", undefined)`);
  const invoke = (args) => page.evaluate(`w3.backend.invoke("game_test_map", { exe: "C:/no/such/Warcraft III.exe", map: "C:/no/map.w3x", args: ${JSON.stringify(args)} }).then(() => null, (e) => String(e))`);
  const flag = await invoke(["-loadfile", "C:/other.w3x"]);
  if (!/isn't a Test Map option/.test(flag ?? "")) found.push(`test map: the backend let ${JSON.stringify(flag)} through for -loadfile`);
  const good = await invoke(["-windowmode", "windowed", "-hd", "0", "-mapdiff", "2", "-testmapprofile", "WorldEdit", "-fixedseed", "1"]);
  if (/isn't a Test Map option/.test(good ?? "")) found.push(`test map: the backend refused the World Editor's own flags: ${good}`);
}

/** Delete Invalid Objects, Export Minimap, .w3o export and import, and the Sound Editor's export and
 *  replace, run through the app on scratch copies of the mini map; every project they change is
 *  packed by the CLI and verified. The system's dialogs can't be reached, so their answers are put in
 *  by hand. */
async function moduleFunctions(page, found) {
  const fail = (what) => found.push(`module functions: ${what}`);
  const dir = join(work, "module-functions");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const verify = (root, label) => {
    const map = join(dir, `${label}.w3x`);
    const packed = spawnSync(cli, ["pack", root, "-o", map], { encoding: "utf8" });
    const r = packed.status === 0 ? spawnSync(cli, ["verify", "-q", map, ...(game ? ["--game", game] : [])], { encoding: "utf8" }) : packed;
    if (r.status !== 0 || !/1 ok(?! \(1 incomplete)/.test(r.stdout ?? "")) fail(`${label}: verify: ${((r.stdout ?? "") + (r.stderr ?? "")).trim().slice(-300)}`);
  };
  const json = (p) => JSON.parse(readFileSync(p, "utf8"));
  const put = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2)); };
  const openProject = async (root) => {
    await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(root)}); })()`);
    await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(root)}`));
  };
  // The system's dialogs: the next answers, and the questions asked.
  await page.evaluate(`(() => {
    window.__d = { save: null, file: null, asked: [] };
    w3.window.pickSaveFile = async () => window.__d.save;
    w3.window.pickFile = async () => window.__d.file;
    w3.window.confirm = async (m) => { window.__d.asked.push(m); return true; };
  })()`);
  const answer = (o) => page.evaluate(`Object.assign(window.__d, ${JSON.stringify(o)}, { asked: [] })`);
  const asked = () => page.evaluate(`window.__d.asked`);
  const run = (id) => page.evaluate(`w3.commands.execute(${JSON.stringify(id)}).then(() => null, (e) => String(e))`);
  const tool = async (name) => {
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
    const reply = JSON.parse(await page.evaluate(`w3.mcp.handle(${JSON.stringify(message)})`));
    if (reply.error || reply.result?.isError) throw new Error(`${name}: ${reply.result?.content?.[0]?.text ?? reply.error?.message}`);
  };
  // The extensions are activated on demand; the commands need them.
  await page.evaluate(`(async () => { const h = w3Workbench.host; await Promise.all(h.extensions.filter((e) => !e.disabled).map((e) => h.activate(e))); })()`);

  // ---- Delete Invalid Objects ---------------------------------------------------------------
  const a = join(dir, "invalid");
  cpSync(FIXTURE, a, { recursive: true });
  {
    const units = json(join(a, "map", "war3mapUnits.doo.json"));
    const doodads = json(join(a, "map", "war3map.doo.json"));
    const hfoo = units.units[0];
    units.units.push({ ...hfoo, id: "zzzz", skinId: "zzzz" }, { ...hfoo, id: "sloc", skinId: "sloc" }, { ...hfoo, id: "zzzz", skinId: "zzzz" });
    doodads.doodads.push({ ...doodads.doodads[0], id: "QQQQ", skinId: "QQQQ" });
    put(join(a, "map", "war3mapUnits.doo.json"), units);
    put(join(a, "map", "war3map.doo.json"), doodads);
    const before = doodads.doodads.length - 1;
    await openProject(a);
    await answer({});
    const err = await run("w3.problems.deleteInvalid");
    if (err) fail(`Delete Invalid Objects: ${err}`);
    const question = (await asked())[0] ?? "";
    if (!/Delete 3 placed objects of 2 unknown types \((zzzz ×2, QQQQ ×1|QQQQ ×1, zzzz ×2)\)/.test(question)) fail(`Delete Invalid Objects asked "${question}"`);
    const after = json(join(a, "map", "war3mapUnits.doo.json")).units.map((u) => u.id);
    if (after.join() !== "hfoo,sloc") fail(`placed units after: ${after.join()}`);
    const left = json(join(a, "map", "war3map.doo.json")).doodads;
    if (left.length !== before || left.some((d) => d.id === "QQQQ")) fail(`placed doodads after: ${left.map((d) => d.id).join()}`);
    const checkpoints = existsSync(join(a, "build", "checkpoints")) ? readdirSync(join(a, "build", "checkpoints")) : [];
    if (!checkpoints.length) fail("Delete Invalid Objects made no checkpoint");
    // The same again finds nothing and asks nothing.
    await answer({});
    await run("w3.problems.deleteInvalid");
    if ((await asked()).length) fail("Delete Invalid Objects asked with nothing to delete");
    verify(a, "invalid");
  }

  // ---- Delete Invalid Objects in a chapter of a campaign ----------------------------------------
  // The chapter's objects come from the campaign project two folders up: none of its placed
  // objects may count as invalid. W3_SMOKE_CHAPTER (a folder holding the campaign's `map` and the
  // chapter, as "campaign|maps/Chapter.w3x") runs the same on a real campaign.
  {
    const camp = join(dir, "camp");
    const chapter = join(camp, "maps", "Chapter 1.w3x");
    cpSync(FIXTURE, chapter, { recursive: true });
    put(join(camp, "map", "war3campaign.w3f.json"), {});
    put(join(camp, "map", "war3campaign.w3u.json"), { format: "w3proj.objects/1", version: 3, original: [], custom: [{ base: "hfoo", id: "c001", mods: [{ field: "unam", type: "string", value: "Campaign Footman" }] }] });
    put(join(camp, "map", "war3campaignSkin.w3u.json"), { format: "w3proj.objects/1", version: 3, original: [], custom: [{ base: "hfoo", id: "c002", mods: [] }] });
    const units = json(join(chapter, "map", "war3mapUnits.doo.json"));
    units.units.push({ ...units.units[0], id: "c001", skinId: "c001" }, { ...units.units[0], id: "c002", skinId: "c002" });
    put(join(chapter, "map", "war3mapUnits.doo.json"), units);
    await openProject(chapter);
    await answer({});
    const before = readFileSync(join(chapter, "map", "war3mapUnits.doo.json"), "utf8");
    const err = await run("w3.problems.deleteInvalid");
    if (err) fail(`Delete Invalid Objects in a chapter: ${err}`);
    if ((await asked()).length) fail(`Delete Invalid Objects in a chapter offered: ${(await asked())[0]}`);
    if (readFileSync(join(chapter, "map", "war3mapUnits.doo.json"), "utf8") !== before) fail("Delete Invalid Objects changed a chapter's valid objects");
    if (existsSync(join(chapter, "build", "checkpoints"))) fail(`Delete Invalid Objects made a checkpoint with nothing to delete: ${readdirSync(join(chapter, "build", "checkpoints")).join(", ")}`);
  }
  if (process.env.W3_SMOKE_CHAPTER) {
    const [campSrc, chapterRel] = process.env.W3_SMOKE_CHAPTER.split("|");
    const camp = join(dir, "real-camp");
    mkdirSync(join(camp, "maps"), { recursive: true });
    cpSync(join(campSrc, "map"), join(camp, "map"), { recursive: true });
    cpSync(join(campSrc, chapterRel), join(camp, chapterRel), { recursive: true });
    const chapter = join(camp, chapterRel);
    const unitsFile = join(chapter, "map", "war3mapUnits.doo.json");
    const doodadsFile = join(chapter, "map", "war3map.doo.json");
    const placed = (existsSync(unitsFile) ? json(unitsFile).units.length : 0) + (existsSync(doodadsFile) ? json(doodadsFile).doodads.length : 0);
    await openProject(chapter);
    await answer({});
    const err = await run("w3.problems.deleteInvalid");
    if (err) fail(`real chapter: ${err}`);
    console.log(`real chapter: ${placed} placed objects, question asked: ${JSON.stringify((await asked())[0] ?? null)}`);
    if ((await asked()).length) fail(`the real chapter offered to delete: ${(await asked())[0]}`);
  }

  // ---- Export Minimap -----------------------------------------------------------------------
  const b = join(dir, "minimap");
  cpSync(FIXTURE, b, { recursive: true });
  {
    await openProject(b);
    try { await tool("rebuild_map"); } catch (e) { fail(`rebuild_map: ${e.message}`); }
    await until("the minimap", () => existsSync(join(b, "map", "war3mapMap.blp")), 20000).catch(() => fail("no war3mapMap.blp to export"));
    const out = join(dir, "minimap-out.png");
    await answer({ save: out });
    /** The PNG's size and its pixels' colours (one IDAT chunk, as lib/image/png writes it). */
    const picture = (file) => {
      const png = readFileSync(file);
      if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
      const size = png.readUInt32BE(16), raw = inflateSync(png.subarray(41, png.length - 12));
      return { size, height: png.readUInt32BE(20), at: (x, y) => raw.readUIntBE(y * (1 + size * 4) + 1 + x * 4, 3), raw };
    };
    // The dialog, by its controls: 512 pixels, the pathing map too.
    await page.evaluate(`(() => { window.__export = w3.commands.execute("w3.terrain.exportMinimap").then(() => null, (e) => String(e)); return null; })()`);
    await until("the Export Minimap dialog", () => page.evaluate(`!!document.querySelector(".minimap-export-dialog")`), 20000).catch(() => fail("Export Minimap shows no dialog"));
    await page.evaluate(`(() => { const d = document.querySelector(".minimap-export-dialog"); if (!d) return;
      const s = d.querySelector(".minimap-size"); s.value = "512"; s.dispatchEvent(new Event("change"));
      d.querySelector("[data-option=pathing]").checked = true; d.querySelector(".newmap-buttons button.primary").click(); })()`);
    const err = await page.evaluate(`window.__export`);
    if (err) fail(`Export Minimap: ${err}`);
    else if (!existsSync(out)) fail("Export Minimap wrote no file");
    else {
      const p = picture(out);
      if (!p) fail("the minimap file isn't a PNG");
      else if (p.size !== 512 || p.height !== 512) fail(`the minimap is ${p.size}x${p.height}, not the chosen 512`);
      else {
        // The pixels are the map's: not one flat colour.
        const colours = new Set();
        for (let y = 0; y < 512; y += 2) for (let x = 0; x < 512; x += 8) colours.add(p.at(x, y));
        if (colours.size < 4) fail(`the exported minimap has ${colours.size} colours`);
      }
    }
    // From the terrain editor as it is: a tile replaced and not saved shows; the saved ground stays. The whole map: the
    // mini map's playable area is a line.
    const given = { size: 64, doodads: false, units: false, icons: false, smooth: false, playableOnly: false };
    const exportWith = async (o, file) => { await answer({ save: file }); return page.evaluate(`w3.commands.execute("w3.terrain.exportMinimap", ${JSON.stringify(o)}).then(() => null, (e) => String(e))`); };
    const first = join(dir, "minimap-a.png"), second = join(dir, "minimap-b.png");
    const ground = readFileSync(join(b, "map", "war3map.w3e.txt"));
    const why = (await exportWith(given, first)) ?? (await page.evaluate(`w3.commands.execute("w3.terrain.replaceTiles", { from: "Lgrs", to: "Lrok" }).then(() => null, (e) => String(e))`)) ?? (await exportWith(given, second));
    if (why) fail(`Export Minimap of an unsaved edit: ${why}`);
    else {
      if (picture(first).raw.equals(picture(second).raw)) fail("the exported minimap doesn't show the unsaved tile change");
      if (!readFileSync(join(b, "map", "war3map.w3e.txt")).equals(ground)) fail("exporting the minimap saved the terrain");
      if (!(await page.evaluate(`w3.editors.isDirty("map/war3map.w3e.txt")`))) fail("the replaced tiles aren't unsaved");
      await page.evaluate(`w3.commands.execute("workbench.undo")`);
      await sleep(300);
    }
    await page.evaluate(`w3.editors.closeAll()`);
    verify(b, "minimap");
  }

  // ---- .w3o: export all, import, export one -------------------------------------------------
  const c = join(dir, "objects");
  cpSync(FIXTURE, c, { recursive: true });
  put(join(c, "map", "war3map.w3u.json"), {
    format: "w3proj.objects/1", version: 3,
    original: [{ base: "hpea", mods: [{ field: "uhpm", type: "int", value: 99 }] }, { base: "hkni", mods: [] }],
    custom: [{ base: "hfoo", id: "h000", mods: [{ field: "unam", type: "string", value: "Smoke Footman" }] }],
  });
  put(join(c, "map", "war3map.w3q.json"), { format: "w3proj.objects/1", version: 3, original: [], custom: [{ base: "Rhme", id: "R000", mods: [{ field: "gnam", type: "string", level: 1, data: 0, value: "Smoke Upgrade" }] }] });
  {
    await openProject(c);
    const out = join(dir, "all-object-data");
    await answer({ save: out });
    const err = await run("w3.objects.exportAll");
    if (err) fail(`Export All Object Data: ${err}`);
    const file = `${out}.w3o`;
    if (!existsSync(file)) fail("Export All Object Data wrote no .w3o");
    else {
      const bin = readFileSync(file);
      // Version 1, units present first; both kinds' texts are in it.
      if (bin.readUInt32LE(0) !== 1 || bin.readUInt32LE(4) !== 1 || !bin.includes(Buffer.from("Smoke Footman")) || !bin.includes(Buffer.from("Smoke Upgrade"))) fail(`the .w3o starts ${bin.subarray(0, 12).toString("hex")}`);
      // Into a copy that has none of it: the file brings everything back.
      const d = join(dir, "objects-in");
      cpSync(FIXTURE, d, { recursive: true });
      await openProject(d);
      await answer({ file });
      const e2 = await run("w3.objects.importAll");
      if (e2) fail(`Import Object Data: ${e2}`);
      else {
        const u = json(join(d, "map", "war3map.w3u.json"));
        // The copy keeps the mini map's own change to the Footman, and gains the file's.
        const peasant = u.original.find((o) => o.base === "hpea");
        if (u.custom.map((o) => o.id).join() !== "h000" || !peasant || !u.original.some((o) => o.base === "hfoo")) fail(`imported units: ${JSON.stringify(u).slice(0, 200)}`);
        else if (u.custom[0].mods[0].value !== "Smoke Footman" || peasant.mods[0].value !== 99) fail("imported unit values differ");
        const q = json(join(d, "map", "war3map.w3q.json"));
        if (q.custom[0]?.id !== "R000" || q.custom[0].mods[0].level !== 1) fail(`imported upgrades: ${JSON.stringify(q).slice(0, 200)}`);
        if (!(await asked())[0]?.includes("2 units")) fail(`Import asked "${(await asked())[0]}"`);
        if (!existsSync(join(d, "build", "checkpoints"))) fail("Import made no checkpoint");
      }
      verify(d, "objects-in");
    }

    // One object, from the Object Editor list's menu, as the user would.
    await openProject(c);
    const one = join(dir, "one-object.w3o");
    await answer({ save: one });
    await page.evaluate(`w3.editors.open("map/war3map.w3u.json")`);
    await until("the object list", () => page.evaluate(`[...document.querySelectorAll(".obj-item")].some((e) => e.textContent.includes("Smoke Footman"))`), 30000);
    await page.evaluate(`[...document.querySelectorAll(".obj-item")].find((e) => e.textContent.includes("Smoke Footman")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }))`);
    await until("the menu", () => page.evaluate(`[...document.querySelectorAll(".context-menu-item")].some((e) => e.textContent.startsWith("Export Object"))`), 5000);
    await page.evaluate(`[...document.querySelectorAll(".context-menu-item")].find((e) => e.textContent.startsWith("Export Object")).click()`);
    await until("the file", () => existsSync(one), 10000).catch(() => fail("Export Object wrote no file"));
    if (existsSync(one)) {
      const bin = readFileSync(one);
      if (bin.readUInt32LE(0) !== 1 || bin.readUInt32LE(4) !== 1 || !bin.includes(Buffer.from("Smoke Footman")) || bin.includes(Buffer.from("hpea"))) fail("Export Object: the file isn't one object of units");
    }
    await page.evaluate(`w3.editors.closeAll()`);
    verify(c, "objects");
  }

  // ---- Sound Editor: export and replace -----------------------------------------------------
  const s = join(dir, "sounds");
  cpSync(FIXTURE, s, { recursive: true });
  {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x40, 0x1f, 0, 0, 1, 0, 8, 0]), Buffer.from("data"), Buffer.from([4, 0, 0, 0, 128, 130, 128, 126])]);
    mkdirSync(join(s, "map", "war3mapImported"), { recursive: true });
    writeFileSync(join(s, "map", "war3mapImported", "boom.wav"), wav);
    put(join(s, "map", "war3map.imp.json"), { format: "w3proj.imports/1", version: 1, files: [{ flags: 21, path: "war3mapImported\\boom.wav" }, { flags: 5, path: "readme.txt" }] });
    put(join(s, "map", "war3map.w3s.json"), {
      format: "w3proj.sounds/1", version: 3,
      sounds: [{
        name: "gg_snd_boom", file: "war3mapImported\\boom.wav", eaxEffect: "DefaultEAXON", flags: 16, fadeInRate: 10, fadeOutRate: 10, volume: 127, pitch: 1, pitchVariance: 0, priority: 8,
        channel: 0, minDistance: 0, maxDistance: 10000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0, coneOutsideVolume: 0, coneOrientation: [0, 0, 0],
        variableName: "gg_snd_boom", assetLabel: "", assetFile: "", dialogueTextKey: -1, dialogueText: "", speakerNameKey: -1, speakerName: "", unknown1: 0,
        speakerUnitType: "", facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "", unknown2: 1,
      }],
    });
    await openProject(s);
    verify(s, "sounds-before");
    await page.evaluate(`void w3.commands.execute("w3.sounds.open")`);
    await until("the sound list", () => page.evaluate(`!!document.querySelector("tr.snd-row")`), 20000);
    await page.evaluate(`document.querySelector("tr.snd-row").click()`);
    const out = join(dir, "boom-out.wav");
    await answer({ save: out });
    const err = await run("w3.sounds.export");
    if (err) fail(`Export Sound: ${err}`);
    else if (!existsSync(out) || !readFileSync(out).equals(wav)) fail("the exported sound isn't the map's file");

    const mp3 = join(dir, "replacement.mp3");
    const mp3Bytes = Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64, 0x55)]);
    writeFileSync(mp3, mp3Bytes);
    await answer({ file: mp3 });
    const e2 = await run("w3.sounds.replace");
    if (e2) fail(`Replace Internal Sound: ${e2}`);
    else {
      const now = join(s, "map", "war3mapImported", "boom.mp3");
      if (!existsSync(now) || !readFileSync(now).equals(mp3Bytes)) fail("the replacement isn't in the map");
      if (existsSync(join(s, "map", "war3mapImported", "boom.wav"))) fail("the replaced sound is still in the map");
      const imp = json(join(s, "map", "war3map.imp.json")).files.map((f) => f.path);
      if (imp.join() !== "war3mapImported\\boom.mp3,readme.txt") fail(`the import list: ${imp.join()}`);
      if (!existsSync(join(s, "build", "checkpoints"))) fail("Replace Internal Sound made no checkpoint");
      // The sound still names its file; the game takes it under the other extension.
      if (json(join(s, "map", "war3map.w3s.json")).sounds[0].file !== "war3mapImported\\boom.wav") fail("the sound entry changed");
    }
    await page.evaluate(`w3.editors.closeAll()`);
    verify(s, "sounds-after");
  }
}

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const snapshot = (dir) => new Map(walk(dir).map((p) => [relative(dir, p).replaceAll("\\", "/"), hash(p)]));

/** Copying objects between maps brings what they refer to. Map A has a custom hero with a custom ability that uses a custom
 *  buff, and a custom barracks that trains a custom unit. The hero and the barracks are copied in the Object Editor
 *  (Ctrl+C) and pasted (Ctrl+V) into map B, which has none of it: the question lists what comes along, the answer is
 *  clicked, and B gets the hero under a new id, the ability and the buff under theirs, with the references in place. A copy
 *  pasted again finds them there and asks nothing. Then the buff changes in A: a paste now asks, and "Paste them under new
 *  ids" makes the hero use a new ability that uses a new buff while the old ones stay, in one undo step; "Overwrite" changes
 *  B's buff. Last, placed units copied in the terrain view (Ctrl+C, Ctrl+V) bring their types into a third map. Every
 *  project is packed and verified by the CLI. */
async function objectCopy(page, found) {
  const fail = (what) => found.push(`object copy: ${what}`);
  const tool = mcpTool(page), hands = new Hands(page);
  const folder = join(work, "object-copy");
  mkdirSync(folder, { recursive: true });
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  const rootOf = () => page.evaluate(`w3.workspace.project()?.root`);
  const readIn = (root, file) => { const p = join(root, "map", file); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { custom: [], original: [] }; };
  const customs = (root, ext) => readIn(root, `war3map.${ext}.json`).custom;
  const idOf = async (name, args) => JSON.parse(await tool(name, args)).id;
  const save = async () => { await page.evaluate(`w3.editors.saveAll()`); await sleep(400); };
  const verify = async (root, name) => {
    const map = join(folder, `${name}.w3x`);
    await page.evaluate(`w3.backend.invoke("project_pack", { root: ${JSON.stringify(root)}, output: ${JSON.stringify(map)} })`);
    await until("the pack", () => existsSync(map), 20000);
    const verified = spawnSync(cli, ["verify", "-q", map, ...(game ? ["--game", game] : [])], { encoding: "utf8" });
    if (verified.status !== 0 || !/1 ok(?! \(1 incomplete)/.test(verified.stdout)) fail(`verify ${name}: ${(verified.stdout + verified.stderr).trim().slice(-300)}`);
  };
  const newMap = async (name) => {
    await tool("new_map", { name, width: 64, height: 64, folder: join(folder, name) });
    await until("the new map", () => page.evaluate(`w3.workspace.project()?.name === ${JSON.stringify(name)}`), 30000);
    // A new map opens its terrain editor: closed only once it is there, or it would open later over what follows.
    await until("the new map's terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 30000);
    await page.evaluate(`w3.editors.closeAll()`);
    return rootOf();
  };
  const openEditor = async (ext) => {
    await page.evaluate(`w3.editors.closeAll()`);
    await page.evaluate(`w3.commands.execute("w3.objectEditor.open", ${JSON.stringify(ext)})`);
    await until("the object list", () => page.evaluate(`!!document.querySelector("input.obj-search") && !!document.querySelector(".obj-list .obj-group")`), 30000);
  };
  /** How many edits the edit log of the open project holds. A paste that changes several files is one edit, which joins
   *  the log after the last of its writes: the files are read only then, not between two of its writes. */
  const edits = async () => JSON.parse(await tool("list_edits")).length;
  /** Clicks an object of the list by its id, so the list has the keyboard. The list can still be drawn again under the
   *  pointer (a click would then pick its neighbour, and Ctrl+C copy that): clicked until it is the one selected. */
  const pickItem = async (id) => {
    const selected = () => page.evaluate(`[...document.querySelectorAll(".obj-item.selected")].map((x) => x.querySelector("code")?.textContent)`);
    await until(`${id} selected in the list`, async () => {
      const at = await page.evaluate(`(() => {
        const e = [...document.querySelectorAll(".obj-item")].find((x) => x.querySelector("code")?.textContent === ${JSON.stringify(id)});
        if (!e) return null;
        e.scrollIntoView({ block: "center" });
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!at) throw new Error(`no ${id} in the list`);
      await hands.mouse("mouseMoved", at.x, at.y);
      await hands.mouse("mousePressed", at.x, at.y, 1);
      await hands.mouse("mouseReleased", at.x, at.y);
      return (await selected()).join() === id;
    }, 20000).catch(async (e) => { throw new Error(`${e.message} (selected: ${JSON.stringify(await selected())})`); });
  };
  // No wait after it: the copy is finished while the next map is being made, and must still be the first map's.
  const copyKey = () => hands.key("c", "KeyC", 67, 2);
  const pasteKey = () => hands.key("v", "KeyV", 86, 2);
  /** The question a paste asks: its choices, and clicks one. */
  const answer = async (label, step = label) => {
    const choices = await until("the paste question", () => page.evaluate(`(() => { if (document.querySelector(".quick-input")?.hidden) return null; const l = [...document.querySelectorAll(".quick-input-item .label")].map((e) => e.textContent); return l.length ? l : null; })()`), 30000).catch(async (e) => { throw new Error(`${e.message} (waiting to answer ${label}, ${step}) | unsaved: ${await page.evaluate(`JSON.stringify(w3.editors.unsavedPaths())`)} active: ${await page.evaluate(`w3.editors.activePath() + " " + (document.activeElement?.className ?? "")`)} project: ${await page.evaluate(`w3.workspace.project()?.name`)} | toasts: ${await page.evaluate(`[...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ")`)}`); });
    if (label) await hands.click(".quick-input-item .label", label);
    return choices;
  };
  const detailOfQuestion = () => page.evaluate(`[...document.querySelectorAll(".quick-input-item .detail")].map((e) => e.textContent).join(" || ")`);
  const asking = () => page.evaluate(`document.querySelector(".quick-input") != null && !document.querySelector(".quick-input").hidden`);

  // Map A: the objects.
  const a = await newMap("CopyFrom");
  const buff = await idOf("create_object", { kind: "buffs", base: "Bslo", name: "Smoke Buff" });
  const ability = await idOf("create_object", { kind: "abilities", base: "Aslo", name: "Smoke Slow" });
  await tool("set_object_fields", { kind: "abilities", id: ability, changes: [{ field: "abuf", level: 1, value: buff }] });
  const hero = await idOf("create_object", { kind: "units", base: "Hpal", name: "Smoke Hero" });
  await tool("set_object_fields", { kind: "units", id: hero, changes: [{ field: "uhab", value: ability }] });
  const barracks = await idOf("create_object", { kind: "units", base: "hbar", name: "Smoke Barracks" });
  const trainee = await idOf("create_object", { kind: "units", base: "hfoo", name: "Smoke Trainee" });
  await tool("set_object_fields", { kind: "units", id: barracks, changes: [{ field: "utra", value: trainee }] });
  await save();
  // Reforged maps keep names, art and tooltips of objects in war3mapSkin.*: the buff has a tooltip only there.
  const skinFile = (root, entries) => page.evaluate(`(async () => { await w3.workspace.writeText("map/war3mapSkin.w3h.json", ${JSON.stringify(JSON.stringify({ format: "w3proj.objects/1", version: readIn(root, "war3map.w3h.json").version ?? 3, original: [], custom: entries }))}); await w3.workspace.refresh(); })()`);
  await skinFile(a, [{ base: "Bslo", id: buff, mods: [{ field: "ftip", type: "string", value: "Skin Tip" }] }]);

  // Map B has none of it. The hero is pasted.
  await openEditor("w3u");
  await pickItem(hero);
  await copyKey();
  const b = await newMap("CopyTo");
  if (customs(b, "w3u").length || customs(b, "w3a").length) fail("map B isn't empty to begin with");
  await openEditor("w3u");
  await hands.click(".obj-list");
  await pasteKey();
  const choices = await answer(null, "the hero into map B");
  const detail = await detailOfQuestion();
  if (!choices.some((c) => /^Paste with 2 objects it refers to$/.test(c)) || !choices.some((c) => /without/.test(c))) fail(`the question for the hero offers ${JSON.stringify(choices)}`);
  if (!detail.includes("Smoke Slow") || !detail.includes("Smoke Buff")) fail(`the question doesn't list what comes along: ${detail}`);
  await hands.click(".quick-input-item .label", "Paste with 2 objects it refers to");
  await until("the pasted files", () => customs(b, "w3a").length === 1 && customs(b, "w3h").length === 1 && customs(b, "w3u").length === 1, 20000);
  const heroB = customs(b, "w3u")[0], abilityB = customs(b, "w3a")[0], buffB = customs(b, "w3h")[0];
  const field = (o, id) => [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)].find((m) => m.field === id)?.value;
  if (heroB.base !== "Hpal" || field(heroB, "uhab") !== abilityB.id) fail(`the pasted hero: ${JSON.stringify(heroB)}`);
  if (abilityB.base !== "Aslo" || field(abilityB, "abuf") !== buffB.id || buffB.base !== "Bslo") fail(`the pasted ability and buff: ${JSON.stringify([abilityB, buffB])}`);
  if (abilityB.id !== ability || buffB.id !== buff) fail(`the ability and buff should keep their ids in a map without them: ${abilityB.id} ${buffB.id}`);
  if (field(buffB, "fnam") !== "Smoke Buff" && !JSON.stringify(buffB).includes("Smoke Buff")) fail(`the pasted buff lost its name: ${JSON.stringify(buffB)}`);
  if (field(buffB, "ftip") !== "Skin Tip") fail(`the pasted buff lost its Skin fields: ${JSON.stringify(buffB)}`);
  await until("the toast", () => page.evaluate(`[...document.querySelectorAll(".toast")].some((t) => /Pasted 1 object and 2 objects they refer to/.test(t.textContent))`), 10000).catch(() => fail("no message about what was pasted"));
  await verify(b, "CopyTo-1");

  // Pasted again, it finds them there: nothing to ask, and the hero comes as another new object.
  await openEditor("w3u");
  await hands.click(".obj-list");
  await pasteKey();
  await until("the second hero", async () => (await asking()) || (await save(), customs(b, "w3u").length === 2), 20000);
  if (await asking()) fail("the second paste asked about objects that are there already");
  await save();
  if (customs(b, "w3u").length !== 2 || customs(b, "w3a").length !== 1 || customs(b, "w3h").length !== 1) fail(`a second paste: ${customs(b, "w3u").length} units, ${customs(b, "w3a").length} abilities, ${customs(b, "w3h").length} buffs`);
  const hero2 = customs(b, "w3u").find((o) => o.id !== heroB.id);
  if (hero2 && field(hero2, "uhab") !== abilityB.id) fail("the second hero doesn't use the ability that was there");

  // The barracks trains another custom unit, which comes along into a map that has neither.
  await page.evaluate(`w3.workspace.open(${JSON.stringify(a)})`);
  await until("map A", () => page.evaluate(`w3.workspace.project()?.name === "CopyFrom"`), 30000);
  await openEditor("w3u");
  await pickItem(barracks);
  await copyKey();
  await page.evaluate(`w3.workspace.open(${JSON.stringify(b)})`);
  await until("map B", () => page.evaluate(`w3.workspace.project()?.name === "CopyTo"`), 30000);
  await openEditor("w3u");
  await hands.click(".obj-list");
  await pasteKey();
  await answer("Paste with 1 object it refers to");
  await until("the barracks", async () => (await save(), customs(b, "w3u").length === 4), 20000);
  const traineeB = customs(b, "w3u").find((o) => o.id === trainee);
  const barracksB = customs(b, "w3u").find((o) => o.base === "hbar");
  if (!traineeB || traineeB.base !== "hfoo" || !barracksB || field(barracksB, "utra") !== trainee) fail(`the barracks and its trainee: ${JSON.stringify([barracksB, traineeB])}`);
  await verify(b, "CopyTo-2");

  // The buff changes in A. B's buff now differs, so a paste asks.
  await page.evaluate(`w3.workspace.open(${JSON.stringify(a)})`);
  await until("map A again", () => page.evaluate(`w3.workspace.project()?.name === "CopyFrom"`), 30000);
  await tool("set_object_fields", { kind: "buffs", id: buff, changes: [{ field: "fnam", value: "Smoke Buff Changed" }] });
  await save();
  await openEditor("w3u");
  await pickItem(hero);
  await copyKey();
  await page.evaluate(`w3.workspace.open(${JSON.stringify(b)})`);
  await until("map B again", () => page.evaluate(`w3.workspace.project()?.name === "CopyTo"`), 30000);
  await openEditor("w3u");
  const before = { u: JSON.stringify(customs(b, "w3u")), a: JSON.stringify(customs(b, "w3a")), h: JSON.stringify(customs(b, "w3h")) };
  const editsBeforeNewIds = await edits();
  await hands.click(".obj-list");
  await pasteKey();
  const conflict = await answer(null, "the hero with a changed buff");
  for (const want of [/^Keep this map's versions$/, /^Overwrite them/, /^Paste them under new ids$/, /^Paste without/]) if (!conflict.some((c) => want.test(c))) fail(`the question about a differing buff lacks ${want}: ${JSON.stringify(conflict)}`);
  await hands.click(".quick-input-item .label", "Paste them under new ids");
  await until("the paste under new ids, written", async () => (await edits()) > editsBeforeNewIds, 20000);
  await until("new ids", () => customs(b, "w3h").length === 2, 20000);
  const hs = customs(b, "w3h"), as = customs(b, "w3a"), us = customs(b, "w3u");
  const newBuff = hs.find((o) => o.id !== buff), newAbility = as.find((o) => o.id !== ability);
  const newHero = us.find((o) => o.base === "Hpal" && field(o, "uhab") === newAbility?.id);
  if (!newBuff || !newAbility || !newHero || field(newAbility, "abuf") !== newBuff.id) fail(`new ids: ${JSON.stringify([newBuff, newAbility, newHero])}`);
  if (JSON.stringify(hs.find((o) => o.id === buff)) !== JSON.stringify(JSON.parse(before.h).find((o) => o.id === buff))) fail("B's own buff changed when the copy was pasted under new ids");
  await verify(b, "CopyTo-3");
  // One undo takes the whole paste back.
  await page.evaluate(`w3.commands.execute("w3.mcp.undo")`);
  await until("the undo", () => JSON.stringify(customs(b, "w3h")) === before.h && JSON.stringify(customs(b, "w3a")) === before.a && JSON.stringify(customs(b, "w3u")) === before.u, 20000)
    .catch(() => fail("one undo didn't take the paste back in all three files"));

  // Overwrite: B's buff takes the copied content under the same id, and B's old Skin entry for it goes.
  await skinFile(b, [{ base: "Bslo", id: buff, mods: [{ field: "ftip", type: "string", value: "stale" }, { field: "fnam", type: "string", value: "stale name" }] }]);
  await openEditor("w3u");
  const editsBeforeOverwrite = await edits();
  await hands.click(".obj-list");
  await pasteKey();
  const overwriteChoices = await answer(null, "the overwrite");
  const overwriteDetail = await detailOfQuestion();
  if (!/B\w+: \d+ objects?, \d+ placed/.test(overwriteDetail) || !overwriteChoices.some((c) => /^Overwrite/.test(c))) fail(`the overwrite choice doesn't say what uses the buff: ${overwriteDetail}`);
  await hands.click(".quick-input-item .label", "Overwrite them with the copied versions");
  // The buff's file is written before its Skin file: the Skin file is judged once the whole edit is in.
  await until("the overwrite, written", async () => (await edits()) > editsBeforeOverwrite, 20000).catch(() => fail("the overwrite made no edit"));
  await until("the overwrite", () => customs(b, "w3u").length === 5 && JSON.stringify(customs(b, "w3h")).includes("Smoke Buff Changed"), 20000).catch(() => { /* said below */ });
  if (customs(b, "w3h").length !== 1 || !JSON.stringify(customs(b, "w3h")[0]).includes("Smoke Buff Changed")) fail(`overwriting the buff: ${JSON.stringify(customs(b, "w3h"))}`);
  if ((readIn(b, "war3mapSkin.w3h.json").custom ?? []).some((o) => o.id === buff)) fail("the overwritten buff kept its old Skin entry");
  if (field(customs(b, "w3h")[0], "ftip") !== "Skin Tip") fail(`the overwritten buff: ${JSON.stringify(customs(b, "w3h")[0])}`);
  await verify(b, "CopyTo-4");

  // Placed custom units copied in the terrain view bring their types into a third map.
  await page.evaluate(`w3.workspace.open(${JSON.stringify(a)})`);
  await until("map A for the terrain", () => page.evaluate(`w3.workspace.project()?.name === "CopyFrom"`), 30000);
  await tool("place_objects", { objects: [{ id: hero, x: 0, y: 0, player: 1 }], ignoreRoom: true });
  await save();
  await page.evaluate(`w3.editors.closeAll()`);
  await page.evaluate(`w3.editors.open("map/war3map.w3e.txt")`);
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  const terrainKeys = async () => {
    await page.evaluate(`[...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent === "Select")?.click()`);
    await until("the Select tab", () => page.evaluate(`[...document.querySelectorAll(".terrain-tab.on")].some((b) => b.textContent === "Select")`), 10000);
    await page.evaluate(`document.querySelector(".model-stage canvas").focus()`);
  };
  const selectionText = () => page.evaluate(`document.querySelector(".terrain-selection")?.textContent ?? ""`);
  /** The placed objects the open terrain editor holds, start locations left out. */
  const placedLive = () => page.evaluate(`(async () => ((await w3.services.get("w3.terrain")).placedObjects()?.units ?? []).filter((u) => u.id !== "sloc").length)()`);
  await terrainKeys();
  // Ctrl+A selects the objects the view has drawn. Until the hero is drawn it selects nothing, and Ctrl+C would leave
  // the clipboard of an earlier check: pressed again until the hero is the selection.
  await until("the hero, selected by Ctrl+A", async () => {
    await page.evaluate(`document.querySelector(".model-stage canvas").focus()`);
    await hands.key("a", "KeyA", 65, 2);
    return (await selectionText()).includes(`· ${hero}`);
  }, 30000).catch(async (e) => { throw new Error(`${e.message} (the selection says "${await selectionText()}")`); });
  await hands.key("c", "KeyC", 67, 2);
  await sleep(1500);
  const c = await newMap("CopyTerrain");
  // C has another unit under the hero's id, so the paste has to give the hero a new one.
  await page.evaluate(`w3.workspace.writeText("map/war3map.w3u.json", ${JSON.stringify(JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: [{ base: "hfoo", id: hero, mods: [] }] }))}).then(() => w3.workspace.refresh())`);
  await page.evaluate(`w3.editors.open("map/war3map.w3e.txt")`);
  await until("the terrain editor of C", () => page.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
  await terrainKeys();
  await until("the paste to start", async () => {
    await page.evaluate(`document.querySelector(".model-stage canvas").focus()`);
    await hands.key("v", "KeyV", 86, 2);
    return (await selectionText()).startsWith("Pasting");
  }, 30000).catch(async (e) => { throw new Error(`${e.message} (the selection says "${await selectionText()}")`); });
  if (!(await selectionText()).startsWith("Pasting 1 object.")) fail(`the paste in map C isn't the copied hero: "${await selectionText()}"`);
  const canvas = await hands.where(".model-stage canvas");
  await hands.mouse("mouseMoved", canvas.x, canvas.y);
  await hands.click(".model-stage canvas");
  const terrainChoices = await answer(null, "the terrain paste into map C");
  if (!terrainChoices.some((x) => /^Paste them under new ids$/.test(x))) fail(`the terrain paste asks ${JSON.stringify(terrainChoices)}`);
  await hands.click(".quick-input-item .label", "Paste them under new ids");
  await until("the types in map C", () => customs(c, "w3u").length === 2 && customs(c, "w3a").length === 1 && customs(c, "w3h").length === 1, 20000);
  await until("the first pasted hero", async () => (await placedLive()) === 1, 20000).catch(async () => fail(`the first click of the paste placed ${await placedLive()} objects`));
  // The same paste session places again: no new question, no second copy of the types.
  await hands.click(".model-stage canvas");
  await until("the second pasted hero, or a question", async () => (await asking()) || (await placedLive()) === 2, 20000).catch(() => { /* said below */ });
  if (await asking()) fail("a second click of the same paste asked again");
  await page.evaluate(`w3.editors.saveAll()`);
  await until("the saved heroes", () => (readIn(c, "war3mapUnits.doo.json").units?.filter((u) => u.id !== "sloc") ?? []).length === 2, 10000).catch(() => { /* said below */ });
  const terrainHero = customs(c, "w3u").find((o) => o.base === "Hpal");
  const placed = readIn(c, "war3mapUnits.doo.json").units?.filter((u) => u.id !== "sloc") ?? [];
  if (!terrainHero || terrainHero.id === hero) fail(`map C's hero type: ${JSON.stringify(customs(c, "w3u").map((o) => o.id))}`);
  if (customs(c, "w3u").length !== 2) fail(`a second click added another copy of the types: ${customs(c, "w3u").length} units`);
  if (placed.length !== 2 || placed.some((u) => u.id !== terrainHero?.id || (u.skinId !== undefined && u.skinId !== terrainHero?.id))) fail(`the placed heroes in map C: ${JSON.stringify(placed.map((u) => [u.id, u.skinId]))}`);
  await verify(c, "CopyTerrain");
}

/** The Problems view's "Graphics modes" fixes on made-up maps (the mini map plus Reforged-only
 *  doodads), the way a user clicks them: the message names the model Classic is made from, the
 *  conversion writes models whose every texture is in the map, nothing else is reported for them,
 *  and the packed map verifies against the game. Also: error toasts carry a Copy button, and the
 *  found problems of one project don't show in the next. Needs the game (W3PROJ_GAME). */
async function graphicsModes(page, found) {
  const fail = (what) => found.push(`graphics modes: ${what}`);
  if (!game) { fail("needs W3PROJ_GAME"); return; }
  const dir = join(work, "graphics-modes");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const json = (p) => JSON.parse(readFileSync(p, "utf8"));
  const put = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));
  const openProject = async (root) => {
    await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(root)}); })()`);
    await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(root)}`));
  };
  await page.evaluate(`(async () => { const h = w3Workbench.host; await Promise.all(h.extensions.filter((e) => !e.disabled).map((e) => h.activate(e))); })()`);
  // The doodads: a bridge, a wall end cap (two variations) and a tall pillar (nine), all with Reforged models.
  const TYPES = ["LCcb", "YSw5", "LCpt", "LCct"];
  const make = (name, modes) => {
    const root = join(dir, name);
    cpSync(FIXTURE, root, { recursive: true });
    const doo = json(join(root, "map", "war3map.doo.json"));
    TYPES.forEach((id, i) => doo.doodads.push({ ...doo.doodads[0], id, skinId: id, variation: 0, position: [256 + i * 128, 256, 0] }));
    put(join(root, "map", "war3map.doo.json"), doo);
    const w3i = json(join(root, "map", "war3map.w3i.json"));
    w3i.supportedModes = modes;
    put(join(root, "map", "war3map.w3i.json"), w3i);
    return root;
  };
  const verify = (root, label) => {
    const map = join(dir, `${label}.w3x`);
    const packed = spawnSync(cli, ["pack", root, "-o", map], { encoding: "utf8" });
    const r = packed.status === 0 ? spawnSync(cli, ["verify", map, "--game", game], { encoding: "utf8" }) : packed;
    const text = (r.stdout ?? "") + (r.stderr ?? "");
    if (r.status !== 0 || !/1 ok(?! \(1 incomplete)/.test(text)) fail(`${label}: verify: ${text.trim().slice(-400)}`);
    else if (/missing|not found/i.test(text)) fail(`${label}: verify reports missing files: ${text.trim().slice(-400)}`);
  };
  const check = () => page.evaluate(`(async () => {
    const svc = await w3.services.get("w3.problems");
    await svc.run();
    // The mini map's script, and its triggers made of made-up functions, have problems of their own; this is about the objects.
    return svc.problems().filter((p) => !/^war3map\.(j|lua)/.test(p.location ?? "") && p.reveal?.command !== "w3.triggers.reveal").map((p) => ({ severity: p.severity, message: p.message, location: p.location ?? "", fixes: (p.fixes ?? []).map((f) => f.label) }));
  })()`);
  const fix = (match, label) => page.evaluate(`(async () => {
    const svc = await w3.services.get("w3.problems");
    const p = svc.problems().find((q) => q.message.includes(${JSON.stringify(match)}) && (q.fixes ?? []).some((f) => f.label.startsWith(${JSON.stringify(label)})));
    if (!p) return "no problem " + ${JSON.stringify(match)} + " with a fix " + ${JSON.stringify(label)};
    await p.fixes.find((f) => f.label.startsWith(${JSON.stringify(label)})).run();
    return null;
  })().catch((e) => String(e && e.message || e))`);

  // ---- Classic only: convert every type ----------------------------------------------------
  const classic = make("classic", 1);
  await openProject(classic);
  let list = await check();
  const missing = list.filter((p) => /no model in Classic/.test(p.message));
  if (missing.length !== TYPES.length) fail(`Classic only: ${missing.length} of ${TYPES.length} types reported: ${list.map((p) => p.message).join(" | ").slice(0, 300)}`);
  for (const p of missing) {
    if (!/Classic can be made from the (DE|HD) model /.test(p.message)) fail(`the message doesn't say which model it converts from: ${p.message}`);
    if (!p.fixes.some((f) => /^Convert/.test(f))) fail(`no convert fix: ${p.message}`);
    if (p.fixes.some((f) => /^Use a Classic model/.test(f))) fail("the old \"Use a Classic model\" label is still there");
    if (!p.fixes.some((f) => /^Replace with a Classic game model/.test(f))) fail(`no "Replace with a Classic game model" fix: ${p.fixes.join(", ")}`);
  }
  // All at once, as a user clicking the buttons one after the other while the first still works:
  // they have to queue, or the import list and the object data lose entries.
  const errs = await Promise.all(TYPES.map((id) => fix(`(${id})`, "Convert")));
  TYPES.forEach((id, i) => { if (errs[i]) fail(`converting ${id}: ${errs[i]}`); });
  const objectData = async (root) => json(join(root, "map", "war3map.w3d.json"));
  const imports = json(join(classic, "map", "war3map.imp.json")).files.map((f) => f.path.toLowerCase());
  const w3d = await objectData(classic);
  for (const id of TYPES) {
    if (!w3d.original.some((o) => o.base === id && o.mods.some((m) => m.field === "dfil" && /^war3mapImported.Classic/.test(m.value)))) fail(`${id}'s model is not in the object data after converting all at once`);
  }
  // The exact files each conversion lists: its folder, its first variation, and a texture.
  for (const [folder, first] of [["CapitalBridge", "CapitalBridge0"], ["CityWallEndcap", "CityWallEndcap0"], ["PillarTall", "PillarTall0"], ["CapitalTower", "CapitalTower"]]) {
    const want = ["war3mapImported", "Classic", folder, first + ".mdx"].join(String.fromCharCode(92)).toLowerCase();
    if (!imports.includes(want)) fail(`${want} is missing from the import list after converting all at once`);
    const prefix = ["war3mapImported", "Classic", folder, ""].join(String.fromCharCode(92)).toLowerCase();
    if (!imports.some((p) => p.startsWith(prefix) && p.endsWith(".blp"))) fail(`no texture of ${folder} is in the import list`);
  }
  list = await check();
  if (list.length) fail(`after converting, still reported: ${list.map((p) => p.message).join(" | ").slice(0, 600)}`);
  const imported = await page.evaluate(`w3.workspace.files().map((f) => f.path).filter((p) => /\\.mdx$/i.test(p))`);
  if (imported.length < 3) fail(`only ${imported.length} converted models in the map`);
  verify(classic, "classic");

  // ---- HD only: import the Reforged model ------------------------------------------------
  const hd = make("hd", 2);
  await openProject(hd);
  list = await check();
  const gaps = list.filter((p) => /no model in Reforged \(HD\)/.test(p.message));
  for (const p of gaps) {
    const id = /\((\w{4})\)/.exec(p.message)?.[1];
    const err = await fix(`(${id})`, "Import");
    if (err) fail(`importing ${id}: ${err}`);
  }
  list = await check();
  if (list.length) fail(`after importing, still reported: ${list.map((p) => p.message).join(" | ").slice(0, 600)}`);
  verify(hd, "hd");

  // ---- The picker: a model of another graphics mode is converted, for the one type only --------
  /** Opens the picker from the fix of the type `id`, chooses the model whose path has all `words`
   *  in the set `mode`, and answers with what the fix said. */
  const pickFor = async (id, mode, words) => {
    await page.evaluate(`(async () => {
      const svc = await w3.services.get("w3.problems");
      const p = svc.problems().find((q) => q.message.includes("(${id})"));
      window.__picked = p.fixes.find((f) => f.label.startsWith("Replace with a Classic game model")).run().then(() => "done", (e) => String(e && e.message || e));
    })()`);
    await until("the picker", () => page.evaluate(`!!document.querySelector(".model-pick")`));
    const modes = await page.evaluate(`[...document.querySelectorAll(".model-pick select.model-pick-mode option")].map((o) => o.value)`);
    if (modes.join() !== "classic,de,hd") fail(`the picker offers the modes ${modes.join()}`);
    await page.evaluate(`(() => { const s = document.querySelector(".model-pick select.model-pick-mode"); s.value = "${mode}"; s.dispatchEvent(new Event("change")); })()`);
    await page.evaluate(`(() => { const i = document.querySelector(".model-pick input.model-pick-search"); i.value = "${words}"; i.dispatchEvent(new Event("input")); })()`);
    if (!(await page.evaluate(`document.querySelectorAll(".model-pick .model-pick-row").length`))) fail(`the ${mode} list of the picker has nothing for ${words}`);
    await page.evaluate(`[...document.querySelectorAll(".model-pick button")].find((b) => /Use this model/.test(b.textContent)).click()`);
    return page.evaluate(`window.__picked`);
  };
  const pick = make("pick", 1);
  // A user's own import in the folder the first conversion would take, which must stay as it is.
  const mine = join(pick, "map", "war3mapImported", "Classic", "GrassBridgeExtraLarge45");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "GrassBridgeExtraLarge45.mdx"), "my own model");
  await openProject(pick);
  await check();
  const w3dBefore = existsSync(join(pick, "map", "war3map.w3d.json")) ? readFileSync(join(pick, "map", "war3map.w3d.json"), "utf8") : null;
  let picked = await pickFor("LCct", "de", "citybridgeextralarge45 grassbridge");
  if (picked !== "done") fail(`choosing a DE model failed: ${picked}`);
  let after1 = await objectData(pick);
  if (after1.original.some((o) => o.base !== "LCct")) fail(`the picker opened from LCct changed other types: ${after1.original.map((o) => o.base).join()} (before: ${w3dBefore ? "a file" : "none"})`);
  if (!after1.original.some((o) => o.base === "LCct")) fail("the picker opened from LCct did not change LCct");
  list = await check();
  if (list.some((p) => p.message.includes("(LCct)"))) fail("after choosing a DE model, the type is still reported");
  if (!list.some((p) => p.message.includes("(LCcb)"))) fail("a type the picker was not opened for lost its problem");
  if (readFileSync(join(mine, "GrassBridgeExtraLarge45.mdx"), "utf8") !== "my own model") fail("a conversion overwrote the user's own import");
  // The same file name from another folder gets another folder.
  picked = await pickFor("LCcb", "de", "overgrownbridgeextralarge45 grassbridge");
  if (picked !== "done") fail(`choosing the second DE model failed: ${picked}`);
  after1 = await objectData(pick);
  const dfil = (base) => after1.original.find((o) => o.base === base)?.mods.find((m) => m.field === "dfil")?.value;
  if (!dfil("LCct") || !dfil("LCcb") || dfil("LCct") === dfil("LCcb")) fail(`two models with one file name share a folder: ${dfil("LCct")} / ${dfil("LCcb")}`);
  const classicFiles = await page.evaluate(`w3.workspace.files().map((f) => f.path.toLowerCase()).filter((p) => p.includes("classic/grassbridgeextralarge45"))`);
  if (classicFiles.length < 3) fail(`the conversions left ${classicFiles.length} files in their folders`);

  // ---- A fix does not write into another project opened since the check ------------------------
  const away = make("away", 1);
  await openProject(away);
  await check();
  await page.evaluate(`(async () => {
    const svc = await w3.services.get("w3.problems");
    window.__old = svc.problems().find((q) => q.message.includes("(LCcb)")).fixes.find((f) => f.label.startsWith("Convert"));
  })()`);
  await openProject(hd);
  const refused = await page.evaluate(`window.__old.run().then(() => null, (e) => String(e && e.message || e))`);
  if (!refused || !/Another project/.test(refused)) fail(`a fix from another project ran in this one (${refused})`);
  if (await page.evaluate(`w3.workspace.files().some((f) => f.path.toLowerCase().includes("classic/capitalbridge"))`)) fail("a fix from another project wrote into this one");

  // ---- An editor that can't open a file offers to copy the message --------------------------
  writeFileSync(join(hd, "map", "war3mapImported", "broken.mdx"), "not a model");
  await openProject(hd);
  await page.evaluate(`w3.editors.open("map/war3mapImported/broken.mdx", "w3.modelViewer").catch(() => {})`);
  const errView = await until("the editor's error", () => page.evaluate(`!!document.querySelector(".editor-error button.copy-error")`)).catch(() => false);
  if (!errView) fail("an editor's error view has no Copy button");
  await page.evaluate(`w3.editors.closeAll()`);

  // ---- Another project drops the first one's problems ---------------------------------------
  await openProject(make("stale", 1));
  await check();
  const before = await page.evaluate(`w3.services.get("w3.problems").then((s) => s.problems().length)`);
  await openProject(hd);
  await sleep(300);
  const after = await page.evaluate(`w3.services.get("w3.problems").then((s) => s.problems().length)`);
  if (before === 0) fail("the project to leave had no problems, so staleness isn't tested");
  if (after !== 0) fail(`the previous project's ${after} problems show in the next (${before} before)`);

  // ---- Error toasts can be copied ---------------------------------------------------------
  await page.evaluate(`void w3.window.showError("Smoke error to copy")`);
  const copy = await until("the toast", () => page.evaluate(`!!document.querySelector(".toast.error button.copy-error")`)).catch(() => false);
  if (!copy) fail("an error toast has no Copy button");
}

/** Game files are read once a session: opening a map's terrain again, with its doodads, units,
 *  cliffs and water, asks the backend for no game file at all. Counts, not times, so it isn't flaky. */
/** What the first opening of gameReadsOnce's scene (the mini map with a tree, a goldmine and a footman) took
 *  when last recorded: backend reads, reads asked of the game service, textures made by the terrain view. One more
 *  each since HD emissive textures are drawn: the gold mine's Neutral_GoldMine_Emissive (branch render-fixes-4). Three
 *  more read and asked and two more textures since the view draws shadows (branch view-shadows): the shadow images
 *  and textures of ReplaceableTextures\Shadows (the tree's and the footman's) and the ground's shadow map. Two more
 *  textures since HD casts real shadows (branch hd-shadows): the sun's shadow map and the depth texture shaders read
 *  without one. */
const GAME_READS_RECORDED = { reads: 105, asked: 128, textures: 140 };

async function gameReadsOnce(page, found) {
  const fail = (what) => found.push(`game reads: ${what}`);
  if (!game) { fail("needs W3PROJ_GAME"); return; }
  const root = join(work, "game-reads");
  rmSync(root, { recursive: true, force: true });
  cpSync(FIXTURE, root, { recursive: true });
  // A tree, a goldmine (a ground mark) and a footman: models, textures and splats from the game.
  const doo = JSON.parse(readFileSync(join(root, "map", "war3map.doo.json"), "utf8"));
  doo.doodads.push({ ...doo.doodads[0], id: "LTlt", skinId: "LTlt", variation: 0, position: [256, 256, 0], editorId: 900 });
  writeFileSync(join(root, "map", "war3map.doo.json"), JSON.stringify(doo, null, 2));
  const units = JSON.parse(readFileSync(join(root, "map", "war3mapUnits.doo.json"), "utf8"));
  const unit = units.units.find((u) => u.id !== "sloc") ?? units.units[0];
  if (unit) {
    units.units.push({ ...unit, id: "ngol", skinId: "ngol", player: 24, position: [-512, -512, 0], gold: 12500, editorId: 901 }, { ...unit, id: "hfoo", skinId: "hfoo", player: 0, position: [512, -512, 0], editorId: 902 });
    writeFileSync(join(root, "map", "war3mapUnits.doo.json"), JSON.stringify(units, null, 2));
  }
  const tool = mcpTool(page);
  // The webview keeps the project's tabs from an earlier run (the same folder): a terrain that comes
  // back on its own would load before the first opening is counted.
  await page.evaluate(`(async () => {
    await w3.editors.closeAll();
    for (const k of Object.keys(localStorage)) if (k.startsWith("w3.openEditors:")) localStorage.removeItem(k);
    await w3.workspace.open(${JSON.stringify(root)});
  })()`);
  await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(root)}`));
  const reads = () => page.evaluate(`w3Workbench.game.backendReads`);
  const misses = () => page.evaluate(`w3Workbench.game.backendMisses.length`);
  // Textures made for the terrain view (each one decoded from a game file or made by the view).
  await page.evaluate(`(() => {
    if (window.__texturesMade !== undefined) return;
    window.__texturesMade = 0;
    const P = WebGL2RenderingContext.prototype, make = P.createTexture;
    P.createTexture = function () { if (this.canvas.closest?.(".model-stage")) window.__texturesMade++; return make.call(this); };
  })()`);
  const asked = () => page.evaluate(`w3Workbench.game.requests`);
  // Reads others started (a table read after another, queued behind the terrain's; the Object
  // Manager's tables on a project opened) land first: what is counted is the terrain's.
  const settled = () => until("the game reads to settle", async () => {
    const a = await page.evaluate(`[w3Workbench.game.readsPending, w3Workbench.game.backendReads]`);
    await sleep(500);
    const b = await page.evaluate(`[w3Workbench.game.readsPending, w3Workbench.game.backendReads]`);
    return a[0] === 0 && b[0] === 0 && a[1] === b[1];
  }, 30000);
  await settled();
  // The picture waits until every model and texture is in.
  const before = await reads(), missedBefore = await misses(), askedBefore = await asked();
  const texturesBefore = await page.evaluate(`window.__texturesMade`);
  await tool("terrain_screenshot", { maxSize: 64 });
  const first = (await reads()) - before;
  const askedFirst = (await asked()) - askedBefore;
  const texturesFirst = (await page.evaluate(`window.__texturesMade`)) - texturesBefore;
  // A fixed scene: a count past what it took when recorded is a regression (a file read that wasn't, a
  // texture decoded twice, a table asked once per model) that no timing in the gate would show reliably.
  // When a change reads less, lower the number; a game patch that changes the files can move them too.
  // (The backend reads are fewer when checks before this one read some of the same files.)
  const RECORDED = GAME_READS_RECORDED;
  console.log(`  game reads: the first opening of the scene read ${first} game files, asked for ${askedFirst}, made ${texturesFirst} textures (recorded: ${RECORDED.reads}, ${RECORDED.asked}, ${RECORDED.textures})`);
  if (first > RECORDED.reads) fail(`the first opening read ${first} game files, ${RECORDED.reads} when recorded`);
  if (askedFirst > RECORDED.asked) fail(`the first opening asked for ${askedFirst} game files, ${RECORDED.asked} when recorded`);
  if (texturesFirst > RECORDED.textures) fail(`the first opening made ${texturesFirst} textures, ${RECORDED.textures} when recorded`);
  // HD models name .tif textures; the game stores them as .dds only, and that is asked for first.
  const tifMissed = await page.evaluate(`w3Workbench.game.backendMisses.slice(${missedBefore}).filter((p) => /\\.tif$/i.test(p))`);
  if (tifMissed.length) fail(`${tifMissed.length} reads asked the game for a .tif it doesn't have (${tifMissed.slice(0, 3).join(", ")})`);
  const storedTif = await page.evaluate(`w3.game.list().then((l) => l.filter((p) => /\\.tif$/i.test(p)).slice(0, 3))`);
  if (storedTif.length) fail(`the game stores .tif files now (${storedTif.join(", ")}): texpath.ts's neverStoredLast no longer holds`);
  const reopen = async () => {
    await page.evaluate(`w3.editors.closeAll()`);
    await settled();
    const at = await reads(), askedAt = await asked();
    await tool("terrain_screenshot", { maxSize: 64 });
    return [(await reads()) - at, (await asked()) - askedAt];
  };
  // Something besides the terrain can read a table of its own for the first time meanwhile
  // (the ability data, once): the third opening has nothing left to read.
  const [second, askedSecond] = await reopen(), [third, askedThird] = await reopen();
  // The control: the first opening did read the game's files.
  if (first < 10) fail(`the first opening read ${first} game files: the map's models didn't come from the game`);
  if (second > 2 || third !== 0) fail(`opening the terrain again read ${second}, then ${third} game files (the first opening read ${first})`);
  // Each opening loads the map's models and textures once: from the cache, but asked for alike.
  if (askedSecond < 10 || Math.abs(askedThird - askedSecond) > askedSecond / 10) fail(`two openings of the terrain asked for ${askedSecond}, then ${askedThird} game files`);

  // The project's tabs coming back while the terrain is being opened (a cold start: the editor's
  // extension still starting) made a second terrain editor, which loaded everything again: some
  // cold GoldRush opens asked for 2,060 files instead of 1,078. The extension's start is held back
  // here so that the tabs come back in the middle of it.
  const terrain = await page.evaluate(`w3.editors.activePath()`);
  const askedRaced = await asked();
  const raced = await page.evaluate(`(async () => {
    const ed = w3Workbench.editors, path = ${JSON.stringify(terrain)};
    await w3.editors.closeAll();
    const memory = ed.memory, activate = ed.activate;
    ed.memory = { load: () => ({ tabs: [{ path, editor: "w3.terrainViewer" }], active: path }), store: (s) => memory?.store(s) };
    ed.activate = async (e) => { await new Promise((r) => setTimeout(r, 400)); return activate.call(ed, e); };
    try {
      const opening = ed.open(path, "w3.terrainViewer");
      await new Promise((r) => setTimeout(r, 100));
      await ed.restore();
      await opening;
    } finally { ed.memory = memory; ed.activate = activate; }
    return ed.tabs.filter((t) => t.path === path).length;
  })()`);
  if (raced !== 1) fail(`opening the terrain while the project's tabs came back made ${raced} terrain tabs`);
  // (With two, the tool can pick the hidden one: "isn't visible".)
  const shot = await tool("terrain_screenshot", { maxSize: 64 }).then(() => null, (e) => e.message);
  if (shot) fail(`after opening the terrain while the project's tabs came back: ${shot}`);
  await sleep(1000);
  const racedAsked = (await asked()) - askedRaced;
  if (racedAsked > askedSecond * 1.5) fail(`opening the terrain while the project's tabs came back asked for ${racedAsked} game files, a plain opening ${askedSecond}`);
  await page.evaluate(`w3.editors.closeAll()`);
}

/** Map Properties ▸ Players: Start X and Y can be typed for a player without a start location, and only
 *  shown for one with it, which the terrain editor's save writes there (players follow start locations). */
/** A real map saved after a terrain edit: the save rewrites war3map.j and war3map.w3i from the map's files, and they may
 *  differ from the map's own only where the World Editor's own save differs. smoketest_maps/cliff.w3m saved by World
 *  Editor 7003 (we-drive: open, Ctrl+S, 2026-11-09) changed one line of war3map.j, the start location written from the
 *  start-location object (-1280, 1472) instead of the w3i's (-1306.0195, 1475.8408), and the w3i's start the same way.
 *  It kept SetDayNightModels with the map's own two lighting models (war3map.w3l) and MAP_PLACEMENT_USE_MAP_SETTINGS
 *  (a one-player melee map). Skipped without the map (W3PROJ_CORPUS, else smoketest_maps of the main checkout). */
/** The second round: a two-player copy of cliff.w3m (player 2 and its start location at 1280, -1472 added to the
 *  w3i and the units, masks 0), saved by World Editor 7003 (we-drive, 2026-11-09). Its save worked out the ally
 *  priorities (each player the other's High: allyHigh 2 and 1, InitAllyPriorities in the script), wrote hit points and
 *  mana -1 for both start locations, and changed war3map.j by these lines only (the rest of the file as the map's own). */
const TWO_PLAYERS_ADDED = [
  "    // Player 1", "    call SetPlayerStartLocation( Player(1), 1 )", "    call SetPlayerColor( Player(1), ConvertPlayerColor(1) )",
  "    call SetPlayerRacePreference( Player(1), RACE_PREF_HUMAN )", "    call SetPlayerRaceSkin( Player(1), RACE_PREF_RANDOM )",
  "    call SetPlayerRaceSelectable( Player(1), true )", "    call SetPlayerController( Player(1), MAP_CONTROL_USER )",
  "    call SetPlayerTeam( Player(1), 0 )",
  "function InitAllyPriorities takes nothing returns nothing", "    call SetStartLocPrioCount( 0, 1 )",
  "    call SetStartLocPrio( 0, 0, 1, MAP_LOC_PRIO_HIGH )", "    call SetStartLocPrioCount( 1, 1 )",
  "    call SetStartLocPrio( 1, 0, 0, MAP_LOC_PRIO_HIGH )",
  "    call SetPlayers( 2 )", "    call SetTeams( 2 )", "    call SetGamePlacement( MAP_PLACEMENT_TEAMS_TOGETHER )", "",
  "    call DefineStartLocation( 0, -1280.0, 1472.0 )", "    call DefineStartLocation( 1, 1280.0, -1472.0 )", "",
  "    call SetPlayerSlotAvailable( Player(1), MAP_CONTROL_USER )", "    call InitAllyPriorities(  )", "endfunction", "", "",
];
const TWO_PLAYERS_REMOVED = [
  "    call SetPlayers( 1 )", "    call SetTeams( 1 )", "    call SetGamePlacement( MAP_PLACEMENT_USE_MAP_SETTINGS )",
  "    call DefineStartLocation( 0, -1306.0, 1475.8 )",
];

/** Lines of `a` that `b` doesn't have, counted (a multiset difference). */
function linesNotIn(a, b) {
  const left = new Map();
  for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
  return a.filter((l) => { const n = left.get(l) ?? 0; if (n) { left.set(l, n - 1); return false; } return true; });
}

async function realMapSave(page, found) {
  const map = join(process.env.W3PROJ_CORPUS ?? join(mainCheckout(repo), "smoketest_maps"), "cliff.w3m");
  if (!existsSync(map)) { console.log(`real map save: skipped, ${map} isn't there`); return; }
  await realMapSaveRound(page, found, map, "cliff", null);
  await realMapSaveRound(page, found, map, "cliff-two", (dir) => {
    // Player 2 and its start location, as the World Editor's reference save had them.
    const at = [1280, -1472];
    const infoFile = join(dir, "map", "war3map.w3i.json"), unitsFile = join(dir, "map", "war3mapUnits.doo.json");
    const i = JSON.parse(readFileSync(infoFile, "utf8")), u = JSON.parse(readFileSync(unitsFile, "utf8"));
    i.players.push({ ...i.players[0], id: 1, start: at, allyLow: 0, allyHigh: 0, enemyLow: 0, enemyHigh: 0 });
    u.units.push({ ...u.units[0], player: 1, position: [...at, 0], editorId: 1 });
    writeFileSync(infoFile, JSON.stringify(i, null, 2));
    writeFileSync(unitsFile, JSON.stringify(u, null, 2));
  });
}

/** One round of realMapSave: `prepare` changes the unpacked project before it's opened (null: the map as it is). */
async function realMapSaveRound(page, found, map, name, prepare) {
  const two = prepare !== null;
  const fail = (what) => found.push(`real map save${two ? " (two players)" : ""}: ${what}`);
  const dir = join(work, "real-map", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.backend.invoke("project_unpack", { map: ${JSON.stringify(map)}, dir: ${JSON.stringify(dir)}, allowIncomplete: false, install: ${JSON.stringify(game ?? gamePath(repo))} }); })()`);
  const file = (f) => join(dir, "map", f);
  prepare?.(dir);
  const script = readFileSync(file("war3map.j"), "utf8"), info = JSON.parse(readFileSync(file("war3map.w3i.json"), "utf8"));
  const terrain = readFileSync(file("war3map.w3e.txt"), "utf8");
  // The control: the start locations as the World Editor's save found them, at 0 hit points and mana, the masks empty.
  const startsBefore = JSON.parse(readFileSync(file("war3mapUnits.doo.json"), "utf8")).units.filter((u) => u.id === "sloc");
  if (startsBefore.length !== (two ? 2 : 1) || startsBefore.some((u) => u.hp !== 0 || u.mana !== 0)) return fail(`the map's start locations aren't as the World Editor's save found them (control): ${JSON.stringify(startsBefore.map((u) => [u.player, u.hp, u.mana]))}`);
  if (info.players.some((p) => p.allyLow || p.allyHigh)) return fail("the map has ally priorities before the save (control)");
  const TXT = "map/war3map.w3e.txt";
  await page.evaluate(`w3.workspace.open(${JSON.stringify(dir)})`);
  await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(dir)}`));
  try {
    await page.evaluate(`w3.editors.open(${JSON.stringify(TXT)})`);
    await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === ${JSON.stringify(TXT)}`), 60000);
    // The game's files read and the view's layers done (as app-drive's --settle): the placed objects are there, and the
    // command moves the start location with the ground.
    let quietSince = 0;
    await until("the terrain editor's files", async () => {
      const busy = await page.evaluate(`w3Workbench.game.readsPending > 0 || [...document.querySelectorAll("span.muted")].some((e) => !e.hidden && e.textContent === "Working…")`);
      if (busy) { quietSince = 0; return false; }
      quietSince ||= Date.now();
      return Date.now() - quietSince > 1000;
    }, 120000);
    const units = readFileSync(file("war3mapUnits.doo.json"), "utf8");
    const err = await page.evaluate(`w3.commands.execute("w3.terrain.adjustCliffLevels", 1).then(() => null, (e) => String(e))`);
    if (err) return fail(`Adjust Cliff Levels: ${err}`);
    await page.evaluate(`w3.editors.saveAll()`);
    if (readFileSync(file("war3map.w3e.txt"), "utf8") === terrain) return fail("the terrain edit wasn't saved (control)");
    if (readFileSync(file("war3mapUnits.doo.json"), "utf8") === units) return fail("the start location didn't go up with the ground (control)");
    // The save then writes the w3i's start from the start-location object, and that save the script.
    const scriptLog = () => page.evaluate(`(w3Workbench.output.channels.get("Map Script") ?? []).join("\\n")`);
    await until("the map script after the save", async () => /war3map\.j (written|up to date|not written)/.test(await scriptLog()), 30000).catch(() => {});
    await page.evaluate(`w3.commands.execute("w3.script.settle")`);
    const log = () => page.evaluate(`(w3Workbench.output.channels.get("Map Script") ?? []).slice(-3).join(" | ")`);
    const before = script.split("\r\n"), after = readFileSync(file("war3map.j"), "utf8").split("\r\n");
    if (!two) {
      // war3map.j: the same lines but the start location, which must be the World Editor's.
      const want = "    call DefineStartLocation( 0, -1280.0, 1472.0 )";
      const differs = [];
      for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) differs.push(`${i + 1}: ${JSON.stringify(before[i])} → ${JSON.stringify(after[i])}`);
      if (!after.includes(want)) fail(`war3map.j wasn't written with the start location as the World Editor writes it (${want.trim()}): ${differs.slice(0, 4).join(" | ") || "unchanged"}; Map Script: ${await log()}`);
      const unexpected = differs.filter((d) => !d.endsWith(JSON.stringify(want)));
      if (unexpected.length) fail(`war3map.j differs from the map's own where the World Editor's save doesn't: ${unexpected.slice(0, 4).join(" | ")}`);
    } else {
      // war3map.j: the lines the World Editor's save added and took away, and no others.
      const added = linesNotIn(after, before), removed = linesNotIn(before, after);
      const missing = linesNotIn(TWO_PLAYERS_ADDED, added), extra = linesNotIn(added, TWO_PLAYERS_ADDED);
      const kept = linesNotIn(TWO_PLAYERS_REMOVED, removed), lost = linesNotIn(removed, TWO_PLAYERS_REMOVED);
      if (missing.length || kept.length) fail(`war3map.j lacks what the World Editor's save writes: ${JSON.stringify([...missing, ...kept.map((l) => `(still) ${l}`)].slice(0, 6))}; Map Script: ${await log()}`);
      if (extra.length || lost.length) fail(`war3map.j differs from the map's own where the World Editor's save doesn't: ${JSON.stringify([...extra, ...lost.map((l) => `(gone) ${l}`)].slice(0, 6))}`);
    }
    // war3map.w3i: only the start, from the start-location object, and with two players the ally priorities.
    const nowInfo = JSON.parse(readFileSync(file("war3map.w3i.json"), "utf8"));
    if (JSON.stringify(nowInfo.players[0].start) !== JSON.stringify([-1280, 1472])) fail(`the w3i's start location is ${JSON.stringify(nowInfo.players[0].start)}, the World Editor writes [-1280, 1472]`);
    const masks = nowInfo.players.map((p) => [p.allyLow, p.allyHigh, p.enemyLow, p.enemyHigh]);
    const wantMasks = two ? [[0, 2, 0, 0], [0, 1, 0, 0]] : [[0, 0, 0, 0]];
    if (JSON.stringify(masks) !== JSON.stringify(wantMasks)) fail(`the w3i's ally priorities are ${JSON.stringify(masks)}, the World Editor's save has ${JSON.stringify(wantMasks)}`);
    nowInfo.players[0].start = info.players[0].start;
    nowInfo.players.forEach((p, k) => { p.allyHigh = info.players[k]?.allyHigh; });
    if (JSON.stringify(nowInfo) !== JSON.stringify(info)) fail("war3map.w3i changed beyond the start location and the ally priorities");
    // war3mapUnits.doo: the start locations' hit points and mana -1, as the World Editor saves 0.
    const startsAfter = JSON.parse(readFileSync(file("war3mapUnits.doo.json"), "utf8")).units.filter((u) => u.id === "sloc");
    if (startsAfter.some((u) => u.hp !== -1 || u.mana !== -1)) fail(`the start locations' hit points and mana are ${JSON.stringify(startsAfter.map((u) => [u.hp, u.mana]))}, the World Editor saves -1`);
  } finally {
    await page.evaluate(`w3.editors.closeAll()`).catch(() => {});
  }
}

async function playerStarts(page, found, root) {
  const fail = (what) => found.push(`player starts: ${what}`);
  await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(root)}); })()`);
  await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(root)}`));
  const units = "map/war3mapUnits.doo.json";
  const before = await page.evaluate(`w3.workspace.readText(${JSON.stringify(units)})`);
  /** Player 1's Start X and Y cells: their text, and whether they hold an input. */
  const cells = () => page.evaluate(`(() => {
    const row = [...document.querySelectorAll(".map-info .form-table tbody tr")].find((r) => r.cells[0]?.textContent === "1");
    return row ? [5, 6].map((i) => ({ input: !!row.cells[i].querySelector("input"), text: row.cells[i].querySelector("input")?.value ?? row.cells[i].textContent })) : null;
  })()`);
  const players = `[...document.querySelectorAll(".map-info .form-nav-item")].find((b) => b.textContent === "Players")?.click()`;
  try {
    await page.evaluate(`w3.editors.open("map/war3map.w3i.json")`);
    await until("Map Properties", () => page.evaluate(`!!document.querySelector(".map-info .form-nav")`), 20000);
    await page.evaluate(players);
    await until("the players", async () => (await cells()) !== null, 5000);
    const free = await cells();
    if (!free.every((c) => c.input)) fail(`without a start location, Start X/Y can't be typed (control): ${JSON.stringify(free)}`);
    // Player 1's start location, as the terrain editor places it.
    const doc = JSON.parse(before);
    doc.units.push({ ...doc.units[0], id: "sloc", player: 0, position: [128, -256, 0], angle: 4.712389 });
    await page.evaluate(`(async () => w3.workspace.writeText(${JSON.stringify(units)}, ${JSON.stringify(JSON.stringify(doc))}))()`);
    await until("the start location to be read", async () => {
      await page.evaluate(players);
      const now = await cells();
      return now !== null && now[0].text === "128";
    }, 10000).catch(() => {});
    const followed = await cells();
    if (followed?.some((c) => c.input) || followed?.[0].text !== "128" || followed?.[1].text !== "-256") fail(`with a start location, Start X/Y are still typed, or don't show it: ${JSON.stringify(followed)}`);
  } finally {
    await page.evaluate(`(async () => { await w3.workspace.writeText(${JSON.stringify(units)}, ${JSON.stringify(before)}); await w3.editors.closeAll(); })()`);
  }
}

/** Tabs that change while an editor is opened or closed (the user, a restore, a tool): the editor
 *  service keeps one tab per file, closes the right one, and an editor whose tab went while it
 *  loaded is disposed. Through the real EditorService, its waits held open from outside. */
async function editorTabRaces(page, found, root) {
  const fail = (what) => found.push(`editor tabs: ${what}`);
  await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(root)}); })()`);
  await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(root)}`));
  const r = await page.evaluate(`(async () => {
    const ed = w3Workbench.editors, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const files = w3.workspace.files().map((f) => f.path).filter((p) => p.startsWith("map/"));
    // A file two editors can show.
    const path = files.find((p) => ed.candidates(p).length >= 2);
    if (!path) return { error: "no file with two editors" };
    const [one, other] = ed.candidates(path).map((c) => c.id);
    const tabsOf = (p) => ed.tabs.filter((t) => t.path === p);
    const out = {};
    const memory = ed.memory, activate = ed.activate, confirm = ed.confirm;
    try {
      // 1. Opened with one editor while the restore brings the file back in the other, with
      //    unsaved changes, and closing that is cancelled: no second tab.
      await w3.editors.closeAll();
      ed.memory = { load: () => ({ tabs: [{ path, editor: other }], active: path }), store: (s) => memory?.store(s) };
      ed.activate = async (e) => { await wait(400); return activate.call(ed, e); };
      ed.confirm = async () => undefined;
      const opening = ed.open(path, one);
      await wait(100);
      await ed.restore();
      tabsOf(path)[0].dirty = true;
      await opening.catch(() => {});
      out.cancelled = tabsOf(path).map((t) => t.providerId);
      ed.activate = activate;
      ed.confirm = confirm;
      for (const t of tabsOf(path)) t.dirty = false;
      await w3.editors.closeAll();

      // 2. A close asking about unsaved changes, while the tab is closed by something else: the
      //    other tabs stay.
      const second = files.find((p) => p !== path && ed.candidates(p).length);
      await ed.open(path, one);
      await ed.open(second);
      const tab = tabsOf(path)[0];
      tab.dirty = true;
      let answer;
      ed.confirm = () => new Promise((r) => { answer = r; });
      const asking = ed.close(tab);
      await wait(50);
      await ed.close(tab, true);
      answer("Don't Save");
      await asking;
      ed.confirm = confirm;
      out.afterDoubleClose = ed.tabs.map((t) => t.path);
      out.second = second;
      await w3.editors.closeAll();

      // 3. An editor whose tab is closed while it loads is disposed when it arrives.
      const provider = ed.providers.get(one);
      let disposed = 0;
      ed.providers.set(one, { ...provider, resolve: async (el, doc) => {
        await wait(400);
        const inst = await provider.resolve(el, doc);
        const d = inst.dispose;
        inst.dispose = () => { disposed++; d?.call(inst); };
        return inst;
      } });
      try {
        const loading = ed.open(path, one);
        await wait(100);
        await ed.close(tabsOf(path)[0], true);
        await loading;
      } finally { ed.providers.set(one, provider); }
      out.disposed = disposed;
    } finally { ed.memory = memory; ed.activate = activate; ed.confirm = confirm; }
    await w3.editors.closeAll();
    return { path, one, other, ...out };
  })()`);
  if (r.error) return fail(r.error);
  if (r.cancelled.length !== 1) fail(`${r.path} opened in ${r.one} while it came back in ${r.other} (closing it cancelled): ${r.cancelled.length} tabs (${r.cancelled.join(", ")})`);
  if (!r.afterDoubleClose.includes(r.second)) fail(`closing ${r.path} twice at once closed ${r.second} too (left: ${r.afterDoubleClose.join(", ") || "nothing"})`);
  if (r.disposed !== 1) fail(`an editor whose tab closed while it loaded was disposed ${r.disposed} times`);
}

/** Drawing many objects costs no more draw calls than drawing a few: the copies of a model are drawn
 *  together, one call per layer (and player colour where it shows), and what's out of view isn't drawn.
 *  Counted on the terrain canvas's WebGL calls of one frame, not timed, so it isn't flaky. Needs the game. */
async function drawCalls(page, found) {
  const fail = (what) => found.push(`draw calls: ${what}`);
  if (!game) { fail("needs W3PROJ_GAME"); return; }
  const base = {
    doo: JSON.parse(readFileSync(join(FIXTURE, "map", "war3map.doo.json"), "utf8")),
    units: JSON.parse(readFileSync(join(FIXTURE, "map", "war3mapUnits.doo.json"), "utf8")),
  };
  const footman = base.units.units.find((u) => u.id === "hfoo");
  /** A copy of the fixture with `n` trees and `n` footmen (players 0 to 5 in turn) more, on and around the small map. */
  const write = (root, n) => {
    rmSync(root, { recursive: true, force: true });
    cpSync(FIXTURE, root, { recursive: true });
    const doo = structuredClone(base.doo), units = structuredClone(base.units);
    for (let i = 0; i < n; i++) {
      const x = -128 + (i % 8) * 64, y = -64 + Math.floor(i / 8) * 48;
      doo.doodads.push({ ...doo.doodads[0], id: "LTlt", skinId: "LTlt", variation: i % 3, position: [x, y, 0], editorId: 1000 + i });
      units.units.push({ ...footman, position: [x + 32, y + 24, 0], player: i % 6, editorId: 2000 + i });
    }
    writeFileSync(join(root, "map", "war3map.doo.json"), JSON.stringify(doo, null, 2));
    writeFileSync(join(root, "map", "war3mapUnits.doo.json"), JSON.stringify(units, null, 2));
  };
  const tool = mcpTool(page);
  /** Opens a copy with `n` more of each in the terrain, and waits until every model and texture is in. */
  const open = async (n) => {
    const root = join(work, `draw-calls-${n}`);
    write(root, n);
    await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(root)}); })()`);
    await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(root)}`));
    await tool("terrain_screenshot", { maxSize: 64 });
  };
  // Counts the calls of each frame drawn on the terrain canvas; a frame starts with its clear.
  await page.evaluate(`(() => {
    if (window.__drawCount) return;
    const P = WebGL2RenderingContext.prototype, c = window.__drawCount = { frames: 0, current: null, last: null };
    const ours = (gl) => !!gl.canvas.closest?.(".model-stage");
    const wrap = (name, count) => { const f = P[name]; P[name] = function (...a) { if (ours(this) && c.current) count(c.current, a); return f.apply(this, a); }; };
    const clear = P.clear;
    P.clear = function (m) { if (ours(this)) { c.last = c.current; c.current = { elements: 0, instanced: 0, instances: 0, worldUploads: 0 }; c.frames++; } return clear.call(this, m); };
    wrap("drawElements", (f) => { f.elements++; });
    wrap("drawElementsInstanced", (f, a) => { f.elements++; f.instanced++; f.instances += a[4]; });
    wrap("uniformMatrix4fv", (f) => { f.worldUploads++; });
  })()`);
  /** The counts of one whole frame, drawn with the camera looking at (x, y). */
  const frame = async (x, y) => {
    const path = await page.evaluate(`w3.editors.activePath()`);
    const look = () => page.evaluate(`(async () => (await w3.services.get("w3.terrain")).look.get(${JSON.stringify(path)})(${x}, ${y}))()`);
    // Counted once the camera has moved: a frame begun before that (an animation's) would be the old view.
    await look();
    const before = await page.evaluate(`window.__drawCount.frames`);
    // Each look asks for a frame. Both begin after the move; once the second has begun, the first is complete.
    for (const n of [1, 2]) {
      await look();
      await until("a frame", () => page.evaluate(`window.__drawCount.frames >= ${before + n}`), 20000);
    }
    return page.evaluate(`window.__drawCount.last`);
  };
  const few = 6, many = 30;
  await open(few);
  const a = await frame(128, 64);
  await open(many);
  const b = await frame(128, 64);
  // Far off the map, where nothing stands.
  const away = await frame(40000, 40000);
  await page.evaluate(`w3.editors.closeAll()`);
  if (process.argv.includes("--verbose")) console.log(`  draw calls: ${JSON.stringify({ few: a, many: b, away })}`);
  const placed = 2 * (many - few);
  // The control: the added trees and footmen were drawn, so the count below is about drawing them.
  if (b.instances - a.instances < placed) return fail(`${placed} objects more drew ${b.instances - a.instances} more instances (${a.instances}, then ${b.instances}): they weren't drawn as instances`);
  if (b.elements !== a.elements) fail(`${placed} objects more took ${b.elements - a.elements} more draw calls (${a.elements}, then ${b.elements})`);
  if (b.worldUploads !== a.worldUploads) fail(`${placed} objects more uploaded ${b.worldUploads - a.worldUploads} more matrices (${a.worldUploads}, then ${b.worldUploads})`);
  if (away.instances >= b.instances / 4) fail(`looking away from the objects still drew ${away.instances} of ${b.instances} instances`);
}

/** A lost WebGL context (a GPU reset, a driver hiccup), made with WEBGL_lose_context. The terrain viewer stops drawing,
 *  says so, keeps the unsaved edit, saves it, and opens again only once nothing is unsaved; the model viewer draws
 *  again once the context is given back. */
async function contextLoss(page, found) {
  const fail = (what) => found.push(`context loss: ${what}`);
  const root = join(work, "context-loss");
  rmSync(root, { recursive: true, force: true });
  cpSync(FIXTURE, root, { recursive: true });
  const ground = "map/war3map.w3e.txt";
  await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(root)}); })()`);
  await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(root)}`));
  // Frames per canvas: a frame starts with its clear. The canvas shown is the one of the active tab.
  await page.evaluate(`(() => {
    if (window.__glFrames) return;
    const P = WebGL2RenderingContext.prototype, clear = P.clear;
    window.__glFrames = new WeakMap();
    P.clear = function (m) { window.__glFrames.set(this.canvas, (window.__glFrames.get(this.canvas) ?? 0) + 1); return clear.call(this, m); };
  })()`);
  const canvasNow = `[...document.querySelectorAll(".model-stage canvas")].find((c) => c.offsetParent !== null)`;
  const frames = () => page.evaluate(`(() => { const c = ${canvasNow}; return c ? window.__glFrames.get(c) ?? 0 : -1; })()`);
  const lostShown = () => page.evaluate(`(() => { const c = ${canvasNow}; const m = c?.parentElement.querySelector(".gl-lost"); return !!m && !m.hidden; })()`);
  /** Loses or restores the shown canvas's context; the canvas is kept as __lostCanvas. */
  const glCall = async (what) => {
    const r = await page.evaluate(`(() => {
      const c = ${canvasNow};
      if (!c) return "no canvas";
      window.__lostCanvas = c;
      const gl = c.getContext("webgl2");
      if (!gl) return "no WebGL2 context on the canvas";
      const ext = window.__loseExt = gl.getExtension("WEBGL_lose_context") ?? window.__loseExt;
      if (!ext) return "no WEBGL_lose_context";
      ext.${what}();
      return null;
    })()`);
    if (r) throw new Error(`${what}: ${r}`);
  };
  const clickReopen = () => page.evaluate(`(() => { const c = ${canvasNow}; const b = [...(c?.parentElement.querySelectorAll(".gl-lost button") ?? [])].find((x) => /Reopen/.test(x.textContent)); b?.click(); return !!b; })()`);
  const dirty = () => page.evaluate(`w3.editors.isDirty(${JSON.stringify(ground)})`);
  const look = () => page.evaluate(`(async () => (await w3.services.get("w3.terrain")).look.get(${JSON.stringify(ground)})(0, 0))()`);

  // The terrain viewer.
  await page.evaluate(`w3.editors.open(${JSON.stringify(ground)})`);
  await until("the terrain editor", () => page.evaluate(`w3.editors.activePath() === ${JSON.stringify(ground)} && !!(${canvasNow})`), 20000);
  await until("a frame of the terrain (control: the view draws)", async () => (await frames()) > 0, 20000);
  // The terrain as the editor holds it (unsaved edits included): every corner's height, and the tiles' shares.
  const tool = mcpTool(page);
  const held = () => tool("terrain_info", { heights: true });
  const unpainted = await held();
  // An unsaved edit, painted by mouse (the MCP tools save what they change).
  const hands = new Hands(page);
  await page.evaluate(`[...document.querySelectorAll("button, .tab, [role=tab]")].find((b) => b.textContent.trim() === "Terrain")?.click()`);
  await sleep(300);
  await until("the terrain view's size", () => page.evaluate(`(${canvasNow})?.clientWidth > 200`), 10000);
  const at = await page.evaluate(`(() => { const r = (${canvasNow}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await hands.drag({ x: at.x - 80, y: at.y }, { x: at.x + 80, y: at.y }).catch((e) => { throw new Error(`painting at ${JSON.stringify(at)}: ${e.message}`); });
  await sleep(300);
  if (!(await dirty())) return fail("painting left the terrain without unsaved changes (control)");
  const beforeLoss = await held();
  // The control: the snapshot sees a paint, so "unchanged while lost" below can fail.
  if (beforeLoss === unpainted) return fail("the terrain snapshot didn't change with the paint (control)");
  await glCall("loseContext");
  await until("the message about the lost view", lostShown, 5000).catch(() => fail("no message over the terrain view after its WebGL context was lost"));
  await sleep(300);
  const stopped = await frames();
  await look();
  await sleep(600);
  if ((await frames()) !== stopped) fail("the terrain view still draws on a lost context");
  // Nothing edits the terrain while its view is lost: painting over it, Ctrl+Z, a command, an MCP tool.
  await hands.drag({ x: at.x, y: at.y - 60 }, { x: at.x, y: at.y + 60 }).catch(() => {});
  await page.evaluate(`(${canvasNow}).focus()`);
  await hands.key("z", "KeyZ", 90, 2);
  await sleep(300);
  if (!(await dirty())) fail("Ctrl+Z on a lost terrain view took the unsaved edit back");
  if ((await held()) !== beforeLoss) fail("painting or Ctrl+Z edited the terrain while its view was lost");
  const command = await page.evaluate(`w3.commands.execute("w3.terrain.resetVariations").then(() => null, (e) => e.message)`);
  if (!/3D view stopped/.test(command ?? "")) fail(`Reset Variations on a lost terrain view wasn't refused: ${command}`);
  const sculpt = await tool("sculpt_terrain", { mode: "raise", amount: 100, left: -128, bottom: -64, right: 384, top: 192, shape: "box" }).then(() => null, (e) => e.message);
  if (!/3D view stopped/.test(sculpt ?? "")) fail(`sculpt_terrain on a lost terrain view wasn't refused: ${sculpt}`);
  if ((await held()) !== beforeLoss) fail("a command edited the terrain while its view was lost");
  if (!(await clickReopen())) fail("the message over the lost terrain view has no Reopen button");
  await sleep(800);
  const same = await page.evaluate(`window.__lostCanvas.isConnected`);
  if (!same || !(await dirty())) fail("Reopen with unsaved edits opened the terrain editor again: the edits are gone");
  await glCall("restoreContext");
  await sleep(500);
  if (!(await lostShown())) fail("the terrain view's message went when the context came back, but its renderer has nothing on the GPU any more");
  await page.evaluate(`w3.editors.saveAll()`);
  if (await dirty()) fail("saving after the loss left the terrain unsaved");
  const saved = readFileSync(join(root, "map", "war3map.w3e.txt"), "utf8");
  if (saved === readFileSync(join(FIXTURE, "map", "war3map.w3e.txt"), "utf8")) fail("the edit made before the loss isn't in the saved terrain");
  await clickReopen();
  await until("the terrain editor to open again", () => page.evaluate(`!window.__lostCanvas.isConnected && w3.editors.activePath() === ${JSON.stringify(ground)} && !!(${canvasNow})`), 20000)
    .catch(() => fail("Reopen with nothing unsaved didn't open the terrain editor again"));
  await until("a frame of the reopened terrain", async () => (await frames()) > 0, 20000).catch(() => fail("the reopened terrain view doesn't draw"));
  if (await lostShown()) fail("the reopened terrain view still shows the message");
  await page.evaluate(`w3.editors.closeAll()`);

  // The model viewer, on a model of the game.
  if (!game) return fail("the model viewer's part needs W3PROJ_GAME");
  const model = `game:${["Units", "Human", "Footman", "Footman.mdx"].join(String.fromCharCode(92))}`;
  await page.evaluate(`w3.editors.open(${JSON.stringify(model)}, "w3.modelViewer")`);
  await until("the model viewer", () => page.evaluate(`!!(${canvasNow})`), 20000);
  await until("a frame of the model (control)", async () => (await frames()) > 0, 20000);
  await glCall("loseContext");
  await until("the message about the lost model view", lostShown, 5000).catch(() => fail("no message over the model view after its WebGL context was lost"));
  await sleep(300);
  const modelStopped = await frames();
  await sleep(500);
  if ((await frames()) !== modelStopped) fail("the model view still draws on a lost context");
  await glCall("restoreContext");
  await until("the model view to come back", async () => !(await lostShown()), 5000).catch(() => fail("the model view's message stayed after the context came back"));
  const back = await frames();
  await until("frames of the restored model", async () => (await frames()) > back + 2, 5000).catch(() => fail("the model view doesn't draw again after the context came back"));
  // What the restored view draws comes from a renderer made again: its programs are of the new context.
  const err = await page.evaluate(`(() => { const gl = window.__lostCanvas.getContext("webgl2"); return gl.isContextLost() ? "lost" : gl.getError(); })()`);
  if (err !== 0) fail(`the restored model view gives GL error ${err}`);
  await page.evaluate(`w3.editors.closeAll()`);
}

/** The Replace dialogs (doodads with Swap Both, units with Selected Only, tiles), each one undo step; regions: bounds as
 *  numbers, several selected with Shift+click edited at once; Map Properties: a text with a line that is just } is
 *  changed to " }" when the save asks, and not saved when the answer is no. */
async function shouldHaves(page, found) {
  const fail = (what) => found.push(`should-haves: ${what}`);
  const k = await heightKit(page, "ShouldHaves");
  const TXT = "map/war3map.w3e.txt";
  await k.tool("place_objects", { objects: [{ id: "LTlt", x: -512, y: 512 }, { id: "LTlt", x: -256, y: 512 }, { id: "ATtr", x: 0, y: 512 }], ignoreRoom: true });
  await k.tool("place_objects", { objects: [{ id: "hfoo", x: 0, y: -512, player: 1 }, { id: "hfoo", x: 384, y: -512, player: 1 }, { id: "hkni", x: 768, y: -512, player: 1 }], ignoreRoom: true });
  await k.save();
  const count = (list) => list.reduce((m, o) => ({ ...m, [o.id]: (m[o.id] ?? 0) + 1 }), {});
  /** Opens a Replace dialog by its command, picks old and new (and the boxes), presses Replace. */
  const replace = async (command, from, to, boxes = []) => {
    await page.evaluate(`void w3.commands.execute(${JSON.stringify(command)})`);
    await until(`the ${command} dialog`, () => page.evaluate(`!!document.querySelector(".replace-dialog")`), 20000);
    const missing = await page.evaluate(`(() => {
      const d = document.querySelector(".replace-dialog"), set = (sel, v) => { const s = d.querySelector(sel); if (![...s.options].some((o) => o.value === v)) return sel + " has no " + v; s.value = v; return null; };
      const why = set(".replace-from", ${JSON.stringify(from)}) ?? set(".replace-to", ${JSON.stringify(to)});
      if (why) return why;
      for (const b of ${JSON.stringify(boxes)}) d.querySelector(b).checked = true;
      d.querySelector(".newmap-buttons button.primary").click();
      return null;
    })()`);
    if (missing) { fail(`${command}: ${missing}`); await page.evaluate(`document.querySelector(".replace-overlay")?.remove()`); return; }
    await sleep(800);
    await k.save();
  };
  const undo = async () => { await page.evaluate(`w3.commands.execute("workbench.undo")`); await sleep(500); await k.save(); };

  // Doodads, Swap Both: the trees trade types; one undo puts all of it back.
  const trees = JSON.stringify(count(k.doodads()));
  await replace("w3.terrain.replaceDoodads", "LTlt", "ATtr", [".replace-swap"]);
  const swapped = count(k.doodads());
  if (swapped.LTlt !== 1 || swapped.ATtr !== 2) fail(`Replace Doodads with Swap Both gave ${JSON.stringify(swapped)}, not 1 LTlt and 2 ATtr`);
  await undo();
  if (JSON.stringify(count(k.doodads())) !== trees) fail(`one undo of Replace Doodads left ${JSON.stringify(count(k.doodads()))}, not ${trees}`);

  // Units, Selected Units Only: only the selected footman becomes a knight.
  await k.tab("Select");
  await k.look(0, -512, { id: "hfoo", x: 0, y: -512 });
  await replace("w3.terrain.replaceUnits", "hfoo", "hkni", [".replace-selected"]);
  const units = count(k.units().filter((u) => u.id !== "sloc"));
  if (units.hfoo !== 1 || units.hkni !== 2) fail(`Replace Units, Selected Units Only, gave ${JSON.stringify(units)}, not 1 hfoo and 2 hkni`);

  // Tiles: the ground changes, one undo takes it back.
  const ground = hash(join(k.root, "map", "war3map.w3e.txt"));
  const tiles = await page.evaluate(`(async () => { void w3.commands.execute("w3.terrain.replaceTiles"); await new Promise((r) => setTimeout(r, 800));
    const d = document.querySelector(".replace-dialog"); const v = d ? [...d.querySelectorAll(".replace-from option")].map((o) => [o.value, o.textContent.includes(" · ")]) : []; document.querySelector(".replace-overlay")?.remove(); return v; })()`);
  // From a tile the ground has (its count shows), to another.
  const used = tiles.find(([, n]) => n)?.[0], other = tiles.find(([id]) => id !== used)?.[0];
  if (!used || !other) fail(`Replace Tiles offers ${JSON.stringify(tiles)}`);
  else {
    await replace("w3.terrain.replaceTiles", used, other);
    if (hash(join(k.root, "map", "war3map.w3e.txt")) === ground) fail(`Replace Tiles ${used} → ${other} changed nothing on disk`);
    await undo();
    if (hash(join(k.root, "map", "war3map.w3e.txt")) !== ground) fail("one undo of Replace Tiles didn't put the ground back");
  }
  if (await page.evaluate(`w3.editors.isDirty(${JSON.stringify(TXT)})`)) fail("the terrain is unsaved after saving");

  // Regions: Left typed as a number; then two selected with Shift+click take one sound in one undo step.
  await k.tool("add_region", { name: "First", left: -1024, bottom: -1024, right: -512, top: -512 });
  await k.tool("add_region", { name: "Second", left: 512, bottom: 512, right: 1024, top: 1024 });
  await sleep(500);
  await k.tab("Regions");
  const regions = () => k.read("war3map.w3r.json").regions;
  const first = regions().find((r) => r.name === "First");
  await page.evaluate(`(() => { const s = document.querySelector('select[title="Go to a region"]'); s.value = ${JSON.stringify(String(first.index))}; s.dispatchEvent(new Event("change")); })()`);
  await sleep(300);
  const typed = await page.evaluate(`(() => { const i = document.querySelector(".terrain-region-left"); if (!i) return false; i.value = "-1088"; i.dispatchEvent(new Event("change")); return true; })()`);
  if (!typed) fail("a selected region shows no Left box");
  const refused = await page.evaluate(`(() => { const i = document.querySelector(".terrain-region-right"); if (!i) return null; i.value = "-2000"; i.dispatchEvent(new Event("change")); return i.classList.contains("invalid"); })()`);
  if (refused !== true) fail(`a Right left of Left wasn't refused (${refused})`);
  await k.save();
  const moved = regions().find((r) => r.name === "First");
  if (moved?.left !== -1088 || moved?.right !== -512) fail(`after typing Left the region is ${JSON.stringify(moved && [moved.left, moved.right])}, not [-1088, -512]`);
  await k.look(768, 768);
  await sleep(500);
  const c = await k.hands.where(".model-stage canvas");
  await k.hands.mouse("mouseMoved", c.x, c.y, 0, 8);
  await k.hands.click(".model-stage canvas", null, 8);
  await sleep(300);
  const both = await page.evaluate(`document.querySelector(".terrain-region-count")?.textContent ?? null`);
  if (both !== "2 regions") fail(`Shift+click on a second region shows "${both}", not "2 regions"`);
  else {
    await page.evaluate(`(() => { const i = document.querySelector(".terrain-region-sound"); i.value = "gg_snd_Smoke"; i.dispatchEvent(new Event("change")); })()`);
    await k.save();
    const sounds = regions().map((r) => r.sound);
    if (sounds.join() !== "gg_snd_Smoke,gg_snd_Smoke") fail(`the sound for both regions gave ${JSON.stringify(sounds)}`);
    await undo();
    if (regions().some((r) => r.sound)) fail(`one undo left the sounds ${JSON.stringify(regions().map((r) => r.sound))}`);
  }

  // Map Properties: a description kept in war3map.wts, typed with a line that is just "}".
  await page.evaluate(`w3.editors.closeAll()`);
  const wtsPath = join(k.root, "map", "war3map.wts");
  const info = k.read("war3map.w3i.json");
  info.description = "TRIGSTR_900";
  await page.evaluate(`(async () => {
    await w3.workspace.writeText("map/war3map.w3i.json", ${JSON.stringify(JSON.stringify(info, null, 2))});
    await w3.workspace.writeText("map/war3map.wts", (await w3.workspace.readText("map/war3map.wts")) + "STRING 900\\r\\n{\\r\\nOld words\\r\\n}\\r\\n");
  })()`);
  const typeDescription = (text) => page.evaluate(`(async () => {
    await w3.commands.execute("w3.mapInfo.open", "description");
    await new Promise((r) => setTimeout(r, 500));
    const t = [...document.querySelectorAll(".map-info textarea")].find((x) => x.value.startsWith("Old words") || x.value.startsWith("Line one"));
    if (!t) return false;
    t.value = ${JSON.stringify(text)};
    t.dispatchEvent(new Event("input"));
    return true;
  })()`);
  const W3I = "map/war3map.w3i.json";
  // Asked, the answer no: nothing is saved, the editor stays unsaved.
  await page.evaluate(`(() => { w3.window.confirm = async () => false; })()`);
  if (!(await typeDescription("Line one\n}\nLine three"))) fail("the description isn't a text of war3map.wts in Map Properties");
  const before = readFileSync(wtsPath, "utf8");
  const refusedSave = await page.evaluate(`w3.editors.saveAll().then(() => null, (e) => String(e))`);
  if (!/starts with "}"/.test(refusedSave ?? "")) fail(`saving with the answer no gave ${JSON.stringify(refusedSave)}`);
  if (readFileSync(wtsPath, "utf8") !== before) fail("war3map.wts changed though the answer was no");
  if (!(await page.evaluate(`w3.editors.isDirty(${JSON.stringify(W3I)})`))) fail("Map Properties isn't unsaved after a refused save");
  // The answer yes: the line becomes " }" and the whole text comes back.
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const saved = readFileSync(wtsPath, "utf8");
  if (!saved.includes("Line one\r\n }\r\nLine three\r\n}")) fail(`war3map.wts holds ${JSON.stringify(saved.slice(saved.indexOf("STRING 900"), saved.indexOf("STRING 900") + 60))}`);
  if (await page.evaluate(`w3.editors.isDirty(${JSON.stringify(W3I)})`)) fail("Map Properties is unsaved after its save");
  await page.evaluate(`w3.editors.closeAll()`);

  // edit_text_file (MCP) on war3map.wts: a "}" line inside a text is refused with the reason, a " }" line is fine.
  const mcpCut = await k.tool("edit_text_file", { path: "map/war3map.wts", find: "Line three", replace: "Line three\r\n}\r\nLine five" }).then(() => null, (e) => e.message);
  if (!/outside every string/.test(mcpCut ?? "") || readFileSync(wtsPath, "utf8") !== saved) fail(`edit_text_file with a } line gave ${JSON.stringify(mcpCut)}`);
  await k.tool("edit_text_file", { path: "map/war3map.wts", find: "Line three", replace: "Line three\r\n }\r\nLine five" })
    .catch((e) => fail(`edit_text_file with a " }" line was refused: ${e.message}`));

  // war3map.wts by hand: text typed after a string's end (where a "}" line puts the rest of a text) is asked about.
  await page.evaluate(`w3.editors.open("map/war3map.wts", "w3.textEditor")`);
  await until("the text editor", () => page.evaluate(`!!document.querySelector(".cm-content")`), 20000);
  await k.hands.click(".cm-content");
  await k.hands.key("End", "End", 35, 2);
  await k.hands.type("stray words");
  const WTS = "map/war3map.wts", plain = readFileSync(wtsPath, "utf8");
  await page.evaluate(`(() => { w3.window.confirm = async () => false; })()`);
  const strayNo = await page.evaluate(`w3.editors.saveAll().then(() => null, (e) => String(e))`);
  if (!/Text outside every string/.test(strayNo ?? "") || readFileSync(wtsPath, "utf8") !== plain) fail(`a hand-typed line outside every string, answered no, gave ${JSON.stringify(strayNo)}${readFileSync(wtsPath, "utf8") !== plain ? " and changed the file" : ""}`);
  if (!(await page.evaluate(`w3.editors.isDirty(${JSON.stringify(WTS)})`))) fail("the string table isn't unsaved after a refused save");
  await page.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
  await page.evaluate(`w3.editors.saveAll()`);
  if (!readFileSync(wtsPath, "utf8").includes("stray words")) fail("Save Anyway didn't save the string table");
  await page.evaluate(`w3.editors.closeAll()`);

  // Map Properties ▸ Players: ally priorities (player 1 gives player 2 high) and the HUD skin.
  const two = k.read("war3map.w3i.json");
  two.players.push({ ...two.players[0], id: 1, name: "Second", start: [512, 512] });
  await page.evaluate(`w3.workspace.writeText("map/war3map.w3i.json", ${JSON.stringify(JSON.stringify(two, null, 2))})`);
  const picked = await page.evaluate(`(async () => {
    await w3.commands.execute("w3.mapInfo.open", "players");
    await new Promise((r) => setTimeout(r, 500));
    const choose = (s, v) => { if (!s) return false; s.value = v; s.dispatchEvent(new Event("change")); return true; };
    const ally = document.querySelector(".map-priorities-ally tbody tr:first-child td:nth-child(3) select");
    const skin = [...document.querySelectorAll(".map-info select")].find((s) => [...s.options].some((o) => o.textContent === "Selected Race"));
    return { ally: choose(ally, "high"), skin: choose(skin, "2"), hasSkin: ${JSON.stringify(two.players[0].hudSkin !== undefined)} };
  })()`);
  if (!picked.ally) fail("Map Properties shows no ally priority for player 2 in player 1's row");
  if (picked.hasSkin && !picked.skin) fail("Map Properties shows no HUD Skin for a map that has them");
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const after = k.read("war3map.w3i.json").players;
  if (after[0].allyHigh !== 2 || after[0].allyLow !== 0) fail(`player 1's ally priorities are low ${after[0].allyLow}, high ${after[0].allyHigh}, not high for player 2`);
  if (picked.hasSkin && after[0].hudSkin !== 2) fail(`player 1's HUD skin is ${after[0].hudSkin}, not 2 (Orc)`);
  await page.evaluate(`w3.editors.closeAll()`);
  await k.reset();
}

/** The placer's per-placement look (a chosen variation, random rotation, asymmetric random scale) and random objects
 *  (an item by level and class, a unit from a random group) by the toolbar and the Random… dialog; they round-trip
 *  through the codec and come out in the packed script. Cycle Random Groups; the campaign's Gameplay Constants and
 *  Game Interface, with its own string table, from the commands and from the Campaign Editor. */
async function placerAndCampaign(page, found) {
  const fail = (what) => found.push(`placer and campaign: ${what}`);
  const k = await heightKit(page, "Placer");
  const settings = ["terrain.placement.randomVariation", "terrain.placement.randomRotation", "terrain.placement.randomScale"];
  const doodads = () => k.doodads().filter((d) => d.id === "ARrk");
  const set = (sel, value) => page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s || s.closest("[hidden]")) return false;
    if (s.type === "checkbox") s.checked = ${JSON.stringify(value)}; else s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change")); return true; })()`);
  const click = async (x, y) => { await k.look(x, y); await sleep(400); await k.clickMiddle(); await sleep(600); };
  try {
    // A rock (ten variations, scale 0.8–1.2, any facing), chosen in the Objects tab from one placed by a tool.
    await k.tool("place_objects", { objects: [{ id: "ARrk", x: -768, y: -768 }], ignoreRoom: true });
    await k.save();
    await k.look(-768, -768, { id: "ARrk", x: -768, y: -768 });
    await sleep(400);
    await k.run("w3.terrain.selectInPalette");
    await sleep(300);
    const hint = await page.evaluate(`document.querySelector(".terrain-place-hint")?.textContent`);
    if (!/Placing .*ARrk/.test(hint ?? "")) return fail(`the Objects tab says "${hint}" after Select In Tool Palette`);
    // Without anything random: the first variation, facing 270, unscaled (as before).
    await click(0, 0);
    await k.save();
    const plain = doodads().find((d) => Math.abs(d.position[0]) < 64 && Math.abs(d.position[1]) < 64);
    if (!plain) return fail(`a click placed no rock (${doodads().length} rocks; ${await k.toasts()})`);
    if (plain.variation !== 0 || Math.abs(plain.angle - 4.712389) > 1e-4 || plain.scale.some((s) => s !== 1)) fail(`a plain placement is ${JSON.stringify([plain.variation, plain.angle, plain.scale])}`);
    // Variation 4 (shown as 4, stored as 3), random rotation, asymmetric scale.
    const boxes = [await set(".terrain-place-variation", "3"), await set(".terrain-place-rotation input", true), await set(".terrain-place-scale", "asymmetric")];
    if (boxes.some((b) => !b)) return fail(`the placer's Variation, Random rotation and Random scale controls: ${JSON.stringify(boxes)}`);
    await sleep(300);
    await click(512, 0);
    await k.save();
    const rolled = doodads().find((d) => Math.abs(d.position[0] - 512) < 64 && Math.abs(d.position[1]) < 64);
    if (!rolled) fail("the second click placed no rock");
    else {
      if (rolled.variation !== 3) fail(`the chosen variation 4 placed variation ${rolled.variation + 1}`);
      if (Math.abs(rolled.angle - 4.712389) < 1e-4) fail("Random rotation placed a rock facing 270");
      const [x, y, z] = rolled.scale;
      if (![x, y, z].every((s) => s >= 0.8 - 1e-6 && s <= 1.2 + 1e-6) || (x === y && y === z)) fail(`asymmetric random scale placed ${JSON.stringify(rolled.scale)}`);
    }
    if (await k.setting("terrain.placement.randomRotation") !== true || await k.setting("terrain.placement.randomScale") !== "asymmetric") fail("the placer's choices aren't kept as settings");
    // One undo takes the last placement back, and only that.
    const before = doodads().length;
    await page.evaluate(`w3.commands.execute("workbench.undo")`);
    await sleep(400);
    await k.save();
    if (doodads().length !== before - 1) fail(`one undo left ${doodads().length} of ${before} rocks`);

    // Random objects: a group with a unit and an item position in Map Properties' random groups.
    const info = k.read("war3map.w3i.json");
    info.unitTables = [{ number: 7, name: "Smoke Group", positions: [0, 2], lines: [{ chance: 60, ids: ["hfoo", "ratc"] }, { chance: 40, ids: ["hkni", "ckng"] }] }];
    await page.evaluate(`w3.workspace.writeText("map/war3map.w3i.json", ${JSON.stringify(JSON.stringify(info, null, 2))})`);
    const random = async (choose) => {
      await page.evaluate(`document.querySelector(".terrain-place-random").click()`);
      await until("the Random dialog", () => page.evaluate(`!!document.querySelector(".random-dialog")`), 10000);
      const why = await page.evaluate(`(() => { const d = document.querySelector(".random-dialog"), set = (sel, v) => { const s = d.querySelector(sel); if (s.type === "radio") s.checked = true; else s.value = v; s.dispatchEvent(new Event("change")); };
        ${choose}; d.querySelector(".newmap-buttons button.primary").click(); return document.querySelector(".random-dialog") ? "the dialog stayed open" : null; })()`);
      if (why) { await page.evaluate(`document.querySelector(".random-overlay")?.remove()`); throw new Error(why); }
      await sleep(300);
    };
    await random(`set(".random-what", "item"); set(".random-by-level"); set(".random-level", "3"); set(".random-class", "1")`);
    await click(-512, 512);
    await random(`set(".random-what", "unit"); set(".random-by-group"); set(".random-group", "7"); set(".random-position", "0")`);
    await click(512, 512);
    await k.save();
    const units = k.units();
    const item = units.find((u) => u.id === "iDNR"), unit = units.find((u) => u.id === "uDNR");
    if (!item || item.randomType !== 0 || item.randomLevel !== "030000" || item.randomClass !== 1 || item.player !== 27) fail(`the random item: ${JSON.stringify(item && [item.randomType, item.randomLevel, item.randomClass, item.player])}`);
    if (!unit || unit.randomType !== 1 || unit.randomGroup !== 7 || unit.randomPosition !== 0 || "randomLevel" in unit) fail(`the random unit: ${JSON.stringify(unit && [unit.randomType, unit.randomGroup, unit.randomPosition, unit.randomLevel])}`);
    // They have a model (the question mark), not an unknown id.
    const warns = await page.evaluate(`[...document.querySelectorAll(".model-warn")].map((e) => e.textContent).join(" | ")`);
    if (/[ui]DNR/.test(warns)) fail(`the random objects are reported: ${warns}`);
    // Cycle Random Groups: the group's lines, then the question mark again.
    await k.clearToasts();
    for (const want of ["line 1", "line 2", "question mark"]) {
      const err = await k.run("w3.terrain.cycleRandomGroupsNext");
      await sleep(300);
      if (err) { fail(`Cycle Random Groups: ${err}`); break; }
      if (!(await k.toasts()).includes(want)) { fail(`Cycle Random Groups says "${await k.toasts()}", not ${want}`); break; }
      await k.clearToasts();
    }
    if ((await page.evaluate(`w3.editors.unsavedPaths()`)).length) fail(`Cycle Random Groups left unsaved editors: ${await page.evaluate(`w3.editors.unsavedPaths()`)}`);
    // Through the codec and into the packed script.
    await k.verify(fail);
    const output = await page.evaluate(`w3.workspace.project().default_output`);
    const map = resolve(k.root, output);
    rmSync(map, { force: true });
    await page.evaluate(`void w3.commands.execute("w3.project.pack")`);
    await until("the build", () => existsSync(map), 30000).catch(() => fail("no build"));
    if (existsSync(map)) {
      await sleep(300);
      const script = spawnSync(cli, ["cat", map, "war3map.j"], { maxBuffer: 1 << 28 }).stdout.toString("latin1");
      for (const line of ["set itemID = ChooseRandomItemEx( ITEM_TYPE_PERMANENT, 3 )", "set unitID = gg_rg_007[0]", "BlzCreateItemWithSkin( itemID,"]) {
        if (!script.includes(line)) fail(`the packed script has no "${line}"`);
      }
      if (/'[ui]DNR'/.test(script)) fail("the packed script creates a random object by its placeholder id");
    }
  } finally {
    for (const key of settings) await page.evaluate(`w3.settings.set(${JSON.stringify(key)}, undefined)`);
    await page.evaluate(`w3.editors.closeAll()`);
  }

  // ---- the campaign's Gameplay Constants and Game Interface ---------------------------------
  const camp = join(work, "campaign-settings");
  rmSync(camp, { recursive: true, force: true });
  await page.evaluate(`w3.backend.invoke("project_create", { dir: ${JSON.stringify(camp)}, name: "Smoke Campaign", flags: 0, maxPlayers: 0, campaign: true })`);
  await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(camp)}); })()`);
  await until("the campaign", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(camp)}`), 20000);
  const campInfo = { format: "w3proj.campaign/1", version: 3, campaignVersion: 1, editorVersion: 6116, name: "TRIGSTR_001", difficulty: "TRIGSTR_002", author: "TRIGSTR_003", description: "TRIGSTR_004",
    flags: 1, background: 0, backgroundPath: "", minimapPath: "", ambientSound: 0, ambientSoundPath: "", fogStyle: 0, fogStartZ: 0, fogEndZ: 0, fogDensity: 0, fogColor: [0, 0, 0, 0], race: 0,
    unknown3: [0, 0, 0, 0, 0, 0, 1], chapters: [], mapOrder: [] };
  const strings = "STRING 1\r\n{\r\nSmoke Campaign\r\n}\r\n\r\nSTRING 2\r\n{\r\nNormal\r\n}\r\n\r\nSTRING 3\r\n{\r\nMe\r\n}\r\n\r\nSTRING 4\r\n{\r\nWords\r\n}\r\n\r\nSTRING 9\r\n{\r\nCampaign Gold Text\r\n}\r\n";
  await page.evaluate(`(async () => {
    const root = w3.workspace.project().root, path = "map/war3campaign.w3f.json";
    await w3.workspace.writeText(path, await w3.backend.invoke("codec_canonicalize", { root, path, text: ${JSON.stringify(JSON.stringify(campInfo))} }));
    await w3.workspace.writeText("map/war3campaign.wts", ${JSON.stringify(strings)});
    await w3.workspace.writeText("map/war3campaignSkin.txt", "[FrameDef]\\r\\nGOLD=TRIGSTR_009\\r\\n");
    await w3.workspace.refresh();
  })()`);
  const skinBefore = readFileSync(join(camp, "map", "war3campaignSkin.txt"));
  // Gameplay Constants from the Campaign Editor's button: the campaign's file, its title says so.
  await page.evaluate(`w3.commands.execute("w3.campaign.open", "general")`);
  await until("the Campaign Editor", () => page.evaluate(`!!document.querySelector(".camp-gameplay")`), 20000).catch(() => fail("the Campaign Editor has no Gameplay Constants button"));
  await page.evaluate(`document.querySelector(".camp-gameplay")?.click()`);
  await until("the campaign's Gameplay Constants", () => page.evaluate(`w3.editors.activePath() === "map/war3campaignMisc.txt" && !!document.querySelector(".gs-row")`), 30000)
    .catch(async () => fail(`the button opened ${await page.evaluate(`w3.editors.activePath()`)}`));
  const title = await page.evaluate(`document.querySelector(".gs-toolbar strong")?.textContent`);
  if (title !== "Campaign Gameplay Constants") fail(`the editor is titled "${title}"`);
  // A value changed and saved goes into the campaign's file, nothing into a map's.
  const typed = await page.evaluate(`(() => { const row = [...document.querySelectorAll(".gs-row")].find((r) => /MaxHeroLevel/.test(r.title)); const i = row?.querySelector("input"); if (!i) return false; i.value = "12"; i.dispatchEvent(new Event("change")); return true; })()`);
  if (!typed) fail("the campaign's Gameplay Constants have no Hero Maximum Level");
  await page.evaluate(`w3.editors.saveAll()`);
  await sleep(300);
  const misc = existsSync(join(camp, "map", "war3campaignMisc.txt")) ? readFileSync(join(camp, "map", "war3campaignMisc.txt"), "utf8") : "";
  if (!/MaxHeroLevel=12/.test(misc)) fail(`war3campaignMisc.txt holds ${JSON.stringify(misc)}`);
  if (existsSync(join(camp, "map", "war3mapMisc.txt"))) fail("the campaign got a war3mapMisc.txt");
  // Game Interface by its command: the text comes from war3campaign.wts; opened and closed unchanged, the file stays as it was.
  await page.evaluate(`w3.commands.execute("w3.gameInterface.open")`);
  await until("the campaign's Game Interface", () => page.evaluate(`w3.editors.activePath() === "map/war3campaignSkin.txt" && !!document.querySelector(".gs-row")`), 30000)
    .catch(async () => fail(`Game Interface opened ${await page.evaluate(`w3.editors.activePath()`)}`));
  const shown = await page.evaluate(`[...document.querySelectorAll(".gs-row.set input")].map((i) => i.value)`);
  if (!shown.includes("Campaign Gold Text")) fail(`the campaign's Game Interface shows ${JSON.stringify(shown)}, not the text in war3campaign.wts`);
  await page.evaluate(`w3.editors.closeAll()`);
  await sleep(300);
  if (!readFileSync(join(camp, "map", "war3campaignSkin.txt")).equals(skinBefore)) fail("opening the campaign's Game Interface changed war3campaignSkin.txt");
  // Packed, the campaign keeps both files byte for byte.
  const w3n = join(work, "campaign-settings.w3n");
  const packed = spawnSync(cli, ["pack", camp, "-o", w3n], { encoding: "utf8" });
  if (packed.status !== 0) fail(`the campaign doesn't pack: ${packed.stderr}`);
  else {
    for (const [file, want] of [["war3campaignMisc.txt", misc], ["war3campaignSkin.txt", skinBefore.toString("utf8")]]) {
      const got = spawnSync(cli, ["cat", w3n, file], { encoding: "utf8" }).stdout;
      if (got !== want) fail(`the packed campaign's ${file} is ${JSON.stringify(got)}`);
    }
  }
  await page.evaluate(`w3.editors.closeAll()`);
}

/** Validate Map Triggers, renaming what triggers refer to, the AI Editor's Add To Map and custom data, and the Problems'
 *  Map Properties links, through the app on a new map (the game's TriggerData): a broken parameter is reported and a
 *  click on it opens the trigger with the parameter marked, while the valid triggers report nothing; renaming a trigger
 *  rewrites its gg_trg_ references and, after the question, its InitTrig_ in its text, as one undo step; renaming a region
 *  rewrites gg_rct_ in GUI parameters and script, once with the Trigger Editor closed (the files) and once with it open
 *  (its state, saved at once), and References in triggers stays empty; Add To Map writes Scripts\<name>.ai and its one
 *  import entry, the map packs and verifies; custom data goes in from a unit file, comes out as a .w3o, and undo takes it
 *  out again; a missing loading screen model opens Map Properties at Loading Screen. */
async function triggersAndAi(page, found) {
  const fail = (what) => found.push(`triggers and AI: ${what}`);
  const k = await heightKit(page, "TriggersAi");
  const dir = join(work, "triggers-ai");
  mkdirSync(dir, { recursive: true });
  // The answers a user gives: rename in script too; files chosen here.
  await page.evaluate(`(() => {
    window.__kept = { warn: w3.window.showWarning, pick: w3.window.pickFile, save: w3.window.pickSaveFile };
    window.__warned = [];
    w3.window.showWarning = async (m) => { window.__warned.push(m); return "Rename in script too"; };
  })()`);
  const warned = () => page.evaluate(`window.__warned.splice(0)`);
  const listProblems = () => page.evaluate(`(async () => { const s = await w3.services.get("w3.problems"); await s.run();
    return s.problems().map((p) => ({ severity: p.severity, message: p.message, location: p.location ?? "", reveal: p.reveal ?? null })); })()`);
  const refsProblems = (list) => list.filter((p) => /doesn't exist in this map/.test(p.message));
  const wtgFile = () => k.read("war3map.wtg.json");
  const wct = () => readFileSync(join(k.root, "map", "war3map.wct.txt"), "utf8");
  /** Clicks the Problems row whose text has `text`. */
  const clickProblem = (text) => page.evaluate(`(async () => {
    await w3.views.show("problems");
    await new Promise((r) => setTimeout(r, 300));
    const row = [...document.querySelectorAll(".problem-row.clickable")].find((r) => r.textContent.includes(${JSON.stringify(text)}));
    if (!row) return false;
    row.click();
    await new Promise((r) => setTimeout(r, 800));
    return true;
  })()`);
  try {
    // ---- A region, triggers naming it, script naming both ---------------------------------------------------------
    await k.tool("add_region", { name: "Smoke Gate", left: -256, bottom: -256, right: 256, top: 256 });
    await k.tool("create_script_trigger", { name: "Gate Script", script: "function InitTrig_Gate_Script takes nothing returns nothing\n    call RemoveRect(gg_rct_Smoke_Gate)\nendfunction\n" });
    await k.tool("create_script_trigger", { name: "Gate Watch", script: "" });
    await k.tool("create_script_trigger", { name: "Broken Kill", script: "" });
    await k.tool("set_script_header", { script: "// gg_rct_Smoke_Gate and gg_trg_Gate_Watch\n" });
    const wtg = wtgFile();
    const p1 = (value) => ({ type: 1, value });
    const line = (kind, name, params) => ({ kind, name, enabled: true, params, children: [] });
    const gui = (name, ecas) => { const t = wtg.items.find((i) => i.name === name); t.isCustom = false; t.ecas = ecas; };
    gui("Gate Watch", [line(0, "TriggerRegisterEnterRectSimple", [p1("gg_rct_Smoke_Gate")]), line(2, "TriggerExecute", [p1("gg_trg_Gate_Script")]), line(2, "RemoveRect", [p1("gg_rct_Smoke_Gate")])]);
    gui("Broken Kill", [line(0, "MapInitializationEvent", []), line(2, "KillUnit", [{ type: 0, value: "PlayerNA" }])]);
    await page.evaluate(`w3.workspace.writeText("map/war3map.wtg.json", ${JSON.stringify(JSON.stringify(wtg, null, 2))})`);

    // ---- Validate Map Triggers ---------------------------------------------------------------------------------------
    let list = await listProblems();
    const flagged = list.filter((p) => p.reveal?.command === "w3.triggers.reveal");
    const broken = flagged.filter((p) => p.location === "Broken Kill");
    if (broken.length !== 1 || !/^Action 1: .*parameter 1 \(Unit\): .* is Player, not Unit$/.test(broken[0].message)) fail(`Broken Kill is reported as ${JSON.stringify(broken.map((p) => p.message))}`);
    // Control: the map's own trigger, Gate Watch and the script triggers are valid, and their references exist.
    const others = flagged.filter((p) => p.location !== "Broken Kill");
    if (others.length) fail(`valid triggers are reported: ${others.map((p) => `${p.location}: ${p.message}`).join(" | ").slice(0, 400)}`);
    if (!(await clickProblem("is Player, not Unit"))) fail("the Problems view has no row to click for Broken Kill");
    else {
      const shown = await page.evaluate(`({ active: w3.editors.activePath(), tree: document.querySelector(".trig-row.active")?.textContent ?? null,
        marked: !!document.querySelector(".trig-eca.active .trig-param.trig-flagged"), text: document.querySelector(".trig-eca.active .trig-flagged")?.textContent ?? null })`);
      if (shown.active !== "map/war3map.wtg.json" || !/Broken Kill/.test(shown.tree ?? "") || !shown.marked) fail(`a click on the problem shows ${JSON.stringify(shown)}, not Broken Kill with its parameter marked`);
    }

    // ---- Renaming a trigger: its references, its InitTrig_ after the question, one undo step ---------------------------
    const renamed = await page.evaluate(`(async () => {
      const row = [...document.querySelectorAll(".trig-row")].find((r) => r.textContent.trim() === "Gate Script");
      if (!row) return "no Gate Script in the tree";
      row.click();
      await new Promise((r) => setTimeout(r, 300));
      const input = document.querySelector(".trig-name");
      input.value = "Gate Runner";
      input.dispatchEvent(new Event("change"));
      await new Promise((r) => setTimeout(r, 500));
      return null;
    })()`);
    if (renamed) fail(renamed);
    const askedTrigger = await warned();
    if (askedTrigger.length !== 1 || !/gg_trg_Gate_Script and InitTrig_Gate_Script appear 1 time in custom script/.test(askedTrigger[0] ?? "")) fail(`renaming the trigger asked ${JSON.stringify(askedTrigger)}`);
    await k.save();
    const afterRename = JSON.stringify(wtgFile());
    if (!afterRename.includes("gg_trg_Gate_Runner") || afterRename.includes("gg_trg_Gate_Script") || !afterRename.includes("\"Gate Runner\"")) fail("the trigger's gg_trg_ parameter didn't follow its new name");
    if (!/InitTrig_Gate_Runner/.test(wct()) || /InitTrig_Gate_Script/.test(wct())) fail("the trigger's own InitTrig_ didn't follow its new name");
    list = await listProblems();
    if (refsProblems(list).length) fail(`after renaming the trigger, References in triggers reports ${refsProblems(list).map((p) => p.message).join(" | ")}`);
    await page.evaluate(`w3.editors.open("map/war3map.wtg.json")`);
    await page.evaluate(`w3.commands.execute("workbench.undo")`);
    await sleep(300);
    await k.save();
    const undone = JSON.stringify(wtgFile());
    if (!undone.includes("gg_trg_Gate_Script") || undone.includes("Gate Runner") || !/InitTrig_Gate_Script/.test(wct())) fail("one undo didn't take the rename and its references back");
    // A GUI trigger has only its gg_trg_ name in the script (the header): the question is about one name.
    const renamedGui = await page.evaluate(`(async () => {
      document.querySelectorAll(".trig-row .trig-caret").forEach((c) => { if (c.textContent === "▸") c.click(); });
      const row = [...document.querySelectorAll(".trig-row")].find((r) => r.textContent.trim() === "Gate Watch");
      if (!row) return "no Gate Watch in the tree";
      row.click();
      await new Promise((r) => setTimeout(r, 300));
      const input = document.querySelector(".trig-name");
      input.value = "Gate Guard";
      input.dispatchEvent(new Event("change"));
      await new Promise((r) => setTimeout(r, 500));
      await w3.commands.execute("workbench.undo");
      await new Promise((r) => setTimeout(r, 300));
      return w3.editors.isDirty("map/war3map.wtg.json") ? "undoing the rename of Gate Watch left unsaved changes" : null;
    })()`);
    if (renamedGui) fail(renamedGui);
    const askedGui = await warned();
    if (askedGui.length !== 1 || askedGui[0] !== "gg_trg_Gate_Watch appears 1 time in custom script. Rename it there too?") fail(`renaming a GUI trigger asked ${JSON.stringify(askedGui)}`);
    // A parameter without a value (a variable of no name, as Validate reports "isn't set") shows its argument in red.
    const keptWtg = readFileSync(join(k.root, "map", "war3map.wtg.json"), "utf8");
    const noValue = JSON.parse(keptWtg);
    noValue.items.find((i) => i.name === "Broken Kill").ecas[1].params[0] = { type: 1, value: "" };
    await page.evaluate(`w3.workspace.writeText("map/war3map.wtg.json", ${JSON.stringify(JSON.stringify(noValue, null, 2))})`);
    await sleep(1500);
    const unsetShown = await page.evaluate(`(async () => {
      document.querySelectorAll(".trig-row .trig-caret").forEach((c) => { if (c.textContent === "▸") c.click(); });
      const row = [...document.querySelectorAll(".trig-row")].find((r) => r.textContent.trim() === "Broken Kill");
      if (!row) return null;
      row.click();
      await new Promise((r) => setTimeout(r, 300));
      return [...document.querySelectorAll(".trig-eca .trig-param.unset")].map((e) => e.textContent);
    })()`);
    if (!unsetShown?.length || unsetShown.some((t) => !/^<.+>$/.test(t))) fail(`a parameter without a value shows as ${JSON.stringify(unsetShown)}, not its argument's name`);
    await page.evaluate(`w3.workspace.writeText("map/war3map.wtg.json", ${JSON.stringify(keptWtg)})`);
    await sleep(1000);

    // ---- Renaming a region with the Trigger Editor closed: the files follow ---------------------------------------------
    await page.evaluate(`w3.editors.close("map/war3map.wtg.json")`);
    const renameRegion = async (from, to) => {
      await page.evaluate(`w3.editors.open("map/war3map.w3e.txt")`);
      await sleep(300);
      await k.tab("Regions");
      const index = k.read("war3map.w3r.json").regions.find((r) => r.name === from)?.index;
      return page.evaluate(`(async () => {
        const s = document.querySelector('select[title="Go to a region"]');
        if (!s) return "no region list";
        s.value = ${JSON.stringify(String(index))}; s.dispatchEvent(new Event("change"));
        await new Promise((r) => setTimeout(r, 300));
        const i = document.querySelector(".terrain-region-name");
        if (!i) return "no name box for ${from}";
        i.value = ${JSON.stringify(to)}; i.dispatchEvent(new Event("change"));
        await w3.commands.execute("workbench.save");
        await new Promise((r) => setTimeout(r, 800));
        return null;
      })()`);
    };
    const r1 = await renameRegion("Smoke Gate", "Smoke Door");
    if (r1) fail(r1);
    const askedRegion = await warned();
    if (askedRegion.length !== 1 || !/gg_rct_Smoke_Gate appears 2 times in custom script/.test(askedRegion[0] ?? "")) fail(`renaming the region asked ${JSON.stringify(askedRegion)}`);
    const doorWtg = JSON.stringify(wtgFile());
    if ((doorWtg.match(/gg_rct_Smoke_Door/g) ?? []).length !== 2 || doorWtg.includes("gg_rct_Smoke_Gate")) fail("the region's GUI parameters didn't follow its new name (Trigger Editor closed)");
    if (!/RemoveRect\(gg_rct_Smoke_Door\)/.test(wct()) || !/\/\/ gg_rct_Smoke_Door and/.test(wct())) fail("the region's script uses didn't follow its new name (Trigger Editor closed)");
    list = await listProblems();
    if (refsProblems(list).length) fail(`after renaming the region, References in triggers reports ${refsProblems(list).map((p) => p.message).join(" | ")}`);

    // ---- The same with the Trigger Editor open and nothing unsaved in it: its state follows and is saved ------------------
    await page.evaluate(`w3.commands.execute("w3.triggers.open")`);
    await sleep(500);
    const r2 = await renameRegion("Smoke Door", "Smoke Arch");
    if (r2) fail(r2);
    await warned();
    if (await page.evaluate(`w3.editors.isDirty("map/war3map.wtg.json")`)) fail("the open Trigger Editor wasn't saved after taking the region's new name");
    const archWtg = JSON.stringify(wtgFile());
    if ((archWtg.match(/gg_rct_Smoke_Arch/g) ?? []).length !== 2 || /RemoveRect\(gg_rct_Smoke_Door\)/.test(wct())) fail("the region's references didn't follow its new name through the open Trigger Editor");
    await page.evaluate(`w3.editors.closeAll()`);

    // ---- Problems' Map Properties link: the loading screen's section ---------------------------------------------------
    const infoText = readFileSync(join(k.root, "map", "war3map.w3i.json"), "utf8");
    const info = JSON.parse(infoText);
    info.loadingScreen = { ...(info.loadingScreen ?? {}), model: "UI\\Smoke\\Missing.mdx" };
    await page.evaluate(`w3.workspace.writeText("map/war3map.w3i.json", ${JSON.stringify(JSON.stringify(info, null, 2))})`);
    list = await listProblems();
    if (!list.some((p) => p.location === "Map Properties › Loading screen")) fail("the missing loading screen model isn't reported");
    else if (!(await clickProblem("UI\\Smoke\\Missing.mdx"))) fail("no row to click for the loading screen model");
    else {
      const section = await page.evaluate(`document.querySelector(".form-nav-item.active")?.textContent ?? null`);
      if (section !== "Loading Screen") fail(`the loading screen's problem opens Map Properties at ${JSON.stringify(section)}`);
    }
    await page.evaluate(`w3.editors.closeAll()`);
    // As it was, for packing below.
    await page.evaluate(`w3.workspace.writeText("map/war3map.w3i.json", ${JSON.stringify(infoText)})`);

    // ---- AI Editor: Add To Map -------------------------------------------------------------------------------------------
    const wai = join(dir, "Smoke Raider.wai");
    rmSync(wai, { force: true });
    await page.evaluate(`(async () => { w3.window.pickSaveFile = async () => ${JSON.stringify(wai)}; await w3.commands.execute("w3.ai.new"); await new Promise((r) => setTimeout(r, 800)); })()`);
    const addErr = await k.run("w3.ai.addToMap");
    if (addErr) fail(`Add To Map: ${addErr}`);
    const script = join(k.root, "map", "Scripts", "Smoke Raider.ai");
    if (!existsSync(script) || !/function main takes nothing returns nothing/.test(readFileSync(script, "utf8"))) fail("Add To Map didn't write Scripts/Smoke Raider.ai with the AI script");
    await k.run("w3.ai.addToMap");
    const entries = k.read("war3map.imp.json").files.filter((f) => f.path === "Scripts\\Smoke Raider.ai");
    if (entries.length !== 1 || entries[0].flags !== 21) fail(`the import list has ${JSON.stringify(entries)} for the AI script after two Add To Map`);
    await k.verify(fail);

    // ---- AI Editor: custom data in from a unit file, out as a .w3o, undo -------------------------------------------------
    const w3u = join(dir, "units.w3u");
    const unitFile = Buffer.alloc(24);
    unitFile.writeUInt32LE(2, 0); unitFile.writeUInt32LE(0, 4); unitFile.writeUInt32LE(1, 8); unitFile.write("hfooh000", 12, "latin1"); unitFile.writeUInt32LE(0, 20);
    writeFileSync(w3u, unitFile);
    await page.evaluate(`w3.window.pickFile = async () => ${JSON.stringify(w3u)}`);
    const inErr = await k.run("w3.ai.importCustomData");
    if (inErr) fail(`Import Custom Data: ${inErr}`);
    const shows = () => page.evaluate(`document.querySelector(".ai-custom-data")?.textContent ?? null`);
    if (!/Object data from .*units\.w3u/.test((await shows()) ?? "")) fail(`after Import Custom Data the General tab shows ${JSON.stringify(await shows())}`);
    const out = join(dir, "out.w3o");
    rmSync(out, { force: true });
    await page.evaluate(`w3.window.pickSaveFile = async () => ${JSON.stringify(out)}`);
    const outErr = await k.run("w3.ai.exportCustomData");
    if (outErr) fail(`Export Custom Data: ${outErr}`);
    const w3o = existsSync(out) ? readFileSync(out) : Buffer.alloc(0);
    const want = Buffer.concat([Buffer.from([1, 0, 0, 0, 1, 0, 0, 0]), unitFile, Buffer.alloc(24)]);
    if (!w3o.equals(want)) fail(`the exported .w3o is ${w3o.length} bytes, not the unit file in a .w3o (${want.length})`);
    await page.evaluate(`w3.commands.execute("workbench.undo")`);
    await sleep(300);
    if (!/^None/.test((await shows()) ?? "")) fail(`one undo of Import Custom Data shows ${JSON.stringify(await shows())}`);
    await page.evaluate(`w3.commands.execute("workbench.redo")`);
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(300);
    if (!readFileSync(wai).includes(Buffer.from("units.w3u"))) fail("the saved AI doesn't carry the custom data");
  } finally {
    await page.evaluate(`(() => { const k = window.__kept; if (k) { w3.window.showWarning = k.warn; w3.window.pickFile = k.pick; w3.window.pickSaveFile = k.save; } })()`);
    await page.evaluate(`w3.editors.closeAll()`).catch(() => {});
  }
}

/** An editor doesn't save over what was saved after it read the file. Round 4 lost a trigger that way: an AI tool created
 *  it right after the project opened, while the Trigger Editor of the last session was coming back, and the editor's next
 *  save deleted it. 1. A tool's save while the editor loads: it opens again once it's there. 2. The triggers' texts
 *  (war3map.wct.txt) saved by a tool while it's open: it opens again. 3. Its file changed on disk without the app
 *  hearing of it: saving asks, Cancel writes nothing. 4. A tab that couldn't open (its file wasn't there yet, a tab of
 *  the last session) opens once the file is written (the AI Editor's New), and Add To Map works. */
async function staleEditors(page, found) {
  const fail = (what) => found.push(`stale editors: ${what}`);
  const k = await heightKit(page, "StaleEditors");
  const WTG = "map/war3map.wtg.json";
  const wtgText = () => readFileSync(join(k.root, "map", "war3map.wtg.json"), "utf8");
  const wct = () => readFileSync(join(k.root, "map", "war3map.wct.txt"), "utf8");
  const rows = () => page.evaluate(`(() => {
    document.querySelectorAll(".trig-row .trig-caret").forEach((c) => { if (c.textContent === "▸") c.click(); });
    return [...document.querySelectorAll(".trig-row")].map((r) => r.textContent.trim());
  })()`);
  /** Renames a trigger in the Trigger Editor (an edit, not saved). */
  const rename = (from, to) => page.evaluate(`(async () => {
    document.querySelectorAll(".trig-row .trig-caret").forEach((c) => { if (c.textContent === "▸") c.click(); });
    const row = [...document.querySelectorAll(".trig-row")].find((r) => r.textContent.trim() === ${JSON.stringify(from)});
    if (!row) return "no trigger ${from} in the tree";
    row.click();
    await new Promise((r) => setTimeout(r, 300));
    const input = document.querySelector(".trig-name");
    input.value = ${JSON.stringify(to)};
    input.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 300));
    return w3.editors.isDirty(${JSON.stringify(WTG)}) ? null : "renaming ${from} left nothing unsaved";
  })()`);
  await page.evaluate(`(() => {
    const ed = w3Workbench.editors;
    window.__stale = { memory: ed.memory, resolveTab: ed.resolveTab, confirm: ed.confirm, warn: w3.window.showWarning, save: w3.window.pickSaveFile };
    w3.window.showWarning = async () => "Only GUI triggers";
  })()`);
  try {
    await page.evaluate(`w3.editors.closeAll()`);
    // ---- 1. The Trigger Editor comes back with the project and arrives late; a tool creates a trigger after it read ----
    await page.evaluate(`(() => {
      const ed = w3Workbench.editors, kept = window.__stale;
      window.__read = false;
      window.__gate = new Promise((r) => { window.__open = r; });
      ed.memory = { load: () => ({ tabs: [{ path: ${JSON.stringify(WTG)}, editor: "w3.triggerEditor" }], active: ${JSON.stringify(WTG)} }), store: () => {} };
      ed.resolveTab = function (tab, p) {
        return kept.resolveTab.call(ed, tab, { ...p, resolve: async (el, doc) => {
          const made = await p.resolve(el, doc);
          // The first time only: it has read the files and isn't there yet.
          if (!window.__read) { window.__read = true; await window.__gate; }
          return made;
        } });
      };
      void ed.restore();
    })()`);
    await until("the Trigger Editor read the files", () => page.evaluate(`window.__read`), 30000);
    await k.tool("create_script_trigger", { name: "Late Probe", script: "// late probe one\n" });
    await page.evaluate(`window.__open()`);
    await sleep(1500);
    if (!(await rows()).includes("Late Probe")) fail(`a trigger a tool created while the Trigger Editor loaded isn't in its tree: ${(await rows()).join(" | ")}`);
    const firstName = (await rows()).find((r) => r === "Melee Initialization") ?? null;
    if (!firstName) fail(`the new map has no Melee Initialization: ${(await rows()).join(" | ")}`);
    else {
      const r = await rename(firstName, "Melee Start");
      if (r) fail(r);
      await k.save();
      if (!/"Late Probe"/.test(wtgText()) || !/late probe one/.test(wct())) fail("the Trigger Editor's save deleted the trigger a tool created while it loaded");
    }

    // ---- 2. The texts saved by a tool while the editor is open and saved: it doesn't put back the old ones -------------
    await k.tool("create_script_trigger", { name: "Text Probe", script: "// text probe one\n" });
    await sleep(1500);
    await k.tool("set_trigger_script", { name: "Text Probe", script: "// text probe two\n" });
    await sleep(1500);
    const r2 = await rename("Melee Start", "Melee Begin");
    if (r2) fail(r2);
    await k.save();
    if (!/text probe two/.test(wct())) fail("the Trigger Editor's save put back the script a tool had changed while it was open");

    // ---- 3. Its file changed on disk, unheard of: the save asks; Cancel writes nothing, Overwrite saves ---------------
    const r3 = await rename("Melee Begin", "Melee Opening");
    if (r3) fail(r3);
    const onDisk = wtgText().replace('"Text Probe"', '"Changed On Disk"');
    if (onDisk === wtgText()) fail("no Text Probe in the file to change on disk");
    writeFileSync(join(k.root, "map", "war3map.wtg.json"), onDisk);
    await page.evaluate(`(() => { window.__asked = []; window.__answer = "Cancel"; w3Workbench.editors.confirm = async (m, ...a) => { window.__asked.push(m); return window.__answer; }; })()`);
    await page.evaluate(`w3.editors.saveAll()`);
    let asked = await page.evaluate(`window.__asked.splice(0)`);
    if (asked.length !== 1 || !/changed on disk/.test(asked[0])) fail(`saving over a file changed on disk asked ${JSON.stringify(asked)}`);
    if (wtgText() !== onDisk) fail("Cancel on the question still wrote over the file changed on disk");
    if (!(await page.evaluate(`w3.editors.isDirty(${JSON.stringify(WTG)})`))) fail("after Cancel the Trigger Editor isn't unsaved any more");
    await page.evaluate(`window.__answer = "Overwrite"`);
    await page.evaluate(`w3.editors.saveAll()`);
    asked = await page.evaluate(`window.__asked.splice(0)`);
    if (asked.length !== 1 || !/"Melee Opening"/.test(wtgText())) fail(`Overwrite didn't save (asked ${asked.length} times)`);
    // Control: a save with nothing changed on disk doesn't ask.
    const r4 = await rename("Melee Opening", "Melee Again");
    if (r4) fail(r4);
    await page.evaluate(`w3.editors.saveAll()`);
    asked = await page.evaluate(`window.__asked.splice(0)`);
    if (asked.length || !/"Melee Again"/.test(wtgText())) fail(`a save of a file nothing else changed asked ${JSON.stringify(asked)}`);
    await page.evaluate(`(() => { const ed = w3Workbench.editors, kept = window.__stale; ed.confirm = kept.confirm; delete ed.resolveTab; })()`);
    await page.evaluate(`w3.editors.closeAll()`);

    // ---- 4. A tab of the last session whose file isn't there yet, then the AI Editor's New writes it -------------------
    const dir = join(work, "stale-ai");
    mkdirSync(dir, { recursive: true });
    const wai = join(dir, "Stale Raider.wai").replace(/\\/g, "/");
    rmSync(wai, { force: true });
    await page.evaluate(`(() => { w3Workbench.editors.memory = { load: () => ({ tabs: [{ path: ${JSON.stringify(wai)}, editor: "w3.aiEditor" }], active: ${JSON.stringify(wai)} }), store: () => {} }; void w3Workbench.editors.restore(); })()`);
    const tabText = `(w3Workbench.editors.tabs.find((t) => t.path === ${JSON.stringify(wai)})?.el.innerText ?? "")`;
    await until("the missing AI file's tab", () => page.evaluate(`${tabText}.includes("Could not open")`), 20000).catch(() => fail("the tab of a missing AI file didn't say it couldn't open it (the check needs that)"));
    await page.evaluate(`(async () => { w3.window.pickSaveFile = async () => ${JSON.stringify(wai)}; await w3.commands.execute("w3.ai.new"); await new Promise((r) => setTimeout(r, 1500)); })()`);
    if (await page.evaluate(`${tabText}.includes("Could not open")`)) fail("after New AI wrote the file its tab still says it couldn't open it");
    const addErr = await k.run("w3.ai.addToMap");
    if (addErr) fail(`Add To Map after New AI: ${addErr}`);
  } finally {
    await page.evaluate(`(() => { const ed = w3Workbench.editors, kept = window.__stale; if (!kept) return;
      ed.memory = kept.memory; delete ed.resolveTab; ed.confirm = kept.confirm; w3.window.showWarning = kept.warn; w3.window.pickSaveFile = kept.save; window.__open?.(); })()`);
    await page.evaluate(`w3.editors.closeAll()`).catch(() => {});
  }
}

/** Parity extras through the app, on a new map and a new campaign: the Trigger Editor's Copy As Text and Copy As Script
 *  (a trigger from the tree's menu and a line from its own menu, onto the clipboard, the text as the editor shows its
 *  lines); Allow negative real values (an unreal field refuses -5 from a tool and typed until the setting is on); the
 *  Import Manager's Replace File (same path and entry, an open editor of the file shows the new content, one undo step);
 *  the Object Manager's Map Summary, Rename and Delete Object (a custom object, a trigger), Rename (a sound) and Play
 *  Sound, done by the owning editors; the Campaign Editor's Export, Replace and Remove of a chapter's map (the export is
 *  the CLI's pack, replace and remove are one undo step each) and Remove Button asking whether the map goes too. */
async function editorExtras(page, found) {
  const fail = (what) => found.push(`editor extras: ${what}`);
  const k = await heightKit(page, "Extras");
  const dir = join(work, "extras");
  mkdirSync(dir, { recursive: true });
  const run = (id, ...args) => page.evaluate(`w3.commands.execute(${JSON.stringify(id)}, ...${JSON.stringify(args)}).then((r) => ({ r }), (e) => ({ e: String(e) }))`);
  /** Right-clicks the first element of `selector` whose text has `text`, then the menu item starting with `item`. */
  const menu = async (selector, text, item) => {
    const ok = await page.evaluate(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}));
      if (!r) return false; r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 })); return true; })()`);
    if (!ok) return `nothing with "${text}" in ${selector}`;
    const shown = await until(`the menu item ${item}`, () => page.evaluate(`[...document.querySelectorAll(".context-menu-item")].some((e) => e.textContent.startsWith(${JSON.stringify(item)}))`), 5000).then(() => true, () => false);
    if (!shown) {
      const items = await page.evaluate(`[...document.querySelectorAll(".context-menu-item")].map((e) => e.textContent)`);
      await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      return `the menu of "${text}" has no ${item} (${items.join(" | ")})`;
    }
    await page.evaluate(`[...document.querySelectorAll(".context-menu-item")].find((e) => e.textContent.startsWith(${JSON.stringify(item)})).click()`);
    await sleep(500);
    return null;
  };
  const step = async (what, f) => { const why = await f(); if (why) fail(`${what}: ${why}`); };
  // The answers a user gives, and the clipboard and the speaker, recorded.
  await page.evaluate(`(() => {
    window.__extrasKept = { pick: w3.window.pickFile, save: w3.window.pickSaveFile, input: w3.window.inputBox, ask: w3.window.askDelete, warn: w3.window.showWarning, confirm: w3.window.confirm, play: HTMLMediaElement.prototype.play };
    window.__clip = []; window.__played = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__clip.push(t); } } });
    HTMLMediaElement.prototype.play = function () { window.__played.push(this.src); return Promise.resolve(); };
    w3.window.askDelete = async () => true;
    w3.window.confirm = async () => true;
  })()`);
  const answer = (name, value) => page.evaluate(`w3.window.${name} = async () => ${JSON.stringify(value)}`);
  const clip = () => page.evaluate(`window.__clip.splice(0)`);
  try {
    // ---- Trigger Editor: Copy As Text / Copy As Script ------------------------------------------------------------------
    await k.tool("create_script_trigger", { name: "Copy Me", script: "" });
    const wtg = k.read("war3map.wtg.json");
    const t = wtg.items.find((i) => i.name === "Copy Me");
    t.isCustom = false;
    // An event that registers in InitTrig_ (so the whole trigger's script has more than its action line's).
    t.ecas = [{ kind: 0, name: "TriggerRegisterTimerEventSingle", enabled: true, params: [{ type: 3, value: "2.00" }], children: [] }, { kind: 2, name: "DoNothing", enabled: true, params: [], children: [] }];
    await page.evaluate(`w3.workspace.writeText("map/war3map.wtg.json", ${JSON.stringify(JSON.stringify(wtg, null, 2))})`);
    await run("w3.triggers.reveal", "Copy Me");
    await until("the trigger's lines", () => page.evaluate(`document.querySelectorAll(".trig-eca").length === 2`), 20000).catch(() => fail("the trigger editor doesn't show Copy Me's two lines"));
    const lines = await page.evaluate(`[...document.querySelectorAll(".trig-eca > span")].map((s) => s.textContent)`);
    const wanted = `Copy Me\n    Events\n        ${lines[0]}\n    Conditions\n    Actions\n        ${lines[1]}\n`;
    await step("Copy As Text of the trigger", () => menu(".trig-row", "Copy Me", "Copy As Text"));
    const asText = await clip();
    if (asText.length !== 1 || asText[0] !== wanted) fail(`Copy As Text put ${JSON.stringify(asText)} on the clipboard, not ${JSON.stringify(wanted)}`);
    await step("Copy As Script of the trigger", () => menu(".trig-row", "Copy Me", "Copy As Script"));
    const [script] = await clip();
    if (!/function Trig_Copy_Me_Actions takes nothing returns nothing\n/.test(script ?? "") || !/function InitTrig_Copy_Me takes nothing returns nothing/.test(script ?? "")
      || !/TriggerRegisterTimerEventSingle\( gg_trg_Copy_Me, 2\.00 \)/.test(script ?? "") || /\r/.test(script ?? "")) fail(`Copy As Script put ${JSON.stringify((script ?? "").slice(0, 400))}`);
    // The action line alone, from its own menu.
    await step("Copy As Text of a line", () => menu(".trig-eca", lines[1], "Copy As Text"));
    const [line] = await clip();
    if (line !== `${lines[1]}\n`) fail(`Copy As Text of the action line gave ${JSON.stringify(line)}, not ${JSON.stringify(`${lines[1]}\n`)}`);
    await step("Copy As Script of a line", () => menu(".trig-eca", lines[1], "Copy As Script"));
    const [lineScript] = await clip();
    // The action alone: no event registered.
    if (!lineScript || !/call DoNothing\(/.test(lineScript) || /TriggerRegisterTimerEventSingle/.test(lineScript)) fail(`Copy As Script of the action line gave ${JSON.stringify((lineScript ?? "").slice(0, 300))}`);
    // The palette's command: the trigger, and what the menu gave.
    const cmd = await run("w3.triggers.copyAsText", { lines: false });
    if (cmd.r !== wanted) fail(`w3.triggers.copyAsText gave ${JSON.stringify(cmd)}`);
    await clip();
    if (await page.evaluate(`w3.editors.isDirty("map/war3map.wtg.json")`)) fail("copying made the trigger file unsaved");
    await page.evaluate(`w3.editors.closeAll()`);

    // ---- Object Editor: Allow negative real values -------------------------------------------------------------------
    const unit = JSON.parse(await k.tool("create_object", { kind: "units", base: "hfoo", name: "Smoke Om" })).id;
    const w3u = () => k.read("war3map.w3u.json").custom.find((o) => o.id === unit);
    const modOf = (field) => (w3u()?.mods ?? w3u()?.sets?.[0]?.mods ?? []).find((m) => m.field === field)?.value;
    const refused = await k.tool("set_object_fields", { kind: "units", id: unit, changes: [{ field: "ucol", value: -5 }] }).then(() => null, (e) => e.message);
    if (!/Allow negative real values/.test(refused ?? "")) fail(`set_object_fields with collision -5 gave ${JSON.stringify(refused)}`);
    await page.evaluate(`w3.settings.set("objectEditor.allowNegativeReals", true)`);
    await k.tool("set_object_fields", { kind: "units", id: unit, changes: [{ field: "ucol", value: -5 }] }).catch((e) => fail(`with the setting on, collision -5 was refused: ${e.message}`));
    if (modOf("ucol") !== -5) fail(`with the setting on, the unit's collision is ${JSON.stringify(modOf("ucol"))}`);
    // Typed in the Object Editor: refused without the setting, taken with it.
    await page.evaluate(`w3.settings.set("objectEditor.allowNegativeReals", undefined)`);
    await run("w3.objectEditor.open", "w3u", unit);
    await until("the unit's fields", () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell").length > 20`), 30000).catch(() => fail("the Object Editor shows no fields"));
    await page.evaluate(`(() => { const s = document.querySelector("input.obj-field-search"); s.value = "uhpr"; s.dispatchEvent(new Event("input")); })()`);
    await until("the field uhpr", () => page.evaluate(`document.querySelectorAll(".obj-table .obj-value-cell input").length === 1`), 5000).catch(() => fail("the field filter doesn't find uhpr alone"));
    const typeRegen = (v) => page.evaluate(`(() => { const i = document.querySelector(".obj-table .obj-value-cell input"); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("change")); return document.querySelector(".obj-table .obj-value-cell input")?.classList.contains("invalid") ?? null; })()`);
    if ((await typeRegen("-2")) !== true) fail("typing -2 into an unreal field wasn't refused without the setting");
    await k.save();
    if (modOf("uhpr") !== undefined) fail(`a refused -2 reached the file: ${modOf("uhpr")}`);
    await page.evaluate(`w3.settings.set("objectEditor.allowNegativeReals", true)`);
    if ((await typeRegen("-2")) !== false) fail("typing -2 into an unreal field was refused with the setting on");
    await k.save();
    if (modOf("uhpr") !== -2) fail(`with the setting on, typed regeneration is ${JSON.stringify(modOf("uhpr"))}`);
    await page.evaluate(`w3.settings.set("objectEditor.allowNegativeReals", undefined)`);
    await page.evaluate(`w3.editors.closeAll()`);

    // ---- Import Manager: Replace File --------------------------------------------------------------------------------
    const IMP = "war3mapImported\\smoke.txt", FILE = "map/war3mapImported/smoke.txt";
    const onDisk = join(k.root, "map", "war3mapImported", "smoke.txt"), impFile = join(k.root, "map", "war3map.imp.json");
    const replacement = join(dir, "replacement.txt");
    writeFileSync(replacement, "new words\n");
    await page.evaluate(`(async () => {
      await w3.workspace.writeText(${JSON.stringify(FILE)}, "old words\\n");
      await w3.workspace.writeText("map/war3map.imp.json", ${JSON.stringify(JSON.stringify({ format: "w3proj.imports/1", version: 1, files: [{ flags: 21, path: IMP }] }))});
      await w3.workspace.refresh();
    })()`);
    const impBefore = readFileSync(impFile, "utf8");
    await page.evaluate(`w3.editors.open(${JSON.stringify(FILE)})`);
    await until("the text editor", () => page.evaluate(`document.querySelector(".cm-content")?.textContent.includes("old words") ?? false`), 20000).catch(() => fail("the imported text doesn't open in the text editor"));
    await run("w3.imports.open");
    await until("the import list", () => page.evaluate(`!!document.querySelector("tr.imp-row")`), 20000);
    await page.evaluate(`[...document.querySelectorAll("tr.imp-row")].find((r) => r.textContent.includes("smoke.txt"))?.click()`);
    await answer("pickFile", replacement);
    const clicked = await page.evaluate(`(() => { const b = document.querySelector(".imp-replace"); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) fail("the Import Manager shows no Replace button for a selected file");
    await until("the new content", () => readFileSync(onDisk, "utf8") === "new words\n", 10000).catch(() => fail(`after Replace File the file holds ${JSON.stringify(readFileSync(onDisk, "utf8"))}`));
    if (readFileSync(impFile, "utf8") !== impBefore) fail("Replace File changed the import list");
    // The copy goes once the file holds the new content (replace.ts removes it last): given a moment, not checked in
    // the same instant the content showed.
    await until("the copy to go", () => !existsSync(`${onDisk}.replacing`), 5000).catch(() => fail("Replace File left its copy beside the file"));
    await page.evaluate(`w3.editors.open(${JSON.stringify(FILE)})`);
    await until("the text editor with the new content", () => page.evaluate(`document.querySelector(".cm-content")?.textContent.includes("new words") ?? false`), 10000)
      .catch(() => fail("the open text editor of the file doesn't show the replaced content"));
    // Closed before undo and redo: closing a tab while the workbench reopens it for a write elsewhere throws in fileSaved.
    await page.evaluate(`w3.editors.close(${JSON.stringify(FILE)})`);
    await run("w3.imports.open");
    await sleep(300);
    await page.evaluate(`w3.commands.execute("workbench.undo")`);
    await until("the old content", () => readFileSync(onDisk, "utf8") === "old words\n", 10000).catch(() => fail(`one undo of Replace File left ${JSON.stringify(readFileSync(onDisk, "utf8"))}`));
    await page.evaluate(`w3.commands.execute("workbench.redo")`);
    await until("the new content again", () => readFileSync(onDisk, "utf8") === "new words\n", 10000).catch(() => fail("redo of Replace File didn't bring the new content back"));
    await page.evaluate(`w3.editors.closeAll()`);

    // ---- Object Manager: Map Summary, Rename / Delete Object, Play Sound -------------------------------------------------
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x40, 0x1f, 0, 0, 1, 0, 8, 0]), Buffer.from("data"), Buffer.from([4, 0, 0, 0, 128, 130, 128, 126])]);
    writeFileSync(join(k.root, "map", "war3mapImported", "boom.wav"), wav);
    const sound = {
      name: "gg_snd_boom", file: "war3mapImported\\boom.wav", eaxEffect: "DefaultEAXON", flags: 16, fadeInRate: 10, fadeOutRate: 10, volume: 127, pitch: 1, pitchVariance: 0, priority: 8,
      channel: 0, minDistance: 0, maxDistance: 10000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0, coneOutsideVolume: 0, coneOrientation: [0, 0, 0],
      variableName: "gg_snd_boom", assetLabel: "", assetFile: "", dialogueTextKey: -1, dialogueText: "", speakerNameKey: -1, speakerName: "", unknown1: 0,
      speakerUnitType: "", facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "", unknown2: 1,
    };
    await page.evaluate(`(async () => { await w3.workspace.writeText("map/war3map.w3s.json", ${JSON.stringify(JSON.stringify({ format: "w3proj.sounds/1", version: 3, sounds: [sound] }))}); await w3.workspace.refresh(); })()`);
    await page.evaluate(`w3.views.show("objectManager")`);
    const summary = await run("w3.objectManager.summary");
    const rows = new Map(summary.r ?? []);
    const triggers = k.read("war3map.wtg.json").items.filter((i) => "ecas" in i && i.type !== 16 && !i.isComment).length;
    if (rows.get("Custom Units") !== "1" || rows.get("Triggers") !== String(triggers) || rows.get("Sounds") !== "1") fail(`the Map Summary says ${JSON.stringify(summary)}`);
    await page.evaluate(`document.querySelector(".om-summary-button")?.click()`);
    const shownRows = await page.evaluate(`document.querySelectorAll(".om-summary tr").length`);
    if (shownRows !== rows.size) fail(`the Map Summary button shows ${shownRows} rows, not ${rows.size}`);
    /** Filters the Object Manager to `text` and waits for a row having it. */
    const omFind = async (text) => {
      await page.evaluate(`(() => { const s = document.querySelector(".om-search"); s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event("input")); })()`);
      return until(`the Object Manager row ${text}`, () => page.evaluate(`[...document.querySelectorAll(".om-row")].some((r) => r.textContent.includes(${JSON.stringify(text)}))`), 10000).then(() => true, () => false);
    };
    const omRefresh = async () => { await run("w3.objectManager.refresh"); await sleep(300); };
    // A custom object: renamed by the Object Editor, one undo step there.
    await answer("inputBox", "Smoke Renamed");
    if (!(await omFind(`${unit} ←`))) fail(`the Object Manager has no row for ${unit}`);
    else {
      await step("Rename Object (custom unit)", () => menu(".om-row", `${unit} ←`, "Rename Object"));
      if (!(await page.evaluate(`w3.editors.isDirty("map/war3map.w3u.json")`))) fail("Rename Object left the Object Editor without the change");
      await k.save();
      if (modOf("unam") !== "Smoke Renamed") fail(`after Rename Object the unit's name is ${JSON.stringify(modOf("unam"))}`);
      await page.evaluate(`w3.commands.execute("workbench.undo")`);
      await k.save();
      if (modOf("unam") !== "Smoke Om") fail(`one undo of Rename Object left the name ${JSON.stringify(modOf("unam"))}`);
      await page.evaluate(`w3.views.show("objectManager")`);
      await omRefresh();
      await omFind(`${unit} ←`);
      await step("Delete Object (custom unit)", () => menu(".om-row", `${unit} ←`, "Delete Object"));
      await k.save();
      if (w3u()) fail("Delete Object left the custom unit in the object data");
    }
    // A trigger: renamed and deleted by the Trigger Editor.
    await page.evaluate(`w3.views.show("objectManager")`);
    await omRefresh();
    await answer("inputBox", "Copied Me");
    if (!(await omFind("Copy Me"))) fail("the Object Manager has no row for the trigger Copy Me");
    else {
      await step("Rename Object (trigger)", () => menu(".om-row", "Copy Me", "Rename Object"));
      await k.save();
      const names = () => k.read("war3map.wtg.json").items.map((i) => i.name);
      if (!names().includes("Copied Me") || names().includes("Copy Me")) fail(`after Rename Object the triggers are ${JSON.stringify(names())}`);
      await page.evaluate(`w3.views.show("objectManager")`);
      await omRefresh();
      await omFind("Copied Me");
      await step("Delete Object (trigger)", () => menu(".om-row", "Copied Me", "Delete Object"));
      await k.save();
      if (names().includes("Copied Me")) fail("Delete Object left the trigger");
    }
    // A sound: played without opening anything, renamed by the Sound Editor.
    await page.evaluate(`w3.editors.closeAll()`);
    await page.evaluate(`w3.views.show("objectManager")`);
    await omRefresh();
    if (!(await omFind("boom"))) fail("the Object Manager has no row for the sound");
    else {
      await step("Play Sound", () => menu(".om-row", "boom", "Play Sound"));
      await until("the sound to play", () => page.evaluate(`window.__played.length > 0`), 5000).catch(() => fail("Play Sound played nothing"));
      if (await page.evaluate(`w3.editors.activePath()`)) fail(`Play Sound opened ${await page.evaluate(`w3.editors.activePath()`)}`);
      await answer("inputBox", "smoke_boom");
      await step("Rename Object (sound)", () => menu(".om-row", "boom", "Rename Object"));
      await k.save();
      const s = k.read("war3map.w3s.json").sounds;
      if (s.length !== 1 || s[0].name !== "gg_snd_smoke_boom") fail(`after Rename Object the sounds are ${JSON.stringify(s.map((x) => x.name))}`);
    }
    await page.evaluate(`w3.editors.closeAll()`);

    // ---- Campaign Editor: export, replace and remove a chapter's map -------------------------------------------------------
    const one = join(dir, "One.w3x"), two = join(dir, "Two.w3x");
    cpSync(join(work, "by-cli.w3x"), one);
    await page.evaluate(`w3.backend.invoke("project_pack", { root: ${JSON.stringify(k.root)}, output: ${JSON.stringify(two)} })`);
    await until("the second map", () => existsSync(two), 20000);
    const camp = join(work, "campaign-maps");
    rmSync(camp, { recursive: true, force: true });
    await page.evaluate(`w3.backend.invoke("project_create", { dir: ${JSON.stringify(camp)}, name: "Smoke Maps", flags: 0, maxPlayers: 0, campaign: true })`);
    await page.evaluate(`(async () => { await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(camp)}); })()`);
    await until("the campaign", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(camp)}`), 20000);
    const campInfo = { format: "w3proj.campaign/1", version: 3, campaignVersion: 1, editorVersion: 6116, name: "Smoke Maps", difficulty: "Normal", author: "Me", description: "",
      flags: 1, background: 0, backgroundPath: "", minimapPath: "", ambientSound: 0, ambientSoundPath: "", fogStyle: 0, fogStartZ: 0, fogEndZ: 0, fogDensity: 0, fogColor: [0, 0, 0, 0], race: 0,
      unknown3: [0, 0, 0, 0, 0, 0, 1], chapters: [], mapOrder: [] };
    await page.evaluate(`(async () => {
      const root = w3.workspace.project().root, path = "map/war3campaign.w3f.json";
      await w3.workspace.writeText(path, await w3.backend.invoke("codec_canonicalize", { root, path, text: ${JSON.stringify(JSON.stringify(campInfo))} }));
      await w3.workspace.refresh();
    })()`);
    const w3f = () => JSON.parse(readFileSync(join(camp, "map", "war3campaign.w3f.json"), "utf8"));
    const chapterInfo = join(camp, "maps", "One.w3x", "map", "war3map.w3i.json");
    await answer("pickFile", one);
    const added = await run("w3.campaign.addMap");
    if (added.e) fail(`Add map: ${added.e}`);
    await until("the chapter project", () => existsSync(chapterInfo), 30000).catch(() => fail("Add map didn't unpack One.w3x under maps/"));
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(300);
    if (w3f().chapters.length !== 1) fail(`after Add map the campaign has ${w3f().chapters.length} buttons`);
    // Export: the chapter's project packed, as the CLI packs it.
    const exported = join(dir, "exported.w3x"), byCli = join(dir, "by-cli-chapter.w3x");
    await answer("pickSaveFile", exported);
    const ex = await run("w3.campaign.exportMap", "One.w3x");
    if (ex.e) fail(`Export map: ${ex.e}`);
    const packedByCli = spawnSync(cli, ["pack", join(camp, "maps", "One.w3x"), "-o", byCli], { encoding: "utf8" });
    if (packedByCli.status !== 0) fail(`the CLI can't pack the chapter: ${packedByCli.stderr}`);
    else if (!existsSync(exported) || hash(exported) !== hash(byCli)) fail("the exported chapter map isn't the CLI's pack of it");
    // Replace: the second map in its place; one undo puts the first back, redo the second.
    const infoBefore = readFileSync(chapterInfo, "utf8"), twoWidth = k.read("war3map.w3i.json").playableWidth;
    await answer("pickFile", two);
    const rep = await run("w3.campaign.replaceMap", "One.w3x");
    if (rep.e) fail(`Replace map: ${rep.e}`);
    const width = () => (existsSync(chapterInfo) ? JSON.parse(readFileSync(chapterInfo, "utf8")).playableWidth : null);
    if (width() !== twoWidth || readFileSync(chapterInfo, "utf8") === infoBefore) fail(`after Replace map the chapter's playable width is ${width()}, not the second map's ${twoWidth}`);
    if (readdirSync(join(camp, "maps")).join() !== "One.w3x") fail(`after Replace map maps/ holds ${readdirSync(join(camp, "maps")).join(", ")}`);
    await page.evaluate(`w3.commands.execute("workbench.undo")`);
    await until("the first map back", () => existsSync(chapterInfo) && readFileSync(chapterInfo, "utf8") === infoBefore, 10000).catch(() => fail("one undo of Replace map didn't put the first map back"));
    await page.evaluate(`w3.commands.execute("workbench.redo")`);
    await until("the second map again", () => width() === twoWidth, 10000).catch(() => fail("redo of Replace map didn't bring the second map back"));
    // Remove Button, answered "and map": both go in one step; undo brings both back.
    await page.evaluate(`w3.window.showWarning = async (m) => (/Remove the map from the campaign too/.test(m) ? "Remove button and map" : undefined)`);
    await page.evaluate(`document.querySelector("tr.camp-row")?.click()`);
    await sleep(200);
    await page.evaluate(`document.querySelector(".camp-remove-button")?.click()`);
    await until("the map to go", () => !existsSync(join(camp, "maps", "One.w3x")), 10000).catch(() => fail("Remove button, answered with the map, left maps/One.w3x"));
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(300);
    if (w3f().chapters.length || w3f().mapOrder.length) fail(`after Remove button and map the campaign has ${JSON.stringify([w3f().chapters, w3f().mapOrder])}`);
    await page.evaluate(`w3.commands.execute("workbench.undo")`);
    await until("the map back", () => existsSync(chapterInfo), 10000).catch(() => fail("one undo of Remove button and map didn't bring the map back"));
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(300);
    if (w3f().chapters.length !== 1 || w3f().mapOrder.length !== 1) fail(`after the undo the campaign has ${w3f().chapters.length} buttons and ${w3f().mapOrder.length} maps in order`);
    // Remove map while a button opens it: asked, the map goes, the button stays; undo brings it back.
    const rm = await run("w3.campaign.removeMap", "One.w3x");
    if (rm.e) fail(`Remove map: ${rm.e}`);
    if (existsSync(join(camp, "maps", "One.w3x"))) fail("Remove map left maps/One.w3x");
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(300);
    if (w3f().chapters.length !== 1 || w3f().mapOrder.length !== 0) fail(`after Remove map the campaign has ${w3f().chapters.length} buttons and ${w3f().mapOrder.length} maps in order`);
    await page.evaluate(`w3.commands.execute("workbench.undo")`);
    await until("the map back again", () => existsSync(chapterInfo), 10000).catch(() => fail("one undo of Remove map didn't bring the map back"));
    await page.evaluate(`w3.editors.saveAll()`);
    await sleep(300);
    // The campaign builds, with its chapter.
    const w3n = join(dir, "campaign-maps.w3n");
    const packed = spawnSync(cli, ["pack", camp, "-o", w3n], { encoding: "utf8" });
    if (packed.status !== 0) fail(`the campaign doesn't pack: ${packed.stderr}`);
    else if (!spawnSync(cli, ["ls", w3n], { encoding: "utf8" }).stdout.includes("One.w3x")) fail("the packed campaign has no One.w3x");
  } finally {
    await page.evaluate(`(() => { const k = window.__extrasKept; if (!k) return; w3.window.pickFile = k.pick; w3.window.pickSaveFile = k.save; w3.window.inputBox = k.input; w3.window.askDelete = k.ask;
      w3.window.showWarning = k.warn; w3.window.confirm = k.confirm; HTMLMediaElement.prototype.play = k.play; delete navigator.clipboard; })()`).catch(() => {});
    await page.evaluate(`w3.settings.set("objectEditor.allowNegativeReals", undefined)`).catch(() => {});
    await page.evaluate(`w3.editors.closeAll()`).catch(() => {});
  }
}

async function run() {
  // WebView2's helpers outlive the app by a moment.
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  mkdirSync(work, { recursive: true });
  if (!process.argv.includes("--no-build")) build();
  if (!existsSync(exe)) throw new Error(`no app at ${exe}: run without --no-build`);
  // The release CLI is built when it isn't there (unless W3PROJ_BIN names another).
  cli = ensureCli();

  const project = join(work, "project");
  cpSync(FIXTURE, project, { recursive: true });
  const wanted = join(work, "by-cli.w3x"), packed = join(work, "by-app.w3x");
  const pack = spawnSync(cli, ["pack", project, "-o", wanted], { encoding: "utf8" });
  if (pack.status !== 0) throw new Error(`the CLI can't pack the fixture: ${pack.stderr}`);
  if (process.argv.includes("--break")) writeFileSync(join(project, "map", "war3map.w3r.json"), "{ not json");
  const before = snapshot(project);

  const configDir = join(process.env.APPDATA ?? join(process.env.HOME ?? "", ".config"), IDENTIFIER);
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  // AI clients on this machine would connect to a server of this build. Automatic checkpoints come by the clock
  // (the first one at the first 20-second poll that finds a project without one): which project got one, and
  // whether a command's own checkpoint was skipped because one was being made, would depend on how fast the
  // machine is. The checks count the checkpoints that commands make.
  // The game's folder goes to the app as well as to the CLI: without it the app looks in its default
  // (C:\Program Files (x86)\Warcraft III), which on Linux, or on another drive, isn't there.
  // Without W3PROJ_GAME or .game-path, the folder the gate uses too (above the checkout, the Windows layout).
  // The game's programs follow game.installDir unless set: here they're set to files that aren't there, so no step
  // can start the game or the World Editor. No game-folder question at start: it would sit on top of the checks.
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({
    "mcp.enabled": false, "mcp.writeTools": true, "mcp.saveTool": true, "checkpoints.enabled": false,
    "game.path": join(work, "no-game", "Warcraft III.exe"), "worldEditor.path": join(work, "no-game", "World Editor.exe"),
    "game.installDir": game ?? gamePath(repo), "game.askForFolder": false,
  }));
  const triggerData = join(repo, "tests", "fixtures", "TriggerData.txt");
  // Windows: the app's WebView2 over the DevTools Protocol. Linux: WebKitGTK over WebDriver (webdriver.mjs),
  // which gives a page that takes the same calls.
  let stop = async () => {}, exited = () => null;

  try {
    let page;
    if (LINUX) {
      const launched = await launch(exe, { W3PROJ_TRIGGERDATA: triggerData });
      ({ page, stop, exited } = launched);
    } else {
      const port = await freePort();
      const child = spawn(exe, [], {
        stdio: "ignore",
        env: { ...process.env, W3PROJ_TRIGGERDATA: triggerData, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
      });
      let code = null;
      child.on("exit", (c) => { code = c; });
      exited = () => code;
      stop = async () => { child.kill(); };
      page = await connect(port);
    }
    await until("the app to start", () => page.evaluate(`!!window.w3 && document.querySelectorAll("button.activity").length > 0`));
    await sleep(500);
    const found = [];
    const path = JSON.stringify(project);
    // --only=<check> runs one of the checks below on its own, for working on it. Every check of the full run below is
    // named here too (`npm run check` holds the two lists against each other: scripts/check-scripts.mjs).
    // --only=graphics is graphicsModes after the project checks.
    const only = process.argv.find((x) => x.startsWith("--only="))?.slice(7);
    if (only && only !== "graphics") {
      const onlyChecks = { newMaps, terrainWiring, placeObjects, waterPathing, tileTemplate, tilesInPlace, tileCleanup, objectsWhileOpening,
        // Test Map needs a map it could start, as the full run has one open by then (a new map has a start location).
        testMapWithoutGame: async (p, f) => {
          const folder = join(work, "test-map-only");
          mkdirSync(folder, { recursive: true });
          await p.evaluate(`(() => { w3.window.confirm = async () => true; })()`);
          await mcpTool(p)("new_map", { name: "TestMapOnly", width: 64, height: 64, folder });
          await until("the terrain editor", () => p.evaluate(`w3.editors.activePath() === "map/war3map.w3e.txt"`), 20000);
          return testMapWithoutGame(p, f);
        },
        heightsPreserve, heightsUniform, heightsLimits, realMapSave, flyingHeights, wholeMapGround, cameraEditing, terrainSelectCameras, viewModes, unitProperties, itemTablesAccess, triggersAndAi, staleEditors, resizeUndo, shouldHaves, placerAndCampaign, editorExtras, byHand, moduleFunctions, objectCopy, graphicsModes, gameReadsOnce, editorTabRaces: (p, f) => editorTabRaces(p, f, project), playerStarts: (p, f) => playerStarts(p, f, project), drawCalls, contextLoss };
      if (!Object.hasOwn(onlyChecks, only)) throw new Error(`no check "${only}" for --only: ${Object.keys(onlyChecks).join(", ")}, graphics`);
      await onlyChecks[only](page, found).catch((e) => found.push(`${only}: ${e.message}`));
      found.push(...problems(page.events));
      return found;
    }

    // The real backend reads the project.
    await page.evaluate(`w3.workspace.open(${path})`);
    await until("the project", () => page.evaluate(`w3.workspace.project()?.root != null`));
    const info = await page.evaluate(`(() => { const p = w3.workspace.project(); return { name: p.name, root: p.root, files: w3.workspace.files().map((f) => f.path) }; })()`);
    const onDisk = [...before.keys()].filter((f) => f.startsWith("map/"));
    const listed = new Set(info.files);
    for (const f of onDisk) if (!listed.has(f)) found.push(`the app doesn't list ${f}`);

    // Every file in the editor the app picks for it.
    const opened = {};
    for (const file of onDisk) {
      const r = await page.evaluate(`(async () => {
        const path = ${JSON.stringify(file)};
        try {
          await w3.editors.open(path);
          await new Promise((r) => setTimeout(r, 200));
          const area = document.querySelector(".editor-area, .editors, main") ?? document.body;
          const text = area.innerText;
          return { active: w3.editors.activePath(), error: /Could not|couldn't open|Failed to|Error:/.test(text) ? text.slice(0, 200) : null, size: text.length, canvas: area.querySelectorAll("canvas").length, inputs: area.querySelectorAll("input, select, textarea, .cm-content").length, tab: document.querySelector(".tab.active")?.textContent ?? null };
        } catch (e) { return { failed: String(e) }; }
      })()`);
      opened[file] = r;
      if (r.failed) found.push(`${file}: ${r.failed}`);
      else if (r.error) found.push(`${file} shows an error: ${r.error}`);
      else if (r.active !== file) found.push(`${file} didn't open (active: ${r.active})`);
    }

    // Nothing was changed, so saving changes nothing.
    await page.evaluate(`w3.editors.saveAll()`);
    await page.evaluate(`w3.editors.closeAll()`);
    await sleep(300);
    const after = snapshot(project);
    for (const [f, h] of before) {
      if (after.get(f) === undefined) found.push(`${f} is gone`);
      else if (after.get(f) !== h) found.push(`${f} changed without an edit`);
    }

    // What the app packs is what the command line packs.
    await page.evaluate(`w3.backend.invoke("project_pack", { root: ${path}, output: ${JSON.stringify(packed)} })`);
    await until("the pack", () => existsSync(packed));
    if (hash(packed) !== hash(wanted)) found.push("the app's map differs from the CLI's");

    // A change goes through the app into the map.
    const regions = "map/war3map.w3r.json";
    await page.evaluate(`(async () => {
      const text = await w3.workspace.readText(${JSON.stringify(regions)});
      await w3.workspace.writeText(${JSON.stringify(regions)}, text.replace("Middle", "Edited"));
    })()`);
    const edited = join(work, "edited.w3x");
    await page.evaluate(`w3.backend.invoke("project_pack", { root: ${path}, output: ${JSON.stringify(edited)} })`);
    const inMap = spawnSync(cli, ["cat", edited, "war3map.w3r"]);
    if (inMap.status !== 0 || !inMap.stdout.includes("Edited")) found.push("the edit didn't reach the map");

    // The app unpacks a map into what it came from.
    const unpacked = join(work, "unpacked");
    await page.evaluate(`w3.backend.invoke("project_unpack", { map: ${JSON.stringify(wanted)}, dir: ${JSON.stringify(unpacked)}, allowIncomplete: false, install: "none" })`);
    const again = snapshot(join(unpacked, "map"));
    for (const [f, h] of snapshot(join(FIXTURE, "map"))) if (again.get(f) !== h) found.push(`unpacking changed ${f}`);

    const unsaved = await page.evaluate(`w3.editors.unsavedPaths()`);
    if (unsaved.length) found.push(`unsaved after saving: ${unsaved.join(", ")}`);

    if (process.argv.includes("--only=graphics")) {
      await graphicsModes(page, found).catch((e) => found.push(`graphics modes: ${e.message}`));
      found.push(...problems(page.events));
      page.ws.close();
      return found;
    }
    const made = await newMaps(page, found);
    await terrainWiring(page, found).catch((e) => found.push(`terrain wiring: ${e.message}`));
    await placeObjects(page, found).catch((e) => found.push(`place objects: ${e.message}`));
    await waterPathing(page, found).catch((e) => found.push(`water pathing: ${e.message}`));
    await tileTemplate(page, found).catch((e) => found.push(`tile template: ${e.message}`));
    await tilesInPlace(page, found).catch((e) => found.push(`terrain in place: ${e.message}`));
    await tileCleanup(page, found).catch((e) => found.push(`tile cleanup: ${e.message}`));
    await objectsWhileOpening(page, found).catch((e) => found.push(`objects while opening: ${e.message}`));
    await testMapWithoutGame(page, found).catch((e) => found.push(`test map: ${e.message}`));
    for (const check of [heightsPreserve, heightsUniform, heightsLimits]) await check(page, found).catch((e) => found.push(`height tools (${check.name}): ${e.message}`));
    await flyingHeights(page, found).catch((e) => found.push(`flying heights: ${e.message}`));
    await wholeMapGround(page, found).catch((e) => found.push(`whole-map ground: ${e.message}`));
    await cameraEditing(page, found).catch((e) => found.push(`camera editing: ${e.message}`));
    await terrainSelectCameras(page, found).catch((e) => found.push(`terrain select and cameras: ${e.message}`));
    await viewModes(page, found).catch((e) => found.push(`view modes: ${e.message}`));
    await unitProperties(page, found).catch((e) => found.push(`unit properties: ${e.message}`));
    await itemTablesAccess(page, found).catch((e) => found.push(`item tables: ${e.message}`));
    await triggersAndAi(page, found).catch((e) => found.push(`triggers and AI: ${e.message}`));
    await staleEditors(page, found).catch((e) => found.push(`stale editors: ${e.message}`));
    await resizeUndo(page, found).catch((e) => found.push(`resize undo: ${e.message}`));
    await shouldHaves(page, found).catch((e) => found.push(`should-haves: ${e.message}`));
    await placerAndCampaign(page, found).catch((e) => found.push(`placer and campaign: ${e.message}`));
    await editorExtras(page, found).catch((e) => found.push(`editor extras: ${e.message}`));
    await byHand(page, found).catch((e) => found.push(`by hand: ${e.message}`));
    await moduleFunctions(page, found).catch((e) => found.push(`module functions: ${e.message}`));
    await objectCopy(page, found).catch((e) => found.push(`object copy: ${e.message}`));
    await graphicsModes(page, found).catch((e) => found.push(`graphics modes: ${e.message}`));
    await gameReadsOnce(page, found).catch((e) => found.push(`game reads: ${e.message}`));
    await editorTabRaces(page, found, project).catch((e) => found.push(`editor tabs: ${e.message}`));
    await playerStarts(page, found, project).catch((e) => found.push(`player starts: ${e.message}`));
    await realMapSave(page, found).catch((e) => found.push(`real map save: ${e.message}`));
    await drawCalls(page, found).catch((e) => found.push(`draw calls: ${e.message}`));
    await contextLoss(page, found).catch((e) => found.push(`context loss: ${e.message}`));
    found.push(...problems(page.events));
    if (exited() !== null) found.push(`the app exited with ${exited()}`);

    const shot = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) writeFileSync(join(work, "screen.png"), Buffer.from(shot.data, "base64"));
    page.ws.close();
    console.log(`${info.files.length} files in "${info.name}", ${onDisk.length} opened, ${made} new maps`);
    if (process.argv.includes("--verbose")) for (const [file, r] of Object.entries(opened)) console.log(`  ${file}: ${JSON.stringify(r)}`);
    return found;
  } finally {
    await stop();
    await sleep(300);
    rmSync(configDir, { recursive: true, force: true });
  }
}

try {
  const found = await run();
  for (const p of found) console.error(`FAIL ${p}`);
  console.log(found.length ? `${found.length} problems` : "app smoke ok");
  process.exit(found.length ? 1 : 0);
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exit(1);
}
