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

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "..");
// W3_SMOKE_DIR: another folder, when this one has a project someone opened to try out.
const work = process.env.W3_SMOKE_DIR ?? join(repo, "target", "app-smoke");
const exeName = process.platform === "win32" ? ".exe" : "";
const exe = join(repo, "target", "debug", `w3proj-studio${exeName}`);
const cli = process.env.W3PROJ_BIN ?? join(repo, "target", "release", `w3proj${exeName}`);
const IDENTIFIER = "dev.w3proj.studio.smoke";
const FIXTURE = join(repo, "tests", "fixtures", "mini-map");

function build() {
  const conf = JSON.parse(readFileSync(join(app, "src-tauri", "tauri.conf.json"), "utf8"));
  const windows = conf.app.windows.map((w) => ({ ...w, visible: false }));
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

const game = process.env.W3PROJ_GAME;
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

/** The terrain viewer's View commands, through the command palette's own entry point: what each shows is
 *  judged on the window's picture (which has to change when a layer goes on, and come back when it goes off),
 *  and where the camera goes on the editor's own state. The pictures stay in `shots` to look at. */
async function viewCommands(page, fail, shots) {
  const bad = (what) => fail(`view commands: ${what}`);
  mkdirSync(shots, { recursive: true });
  const run = (id) => page.evaluate(`w3.commands.execute(${JSON.stringify(id)}).then(() => null, (e) => String(e))`);
  const state = () => page.evaluate(`(async () => (await w3.services.get("w3.terrain")).viewCommands.get(w3.editors.activePath())?.state() ?? null)()`);
  /** The map's part of the window, as PNG data. */
  const picture = async (name) => {
    await sleep(700);
    const r = await page.evaluate(`(() => { const b = document.querySelector(".model-stage canvas").getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height, scale: 1 }; })()`);
    const shot = await page.send("Page.captureScreenshot", { format: "png", clip: r });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(shot.data, "base64"));
    return shot.data;
  };
  /** How many pixels two pictures differ in, by more than rounding: counted in the page, which can decode PNGs. */
  const differ = (a, b) => page.evaluate(`(async () => {
    const load = (data) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = "data:image/png;base64," + data; });
    const pixels = async (data) => { const i = await load(data), c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    const [p, q] = await Promise.all([pixels(${JSON.stringify(a)}), pixels(${JSON.stringify(b)})]);
    let n = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 24) n++;
    return n;
  })()`);
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

  // ---- Export Minimap -----------------------------------------------------------------------
  const b = join(dir, "minimap");
  cpSync(FIXTURE, b, { recursive: true });
  {
    await openProject(b);
    try { await tool("rebuild_map"); } catch (e) { fail(`rebuild_map: ${e.message}`); }
    await until("the minimap", () => existsSync(join(b, "map", "war3mapMap.blp")), 20000).catch(() => fail("no war3mapMap.blp to export"));
    const out = join(dir, "minimap-out.png");
    await answer({ save: out });
    const err = await run("w3.terrain.exportMinimap");
    if (err) fail(`Export Minimap: ${err}`);
    else if (!existsSync(out)) fail("Export Minimap wrote no file");
    else {
      const png = readFileSync(out);
      if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail("the minimap file isn't a PNG");
      else if (png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) fail(`the minimap is ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
      else {
        // The pixels are the minimap's: not one flat colour.
        const raw = inflateSync(png.subarray(41, png.length - 12));
        const colours = new Set();
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x += 4) colours.add(raw.readUIntBE(y * 1025 + 1 + x * 4, 3));
        if (colours.size < 4) fail(`the exported minimap has ${colours.size} colours`);
      }
    }
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

async function run() {
  // WebView2's helpers outlive the app by a moment.
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  mkdirSync(work, { recursive: true });
  if (!process.argv.includes("--no-build")) build();
  if (!existsSync(exe)) throw new Error(`no app at ${exe}: run without --no-build`);
  if (!existsSync(cli)) throw new Error(`no w3proj at ${cli}`);

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
  // AI clients on this machine would connect to a server of this build.
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ "mcp.enabled": false, "mcp.writeTools": true, "mcp.saveTool": true }));
  const port = await freePort();
  const child = spawn(exe, [], {
    stdio: "ignore",
    env: { ...process.env, W3PROJ_TRIGGERDATA: join(repo, "tests", "fixtures", "TriggerData.txt"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  });
  let exited = null;
  child.on("exit", (code) => { exited = code; });

  try {
    const page = await connect(port);
    await until("the app to start", () => page.evaluate(`!!window.w3 && document.querySelectorAll("button.activity").length > 0`));
    await sleep(500);
    const found = [];
    const path = JSON.stringify(project);

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

    const made = await newMaps(page, found);
    await terrainWiring(page, found).catch((e) => found.push(`terrain wiring: ${e.message}`));
    await testMapWithoutGame(page, found).catch((e) => found.push(`test map: ${e.message}`));
    await byHand(page, found).catch((e) => found.push(`by hand: ${e.message}`));
    await moduleFunctions(page, found).catch((e) => found.push(`module functions: ${e.message}`));
    found.push(...problems(page.events));
    if (exited !== null) found.push(`the app exited with ${exited}`);

    const shot = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) writeFileSync(join(work, "screen.png"), Buffer.from(shot.data, "base64"));
    page.ws.close();
    console.log(`${info.files.length} files in "${info.name}", ${onDisk.length} opened, ${made} new maps`);
    if (process.argv.includes("--verbose")) for (const [file, r] of Object.entries(opened)) console.log(`  ${file}: ${JSON.stringify(r)}`);
    return found;
  } finally {
    child.kill();
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
