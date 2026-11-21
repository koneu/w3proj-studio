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
import { parseW3e, writeW3e } from "../lib/terrain/w3e";
import { readTerrainBytes, terrainPath, writeTerrainBytes } from "../lib/terrain/w3etext";
import { readMapDocStrict } from "../lib/formats/mapdoc";
import { projectWalkSource } from "../builtin/terrain-viewer/meleefacts";
import { loadPlacedFile, savePlacedFile } from "../builtin/terrain-viewer/placement";
import { unlistedFiles } from "../lib/imports";
import type { WorkspaceService } from "../workbench/workspace";
import manifest from "../builtin/terrain-layout/extension.json";
import { FLAT_FILES, isSplit, mergeTerrain, splitTerrain } from "../builtin/terrain-layout/index";

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

/** The workspace service behind a headless w3 (for externalChanges, which the extension API doesn't have). */
function workspaceOf(w3: W3Api) {
  const ws = workspaces.get(w3);
  if (!ws) throw new Error("not a headless w3 of this test");
  return ws;
}
