// A project whose terrain is split into subterrains (map/terrain/) opens, edits and saves as the flat one does: the
// app's own code (what the terrain editor loads: projectWalkSource, the placement files, the regions; what it saves:
// writeTerrainBytes, savePlacedFile) over the real backend (`w3proj serve-backend`, headless/rustbackend.ts),
// on copies of the mini map: flat, split 2×2 and split into one `main` by this extension's command.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ExtensionManifest, W3Api } from "../extensions/api";
import { headless } from "./host";
import { rustBackend } from "./rustbackend";
import { fixturePath, repoPath } from "../lib/testhelpers/testutil";
import { parseW3e, setGroundHeight, writeW3e } from "../lib/terrain/w3e";
import { readTerrainBytes, terrainPath, w3eToText, writeTerrainBytes } from "../lib/terrain/w3etext";
import { CLOSED, DERIVED_CLOSED_KEY, partialMask } from "../lib/terrain/openset";
import { readMapDocStrict } from "../lib/formats/mapdoc";
import { projectWalkSource } from "../builtin/terrain-viewer/meleefacts";
import { loadPlacedFile, newEntry, savePlacedFile } from "../builtin/terrain-viewer/placement";
import { loadIdLayout } from "../lib/terrain/creationids";
import { nextRegionIndex } from "../lib/terrain/regions";
import { unlistedFiles } from "../lib/imports";
import type { WorkspaceService } from "../workbench/workspace";
import manifest from "../builtin/terrain-layout/extension.json";
import { checkTerrainIds, FLAT_FILES, isSplit, mergeTerrain, openSubterrains, splitTerrain } from "../builtin/terrain-layout/index";
import { readPathingFile } from "../builtin/terrain-pathing/file";
import { pathingOverridesText, type PathingOverrides } from "../lib/terrain/resize";

const cache = join(repoPath("app", "node_modules"), ".cache", "w3-layout-test");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "run-"));
const backend = rustBackend();
test.after(async () => { await backend.stop(); rmSync(work, { recursive: true, force: true }); });

/** A copy of the mini map, served by its own backend. */
function project(name: string): string {
  const root = join(work, name);
  cpSync(fixturePath("mini-map"), root, { recursive: true });
  backend.serve(root);
  return root;
}

/** The app without a window on the project (src/headless/host.ts), its checkpoints a command that does nothing. */
async function open(root: string): Promise<W3Api> {
  const h = headless([manifest as ExtensionManifest], {});
  h.w3.commands.register("w3.checkpoints.create", async () => true);
  await h.workspace.open(root);
  workspaces.set(h.w3, h.workspace);
  return h.w3;
}
const workspaces = new Map<W3Api, WorkspaceService>();

/** Every file of the project's map/ folder: path → bytes. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(root, p).split(sep).join("/"), readFileSync(p).toString("latin1"));
    }
  };
  walk(join(root, "map"));
  return out;
}
const changedFiles = (a: Map<string, string>, b: Map<string, string>) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();

/** What the terrain editor works from: the ground, the placed objects, the regions. */
async function loaded(w3: W3Api) {
  const src = await projectWalkSource(w3, { read: async () => { throw new Error("no game here"); }, baseOf: () => undefined, groups: [] });
  const regions = await readMapDocStrict<{ regions: unknown[] }>(w3, "map/war3map.w3r.json");
  return { terrain: src.terrain, placed: src.list(), regions };
}

const flatRoot = project("flat"), gridRoot = project("grid"), mainRoot = project("main");
const flat = await open(flatRoot), grid = await open(gridRoot), main = await open(mainRoot);

test("the split command cuts the project into subterrains; a split it can't keep is refused with the reason", async () => {
  const before = snapshot(gridRoot);
  // The west half only: the south-east corner (water bits set) would lie outside and isn't the default corner.
  await assert.rejects(splitTerrain(grid, { layout: ["west:0,0,2,3"], quiet: true }), /Split Terrain: .*would be lost.* Nothing was changed\./);
  assert.deepEqual(changedFiles(before, snapshot(gridRoot)), [], "a refused split writes nothing");
  await splitTerrain(grid, { layout: "2x2", quiet: true });
  await splitTerrain(main, { layout: "main", quiet: true });
  assert.ok(isSplit(grid) && isSplit(main) && !isSplit(flat), "the file list has map/terrain/terrain.json");
  for (const [root, folders] of [[gridRoot, ["ne", "nw", "se", "sw"]], [mainRoot, ["main"]]] as const) {
    const files = [...snapshot(root).keys()];
    for (const f of folders) for (const n of ["terrain.txt", "doodads.json", "units.json", "regions.json"]) assert.ok(files.includes(`map/terrain/${f}/${n}`), `${f}/${n}`);
    for (const f of FLAT_FILES) assert.ok(!files.includes(f), `${f} isn't on disk any more`);
  }
  await assert.rejects(splitTerrain(grid, { layout: "main", quiet: true }), /split already/);
});

test("split 2×2 and into main, the terrain editor loads what it loads from the flat project", async () => {
  const want = await loaded(flat);
  for (const w3 of [grid, main]) {
    // The flat names are listed (the explorer, terrainPath, the watches find them), the layout's files too.
    const paths = w3.workspace.files().map((f) => f.path);
    for (const f of FLAT_FILES) assert.ok(paths.includes(f), `${f} listed`);
    assert.equal(terrainPath(paths), "map/war3map.w3e.txt");
    assert.deepEqual(await loaded(w3), want);
    // map/terrain/ isn't a folder of imports (Clean Up Imports would delete them).
    assert.deepEqual(unlistedFiles(paths, [], "war3mapImported").filter((p) => p.startsWith("map/terrain/")), []);
  }
  // Control: a flat project's map/terrain/ file is an import like any other.
  assert.deepEqual(unlistedFiles(["map/terrain/a.blp"], [], "war3mapImported"), ["map/terrain/a.blp"]);
});

/** The north-east corner's ground variation changed, saved as the terrain editor saves it. */
async function editTerrain(w3: W3Api) {
  const path = terrainPath(w3.workspace.files().map((f) => f.path))!;
  const io = { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path), writeText: (t: string) => w3.workspace.writeText(path, t), writeBytes: (b: Uint8Array) => w3.workspace.writeBytes(path, b) };
  const t = parseW3e(await readTerrainBytes(path, io));
  const ne = t.corners[t.width * t.height - 1];
  ne.variation = (ne.variation + 5) % 16;
  await writeTerrainBytes(path, writeW3e(t), io);
}

/** The first unit moved east of the 2×2 grid's seam (corner 2: world x 128), saved as the terrain editor saves it. */
async function moveUnit(w3: W3Api) {
  const f = (await loadPlacedFile(w3, "war3mapUnits.doo", "units"))!;
  f.list[0].position = [200, f.list[0].position[1], f.list[0].position[2]];
  await savePlacedFile(w3, f);
}

test("a save of an edit writes only the owning subterrain's files, and loads back as the flat project's", async () => {
  for (const [w3, root, terrainFiles, unitFiles] of [
    [flat, flatRoot, ["map/war3map.w3e.txt"], ["map/war3mapUnits.doo.json"]],
    [grid, gridRoot, ["map/terrain/ne/terrain.txt"], ["map/terrain/se/units.json", "map/terrain/sw/units.json"]],
    [main, mainRoot, ["map/terrain/main/terrain.txt"], ["map/terrain/main/units.json"]],
  ] as const) {
    let before = snapshot(root);
    await editTerrain(w3);
    assert.deepEqual(changedFiles(before, snapshot(root)), terrainFiles, root);
    before = snapshot(root);
    await moveUnit(w3);
    assert.deepEqual(changedFiles(before, snapshot(root)), unitFiles, root);
    // The writes were the app's own: nothing counts as changed by another program (the subterrain files neither).
    assert.deepEqual([...await workspaceOf(w3).externalChanges()], [], root);
  }
  const want = await loaded(flat);
  assert.deepEqual(await loaded(grid), want);
  assert.deepEqual(await loaded(main), want);
});

test("an edit of a subterrain file by another program shows as a change of the flat file", async () => {
  const ws = workspaceOf(grid);
  const file = join(gridRoot, "map", "terrain", "sw", "terrain.txt");
  // Another program writes the file (a git checkout: same bytes, a later time).
  writeFileSync(file, readFileSync(file));
  const later = new Date(statSync(file).mtimeMs + 5000);
  utimesSync(file, later, later);
  const changed = await ws.externalChanges();
  assert.ok(changed.has("map/war3map.w3e.txt"), [...changed].join(", "));
  assert.ok(changed.has("map/terrain/sw/terrain.txt"));
  assert.ok(!changed.has("map/war3mapUnits.doo.json"), "control: the units aren't made from it");
});

test("merge puts the flat files back, and the project reads as before", async () => {
  const want = await loaded(flat);
  await mergeTerrain(grid, { quiet: true });
  assert.ok(!isSplit(grid));
  const files = [...snapshot(gridRoot).keys()];
  assert.ok(!files.some((f) => f.startsWith("map/terrain/")), files.join(", "));
  for (const f of FLAT_FILES) assert.ok(files.includes(f), f);
  assert.deepEqual(await loaded(grid), want);
  // The same edits on both: the same files, byte for byte.
  const a = snapshot(flatRoot), b = snapshot(gridRoot);
  assert.deepEqual(changedFiles(a, b), []);
  await assert.rejects(mergeTerrain(grid, { quiet: true }), /isn't split/);
});

// ---- creation numbers (lib/terrain/creationids.ts over the real backend: terrain_id_layout, write_flat, terrain_check) ----

/** A new split 2×2 copy of the mini map (5×3 corners at -128, -64: sw x < 128, y < 64; ne x >= 128, y >= 64; ranges sw
 *  10000, se 20000, nw 30000, ne 40000), opened. */
async function splitProject(name: string): Promise<{ w3: W3Api; root: string }> {
  const root = project(name);
  const w3 = await open(root);
  await splitTerrain(w3, { layout: "2x2", quiet: true });
  return { w3, root };
}
const SW = [-50, -30, 0] as [number, number, number], NE = [300, 200, 0] as [number, number, number];
const idOf = (e: unknown) => (e as { editorId: number }).editorId;
const subUnits = (root: string, sub: string) => (JSON.parse(readFileSync(join(root, "map", "terrain", sub, "units.json"), "utf8")).units as { editorId: number }[]).map((u) => u.editorId);

/** Places a unit as the terrain editor does (newEntry into the loaded file) and saves the file. */
async function placeUnits(w3: W3Api, at: [number, number, number][]): Promise<number[]> {
  const f = (await loadPlacedFile(w3, "war3mapUnits.doo", "units"))!;
  const made = at.map((p) => newEntry(f, "hfoo", p, 0, "w3u"));
  f.list.push(...made);
  await savePlacedFile(w3, f);
  return made.map(idOf);
}

test("a new object in a split project is numbered from its subterrain's range and saved there; a flat project's as before", async () => {
  const { w3, root } = await splitProject("ids");
  assert.deepEqual(await placeUnits(w3, [SW, NE, SW]), [10000, 40000, 10001]);
  assert.deepEqual(subUnits(root, "sw"), [2, 10000, 10001], "the footman (2) and the new ones in sw");
  assert.deepEqual(subUnits(root, "ne"), [40000]);
  // Doodads are their own namespace; a region is numbered by its minimum corner's subterrain.
  const doo = (await loadPlacedFile(w3, "war3map.doo", "doodads"))!;
  assert.equal(idOf(newEntry(doo, "LTlt", [NE[0], NE[1], 0])), 40000);
  const layout = await loadIdLayout(w3);
  assert.ok(layout && doo.idLayout === layout, "one layout object for every allocation of the project");
  const regions = await readMapDocStrict<{ regions: { index: number }[] }>(w3, "map/war3map.w3r.json");
  assert.equal(nextRegionIndex(regions!.regions, layout, [-100, 100]), 30000, "nw holds (-100, 100)");
  // Moved over the seam, the number stays and the object changes file; Check Terrain IDs reports it as information.
  const f = (await loadPlacedFile(w3, "war3mapUnits.doo", "units"))!;
  const moved = f.list.find((u) => idOf(u) === 40000)!;
  moved.position = [-60, -40, 0];
  await savePlacedFile(w3, f);
  assert.deepEqual([subUnits(root, "sw"), subUnits(root, "ne")], [[2, 10000, 10001, 40000], []]);
  const report = await checkTerrainIds(w3, { quiet: true });
  assert.equal(report.errors, false, report.lines.join("\n"));
  assert.deepEqual(report.outside.filter((o) => o.kind === "units"), [{ subterrain: "sw", kind: "units", count: 2, examples: [2, 40000] }]);
  // The control: the flat project numbers one past the highest (the footman's 2).
  assert.deepEqual(await placeUnits(flat, [SW]), [3]);
  assert.equal((await loadPlacedFile(flat, "war3mapUnits.doo", "units"))!.idLayout, null);
  await assert.rejects(checkTerrainIds(flat, { quiet: true }), /isn't split/);
});

test("a full range: the next block above every range, recorded in terrain.json by the save", async () => {
  const { w3, root } = await splitProject("full");
  const path = join(root, "map", "terrain", "terrain.json");
  writeFileSync(path, readFileSync(path, "utf8").replace("\"idRange\": [10000, 19999]", "\"idRange\": [10000, 10001]"));
  await w3.workspace.refresh();
  assert.deepEqual(await placeUnits(w3, [SW, SW, SW]), [10000, 10001, 50000]);
  const sw = (JSON.parse(readFileSync(path, "utf8")) as { subterrains: { name: string; idRange: unknown }[] }).subterrains.find((s) => s.name === "sw");
  assert.deepEqual(sw?.idRange, [[10000, 10001], [50000, 59999]]);
  // Read again, the layout has it: the next unit in sw goes on in it; one in ne stays in ne's own range.
  await w3.workspace.refresh();
  assert.deepEqual((await loadIdLayout(w3))!.subterrains[0].idRanges, [[10000, 10001], [50000, 59999]]);
  assert.deepEqual(await placeUnits(w3, [SW, NE]), [50001, 40000]);
  assert.equal((await checkTerrainIds(w3, { quiet: true })).errors, false);
});

test("two branches placing in different subterrains merge without a duplicate number; in the same one they collide (the control)", async () => {
  const a = await splitProject("branch-a"), b = await splitProject("branch-b");
  assert.deepEqual(await placeUnits(a.w3, [SW]), [10000]);
  assert.deepEqual(await placeUnits(b.w3, [NE]), [40000]);
  // The merge: b changed ne/units.json only, a sw/units.json only, so git takes both files as they are.
  assert.deepEqual(changedFiles(snapshot(a.root), snapshot(b.root)), ["map/terrain/ne/units.json", "map/terrain/sw/units.json"], "terrain.json and the rest alike");
  cpSync(join(b.root, "map", "terrain", "ne", "units.json"), join(a.root, "map", "terrain", "ne", "units.json"));
  await a.w3.workspace.refresh();
  const merged = (await loadPlacedFile(a.w3, "war3mapUnits.doo", "units"))!;
  assert.deepEqual(merged.list.map(idOf).sort(), [10000, 2, 40000].sort());
  assert.equal((await checkTerrainIds(a.w3, { quiet: true })).errors, false);
  // The control: b places in sw too and gets a's number; a merge of both entries is a duplicate, refused on load and listed.
  assert.deepEqual(await placeUnits(b.w3, [SW]), [10000]);
  const swA = JSON.parse(readFileSync(join(a.root, "map", "terrain", "sw", "units.json"), "utf8"));
  const swB = JSON.parse(readFileSync(join(b.root, "map", "terrain", "sw", "units.json"), "utf8"));
  swA.units.push(swB.units.find((u: { editorId: number }) => u.editorId === 10000));
  writeFileSync(join(a.root, "map", "terrain", "sw", "units.json"), JSON.stringify(swA, null, 2) + "\n");
  await a.w3.workspace.refresh();
  await assert.rejects(loadPlacedFile(a.w3, "war3mapUnits.doo", "units"), /creation number 10000 twice/);
  const report = await checkTerrainIds(a.w3, { quiet: true });
  assert.equal(report.errors, true);
  assert.deepEqual(report.duplicates, [{ kind: "units", number: 10000, files: ["map/terrain/sw/units.json", "map/terrain/sw/units.json"] }]);
});

// ---- stage 3: derived files in .w3proj/derived/, the Pathing tool's file in the subterrains' pathing.txt ----

test("the Pathing tool's file reads and writes through the subterrains' pathing.txt; a damaged one is unreadable, never empty", async () => {
  const { w3, root } = await splitProject("pathing");
  const FILE = ".w3proj/pathing.json";
  // The mini map's pathing map: 16×8 cells; the 2×2 grid's seams at cell x 8 and y 4.
  const exists = () => w3.backend.invoke<boolean>("fs_exists", { path: w3.workspace.resolve(FILE) });
  const read = () => readPathingFile(exists, () => w3.workspace.readText(FILE), 16, 8);
  assert.deepEqual(await read(), { state: "absent" }, "no subterrain has overrides yet");
  const file: PathingOverrides = { format: "w3proj.pathing/1", width: 16, height: 8, cells: [[7, 1, 2, 8], [8, 1, 2, 8], [3, 5, 0, 8]] };
  await w3.workspace.writeText(FILE, pathingOverridesText(file));
  const txt = (sub: string) => join(root, "map", "terrain", sub, "pathing.txt");
  assert.deepEqual(["sw", "se", "nw"].map((s) => readFileSync(txt(s), "utf8")), ["7 1 0a 02\n", "0 1 0a 02\n", "3 1 08 00\n"]);
  assert.throws(() => statSync(join(root, ".w3proj", "pathing.json")), "nothing written to .w3proj/pathing.json itself");
  assert.deepEqual(await read(), { state: "ok", file: JSON.parse(pathingOverridesText(file)) });
  assert.equal(await w3.workspace.readText(FILE), pathingOverridesText(file), "byte for byte");
  assert.ok(w3.workspace.files().some((f) => f.path === FILE), "listed");
  // A stroke in the north-west only: only nw's file changes, and the write was the app's own.
  const before = snapshot(root);
  file.cells[2] = [3, 5, 2, 0];
  await w3.workspace.writeText(FILE, pathingOverridesText(file));
  assert.deepEqual(changedFiles(before, snapshot(root)), ["map/terrain/nw/pathing.txt"]);
  assert.deepEqual([...await workspaceOf(w3).externalChanges()], []);
  // Damaged (a merge conflict left in it): there, unreadable, so painting stays off rather than writing over it.
  writeFileSync(txt("nw"), "3 1 02 02\n<<<<<<< HEAD\n");
  const damaged = await read();
  assert.equal(damaged.state, "unreadable");
  assert.match((damaged as { why: string }).why, /map\/terrain\/nw\/pathing\.txt line 2/);
});

test("a split project's derived files are read and written under their map/ names, kept in .w3proj/derived/", async () => {
  const { w3, root } = await splitProject("derived");
  const stored = join(root, ".w3proj", "derived", "war3map.wpm");
  assert.throws(() => statSync(join(root, "map", "war3map.wpm")), "the split moved it out of map/");
  assert.deepEqual(new Uint8Array(await w3.workspace.readBytes("map/war3map.wpm")), new Uint8Array(readFileSync(stored)));
  assert.ok(w3.workspace.files().some((f) => f.path === "map/war3map.wpm"), "listed under its map/ name");
  const wpm = new Uint8Array(readFileSync(stored));
  wpm[wpm.length - 1] ^= 1;
  await w3.workspace.writeBytes("map/war3map.wpm", wpm);
  assert.deepEqual(new Uint8Array(readFileSync(stored)), wpm);
  assert.throws(() => statSync(join(root, "map", "war3map.wpm")), "nothing written into map/");
  assert.deepEqual([...await workspaceOf(w3).externalChanges()], [], "the store's file was the app's own write");
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\/\.w3proj\/derived\/$/m);
});

// ---- stage 4: partial load (Open Subterrains…, crates/w3proj terrain_open.rs) ----

/** A 25×17-corner copy of the mini map (its tiles and first corner repeated, heights varied; offset 0, 0: corner c at
 *  world 128·c), doodads every third tile, split into 3×2 subterrains by the command: south row a0 a1 a2, north row b0
 *  b1 b2 (x 0/8/16, y 0/8). Opened. */
async function bigSplit(name: string): Promise<{ w3: W3Api; root: string }> {
  const root = project(name);
  const mini = parseW3e(await readTerrainBytes("map/war3map.w3e.txt", { readText: async () => readFileSync(join(root, "map", "war3map.w3e.txt"), "utf8"), readBytes: async () => { throw new Error("text"); } }));
  const W = 25, H = 17;
  const corners = Array.from({ length: W * H }, (_, i) => {
    const c = { ...mini.corners[0], texture: i % 3, variation: i % 5, hasWater: false, boundary: false, ramp: false, blight: false };
    setGroundHeight(c, (i % 7) * 4);
    return c;
  });
  const t = { ...mini, width: W, height: H, offsetX: 0, offsetY: 0, corners };
  writeFileSync(join(root, "map", "war3map.w3e.txt"), w3eToText(writeW3e(t)));
  const doo = JSON.parse(readFileSync(join(root, "map", "war3map.doo.json"), "utf8"));
  doo.doodads = [];
  for (let ty = 0; ty < H - 1; ty += 3) for (let tx = 0; tx < W - 1; tx += 3) {
    doo.doodads.push({ id: "ATtr", variation: 0, position: [128 * tx + 40, 128 * ty + 40, 0], angle: 0.5, scale: [1, 1, 1], skinId: "ATtr", flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: doo.doodads.length + 1 });
  }
  doo.specials = [];
  writeFileSync(join(root, "map", "war3map.doo.json"), JSON.stringify(doo, null, 2));
  const units = JSON.parse(readFileSync(join(root, "map", "war3mapUnits.doo.json"), "utf8"));
  units.units[0].position = [200, 200, 0];
  writeFileSync(join(root, "map", "war3mapUnits.doo.json"), JSON.stringify(units, null, 2));
  const regions = JSON.parse(readFileSync(join(root, "map", "war3map.w3r.json"), "utf8"));
  regions.regions[0] = { ...regions.regions[0], left: 100, bottom: 100, right: 300, top: 300 };
  writeFileSync(join(root, "map", "war3map.w3r.json"), JSON.stringify(regions, null, 2));
  const w3 = await open(root);
  await splitTerrain(w3, { layout: ["a0:0,0,8,8", "a1:8,0,8,8", "a2:16,0,9,8", "b0:0,8,8,9", "b1:8,8,8,9", "b2:16,8,9,9"], quiet: true });
  return { w3, root };
}

/** A subterrain folder's files: name → bytes and last write. */
function folderState(root: string, sub: string): string {
  const dir = join(root, "map", "terrain", sub);
  return readdirSync(dir).sort().map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}:${readFileSync(join(dir, f)).toString("latin1")}`).join("|");
}

test("Open Subterrains: closed ones are default-filled and left out, edits save into the open one only, edits outside are refused", async () => {
  const { w3, root } = await bigSplit("partial");
  const whole = await loaded(w3);
  const state = await openSubterrains(w3, { names: ["a0"] });
  assert.ok(state?.partial, "partial");
  assert.equal(readFileSync(join(root, ".w3proj", "open-subterrains.json"), "utf8"), "{\n  \"format\": \"w3proj.open-subterrains/1\",\n  \"open\": [\"a0\"]\n}\n");
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\/\.w3proj\/open-subterrains\.json$/m);
  const closed = ["a2", "b2"].map((s) => folderState(root, s));
  const halo = ["a1", "b0", "b1"].map((s) => folderState(root, s));
  // What the terrain editor loads: a0 whole, the halo (two corners into a1, b0, b1), the default corner elsewhere.
  const part = await loaded(w3);
  const mask = partialMask(state, 25, 17)!;
  const layout = JSON.parse(readFileSync(join(root, "map", "terrain", "terrain.json"), "utf8"));
  for (let i = 0; i < 25 * 17; i++) {
    if (mask.corners[i] === CLOSED) assert.equal(part.terrain.corners[i].texture, layout.defaultCorner.texture, `closed corner ${i}`);
    else assert.deepEqual(part.terrain.corners[i], whole.terrain.corners[i], `corner ${i}`);
  }
  const xs = part.placed.filter((p) => p.id === "ATtr").map((p) => p.position);
  assert.ok(xs.length > 0 && xs.length < whole.placed.filter((p) => p.id === "ATtr").length, "fewer doodads");
  assert.ok(xs.every(([x, y]) => x < 1280 && y < 1280), "a0's and the halo's only");
  // An edit in a0, saved as the terrain editor saves it: a0's terrain.txt only.
  const path = "map/war3map.w3e.txt";
  const io = { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path), writeText: (t: string) => w3.workspace.writeText(path, t), writeBytes: (b: Uint8Array) => w3.workspace.writeBytes(path, b) };
  let before = snapshot(root);
  const t = parseW3e(await readTerrainBytes(path, io));
  t.corners[2 * 25 + 3].variation = (t.corners[2 * 25 + 3].variation + 1) % 16;
  await writeTerrainBytes(path, writeW3e(t), io);
  assert.deepEqual(changedFiles(before, snapshot(root)), ["map/terrain/a0/terrain.txt"]);
  // One in the halo (corner 9, 0 in a1) and one in b2: refused, nothing written.
  for (const i of [9, 16 * 25 + 20]) {
    before = snapshot(root);
    const u = parseW3e(await readTerrainBytes(path, io));
    u.corners[i].variation = (u.corners[i].variation + 1) % 16;
    await assert.rejects(writeTerrainBytes(path, writeW3e(u), io), /nothing was written/);
    assert.deepEqual(changedFiles(before, snapshot(root)), [], `corner ${i}`);
  }
  // A unit placed in a0: numbered from a0's range, saved into a0's units.json; one placed in b2: refused.
  before = snapshot(root);
  assert.deepEqual(await placeUnits(w3, [[300, 300, 0]]), [10000]);
  assert.deepEqual(changedFiles(before, snapshot(root)), ["map/terrain/a0/units.json"]);
  before = snapshot(root);
  await assert.rejects(placeUnits(w3, [[2500, 1900, 0]]), /lies in subterrain "b2", which isn't open/);
  assert.deepEqual(changedFiles(before, snapshot(root)), []);
  // The doodads saved as loaded (halo ones among them, through the app's canonical JSON): nothing written.
  before = snapshot(root);
  const same = (await loadPlacedFile(w3, "war3map.doo", "doodads"))!;
  assert.ok(same.list.some((p) => p.position[0] >= 1024), "halo doodads are loaded");
  await savePlacedFile(w3, same);
  assert.deepEqual(changedFiles(before, snapshot(root)), []);
  // One of a0's moved within a0: a0's doodads.json only.
  const mine = (await loadPlacedFile(w3, "war3map.doo", "doodads"))!;
  const tree = mine.list.find((p) => p.position[0] < 900 && p.position[1] < 900)!;
  tree.position = [tree.position[0] + 20, tree.position[1], tree.position[2]];
  await savePlacedFile(w3, mine);
  assert.deepEqual(changedFiles(before, snapshot(root)), ["map/terrain/a0/doodads.json"]);
  // A halo doodad moved: refused.
  const f = (await loadPlacedFile(w3, "war3map.doo", "doodads"))!;
  const haloTree = f.list.find((p) => p.position[0] >= 1024)!;
  haloTree.position = [haloTree.position[0] + 10, haloTree.position[1], 0];
  await assert.rejects(savePlacedFile(w3, f), /isn't open/);
  // The closed subterrains' files and the halo's: the same bytes and times through all of it.
  assert.deepEqual(["a2", "b2"].map((s) => folderState(root, s)), closed);
  assert.deepEqual(["a1", "b0", "b1"].map((s) => folderState(root, s)), halo);
  // The derived files' sources say subterrains were closed.
  const sources = await w3.backend.invoke<Record<string, string>>("derived_sources", { root });
  assert.equal(sources[DERIVED_CLOSED_KEY], "5");
  assert.ok(!Object.keys(sources).some((k) => k.includes("/b2/")));
  // All open again: the file goes, the whole map reads with the edits.
  await openSubterrains(w3, { all: true });
  assert.throws(() => statSync(join(root, ".w3proj", "open-subterrains.json")));
  const after = await loaded(w3);
  assert.equal(after.terrain.corners.length, whole.terrain.corners.length);
  assert.equal(after.placed.filter((p) => p.id === "ATtr").length, whole.placed.filter((p) => p.id === "ATtr").length);
});

test("a damaged .w3proj/open-subterrains.json is an error when the terrain is read, never a guess of what's open", async () => {
  const { w3, root } = await bigSplit("damaged-open");
  mkdirSync(join(root, ".w3proj"), { recursive: true });
  for (const [text, why] of [["{ not json", /isn't JSON/], ['{"format": "w3proj.open-subterrains/1", "open": []}', /opens no subterrain/], ['{"format": "w3proj.open-subterrains/1", "open": ["zz"]}', /"zz"/]] as const) {
    writeFileSync(join(root, ".w3proj", "open-subterrains.json"), text);
    await w3.workspace.refresh();
    await assert.rejects(w3.workspace.readText("map/war3map.w3e.txt"), why);
    const s = await w3.backend.invoke<{ error: string | null; partial: boolean; subterrains: unknown[] }>("terrain_open_state", { root });
    assert.ok(s.error && !s.partial && s.subterrains.length === 6, text);
    assert.ok(w3.workspace.files().some((f) => f.path === "map/war3map.w3e.txt"), "still listed");
  }
  // Picked again: it reads.
  await openSubterrains(w3, { names: ["b1"] });
  assert.ok((await w3.workspace.readText("map/war3map.w3e.txt")).startsWith("W3E"));
  await assert.rejects(openSubterrains(w3, { names: ["nope"] }), /no subterrain "nope".*Nothing was changed/);
  await assert.rejects(openSubterrains(w3, { names: [] }), /at least one/);
});

/** The workspace service behind a headless w3 (for externalChanges, which the extension API doesn't have). */
function workspaceOf(w3: W3Api) {
  const ws = workspaces.get(w3);
  if (!ws) throw new Error("not a headless w3 of this test");
  return ws;
}
