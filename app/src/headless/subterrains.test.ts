// A project whose terrain is split into subterrains (map/terrain/) opens, edits and saves as the flat one does: the
// app's own code (what the terrain editor loads: projectWalkSource, the placement files, the regions; what it saves:
// writeTerrainBytes, savePlacedFile) over the real backend (`w3proj serve-backend`, headless/rustbackend.ts),
// on copies of the mini map: flat, split 2×2 and split into one `main` by this extension's command.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionContext, ExtensionManifest, W3Api } from "../extensions/api";
import { headless } from "./host";
import { rustBackend } from "./rustbackend";
import { fixturePath, repoPath } from "../lib/testhelpers/testutil";
import { parseW3e, setGroundHeight, setLayer, writeW3e } from "../lib/terrain/w3e";
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
import { MCP_EDITS_SERVICE } from "../extensions/services";
import { activate, changeSubterrainsTool, checkTerrainIds, checkTerrainSeams, fixCreationIds, FLAT_FILES, getSubterrainsTool, isSplit, joinSubterrains, mergeHook, layoutOps, type MergeHookResult, newSubterrain, openSubterrains, renameSubterrain, resizeSubterrain, splitTerrain } from "../builtin/terrain-layout/index";
import { addSub, draftOf, gridRects, planOf, renameSub, resizeSub } from "../lib/terrain/layoutdraft";
import { readPathingFile } from "../builtin/terrain-pathing/file";
import { pathingOverridesText, resizeTerrain, type PathingOverrides } from "../lib/terrain/resize";

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

test("Install Merge Hook writes the shared backend's hook into the project's repository; Remove takes it away", async () => {
  execFileSync("git", ["init", "-q"], { cwd: gridRoot });
  const hook = join(gridRoot, ".git", "hooks", "post-merge");
  const got = await mergeHook(grid, { quiet: true });
  assert.ok(got.git && got.action === "installed" && existsSync(hook), JSON.stringify(got));
  assert.equal(resolve(got.hook), resolve(hook));
  const text = readFileSync(hook, "utf8");
  assert.ok(text.includes("# w3proj terrain merge-hook") && text.includes("terrain seams"), "the backend's text");
  assert.equal((await mergeHook(grid, { quiet: true })).action, "updated");
  // Someone else's sh hook (as Git LFS writes one) keeps its text: ours goes in front, Remove takes only ours out.
  writeFileSync(hook, "#!/bin/sh\necho mine\n");
  assert.equal((await mergeHook(grid, { quiet: true })).action, "installed");
  const both = readFileSync(hook, "utf8");
  assert.ok(both.includes("terrain seams") && both.endsWith("\necho mine\n"), both);
  assert.equal((await mergeHook(grid, { quiet: true, remove: true })).action, "removed");
  assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\necho mine\n");
  await assert.rejects(mergeHook(grid, { quiet: true, remove: true }), /left as it is/);
  // Control: a hook that isn't an sh script is left alone.
  writeFileSync(hook, "#!/usr/bin/env python3\nprint('mine')\n");
  const foreign = await mergeHook(grid, { quiet: true });
  assert.equal(foreign.action, "foreign");
  assert.equal(readFileSync(hook, "utf8"), "#!/usr/bin/env python3\nprint('mine')\n");
  await assert.rejects(mergeHook(grid, { quiet: true, remove: true }), /left as it is/);
  rmSync(hook);
  assert.equal((await mergeHook(grid, { quiet: true })).action, "installed");
  assert.equal((await mergeHook(grid, { quiet: true, remove: true })).action, "removed");
  assert.ok(!existsSync(hook));
  // A flat project has no seams to check.
  await assert.rejects(mergeHook(flat, { quiet: true }), /no split terrain/);
  // The commands are in the manifest, for an open project, and call the same function.
  for (const id of ["installMergeHook", "removeMergeHook"]) assert.ok((manifest as ExtensionManifest).contributes?.commands?.some((c) => c.id === `w3.terrainLayout.${id}` && c.when === "project"), id);
  activate(grid, { subscriptions: [] } as unknown as ExtensionContext);
  assert.equal((await grid.commands.execute<MergeHookResult>("w3.terrainLayout.installMergeHook", { quiet: true })).action, "installed");
  assert.equal((await grid.commands.execute<MergeHookResult>("w3.terrainLayout.removeMergeHook", { quiet: true })).action, "removed");
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

test("Map Size on a split terrain: the app's resized terrain saves, the canvas and the edge subterrains grow, objects stay theirs; shrunk back, every file as it was", async () => {
  const { w3, root } = await splitProject("mapsize");
  const path = terrainPath(w3.workspace.files().map((f) => f.path))!;
  const io = { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path), writeText: (t: string) => w3.workspace.writeText(path, t), writeBytes: (b: Uint8Array) => w3.workspace.writeBytes(path, b) };
  const t = parseW3e(await readTerrainBytes(path, io));
  const layoutOf = () => JSON.parse(readFileSync(join(root, "map", "terrain", "terrain.json"), "utf8")) as { corners: number[]; offset: number[]; subterrains: { name: string; x: number; y: number; w: number; h: number; idRange: unknown }[] };
  const was = layoutOf();
  const before = snapshot(root);
  const units = (await loadPlacedFile(w3, "war3mapUnits.doo", "units"))!.list.map((u) => [u.id, ...u.position]);
  // Two tiles west and one north added, as Map Size's resizeTerrain makes them (new corners copy the edge).
  const grown = resizeTerrain(t, [2, 0, 0, 1]);
  await writeTerrainBytes(path, writeW3e(grown), io);
  await w3.workspace.refresh();
  const now = layoutOf();
  assert.deepEqual(now.corners, [was.corners[0] + 2, was.corners[1] + 1]);
  assert.deepEqual(now.offset, [was.offset[0] - 256, was.offset[1]]);
  // West ones reach the new west edge, north ones the new north edge, the rest moved by the two corners.
  const want = was.subterrains.map((s) => ({ ...s, x: s.x === 0 ? 0 : s.x + 2, w: s.x === 0 ? s.w + 2 : s.w, h: s.y + s.h === was.corners[1] ? s.h + 1 : s.h }));
  assert.deepEqual(now.subterrains, want);
  assert.equal(w3eToText(await readTerrainBytes(path, io)), w3eToText(writeW3e(grown)), "the terrain reads back as written");
  assert.deepEqual((await loadPlacedFile(w3, "war3mapUnits.doo", "units"))!.list.map((u) => [u.id, ...u.position]), units, "the objects stay where they were");
  // Shrunk back (what Undo Resize writes): the split files byte for byte.
  await writeTerrainBytes(path, writeW3e(t), io);
  await w3.workspace.refresh();
  assert.deepEqual(changedFiles(before, snapshot(root)), []);
});

test("Map Size on a split terrain, each side and every side at once, 2×2 and main: the subterrains on a grown side take the new strip (a corner region the corner one's), the layout still covers the canvas; shrunk back, every file as it was", async () => {
  for (const layout of ["2x2", "main"] as const) {
    const root = project(`mapsize-sides-${layout}`);
    const w3 = await open(root);
    await splitTerrain(w3, { layout, quiet: true });
    const path = terrainPath(w3.workspace.files().map((f) => f.path))!;
    const io = { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path), writeText: (t: string) => w3.workspace.writeText(path, t), writeBytes: (b: Uint8Array) => w3.workspace.writeBytes(path, b) };
    const t = parseW3e(await readTerrainBytes(path, io));
    type Sub = { name: string; x: number; y: number; w: number; h: number };
    const layoutOf = () => JSON.parse(readFileSync(join(root, "map", "terrain", "terrain.json"), "utf8")) as { corners: [number, number]; subterrains: Sub[] };
    const was = layoutOf();
    const before = snapshot(root);
    // [left, right, bottom, top] in tiles, as Map Size takes them.
    for (const change of [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 2], [1, 2, 3, 4]] as [number, number, number, number][]) {
      const [l, r, b, n] = change;
      await writeTerrainBytes(path, writeW3e(resizeTerrain(t, change)), io);
      await w3.workspace.refresh();
      const now = layoutOf();
      const [W, H] = [was.corners[0] + l + r, was.corners[1] + b + n];
      assert.deepEqual(now.corners, [W, H], `${layout} ${change}`);
      // The rule (terrain_layout.rs resized_canvas), worked out here from the old rectangles.
      const want = was.subterrains.map((s) => ({
        ...s,
        x: s.x === 0 ? 0 : s.x + l, w: s.w + (s.x === 0 ? l : 0) + (s.x + s.w === was.corners[0] ? r : 0),
        y: s.y === 0 ? 0 : s.y + b, h: s.h + (s.y === 0 ? b : 0) + (s.y + s.h === was.corners[1] ? n : 0),
      }));
      assert.deepEqual(now.subterrains, want, `${layout} ${change}`);
      const cover = new Uint8Array(W * H);
      for (const s of now.subterrains) for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) cover[y * W + x]++;
      assert.ok(cover.every((c) => c === 1), `${layout} ${change}: every corner in one subterrain`);
      // Shrunk back (what Undo Resize writes): the split files byte for byte.
      await writeTerrainBytes(path, writeW3e(t), io);
      await w3.workspace.refresh();
      assert.deepEqual(changedFiles(before, snapshot(root)), [], `${layout} ${change} shrunk back`);
    }
  }
});

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

test("after the same edits the split project reads as the flat one, file for file", async () => {
  assert.ok(isSplit(grid) && !isSplit(flat));
  assert.deepEqual(await loaded(grid), await loaded(flat));
  for (const f of FLAT_FILES) assert.equal(await grid.workspace.readText(f), await flat.workspace.readText(f), f);
  // Every other file of the flat project's map/ reads alike in the split one (its derived files from .w3proj/derived/).
  for (const [f, bytes] of snapshot(flatRoot)) {
    if (FLAT_FILES.includes(f)) continue;
    assert.equal(Buffer.from(await grid.workspace.readBytes(f)).toString("latin1"), bytes, f);
  }
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
  // A flat project is checked too (numbers found twice; it has no ranges).
  const flatCheck = await checkTerrainIds(flat, { quiet: true });
  assert.equal(flatCheck.errors, false, flatCheck.lines.join("\n"));
});

test("Fix Duplicate Creation Numbers on a flat project (three stacked doodads share a number, the last an exact copy): listed, refused unsaved, renumbered as one edit, then it splits", async () => {
  const root = project("fixids");
  const path = join(root, "map", "war3map.doo.json");
  const doo = JSON.parse(readFileSync(path, "utf8")) as { doodads: Record<string, unknown>[] };
  const lt = { ...doo.doodads[1], position: [96, 96, 0], editorId: 581 };
  doo.doodads.push({ ...lt, variation: 3 }, lt, { ...lt });
  writeFileSync(path, JSON.stringify(doo, null, 2));
  const w3 = await open(root);
  const writes: string[] = [];
  // The undoable edit as the MCP server provides it: here written through the workspace.
  w3.services.provide(MCP_EDITS_SERVICE, { edit: async (_t: string, change: (read: (p: string) => Promise<string | null>) => Promise<{ path: string; text: string }[]>) => {
    const files = await change((p) => w3.workspace.readText(p).catch(() => null));
    for (const f of files) { writes.push(f.path); await w3.workspace.writeText(f.path, f.text); }
    return files.length > 0;
  } });
  const check = await checkTerrainIds(w3, { quiet: true });
  assert.equal(check.errors, true);
  assert.deepEqual(check.duplicates.map((d) => [d.kind, d.number, d.members.map((m) => [m.index, m.id, m.copyOf ?? null])]), [["doodads", 581, [[2, "LOtr", null], [3, "LOtr", null], [4, "LOtr", 3]]]]);
  await assert.rejects(splitTerrain(w3, { layout: "main", quiet: true }), /doodads\[2\], doodads\[3\] and doodads\[4\] have the same creation number 581.*fix-ids/);
  // The plans, nothing written.
  const before = snapshot(root);
  const renumber = await fixCreationIds(w3, { mode: "renumber", dryRun: true, quiet: true });
  assert.deepEqual(renumber?.groups[0].members.map((m) => [m.action, m.to ?? null]), [["keep", null], ["renumber", 582], ["renumber", 583]]);
  const deleting = await fixCreationIds(w3, { mode: "deleteCopies", dryRun: true, quiet: true });
  assert.deepEqual([deleting?.deleted, deleting?.stillTwice, deleting?.groups[0].members.map((m) => m.action)], [1, 2, ["keep", "stays", "delete"]]);
  assert.deepEqual(changedFiles(before, snapshot(root)), [], "a plan writes nothing");
  // Refused while something is unsaved.
  const unsaved = w3.editors.unsavedPaths;
  (w3.editors as { unsavedPaths: () => string[] }).unsavedPaths = () => ["map/war3map.w3i.json"];
  await assert.rejects(fixCreationIds(w3, { mode: "renumber", quiet: true }), /save or discard the changes in map\/war3map.w3i.json first/);
  (w3.editors as { unsavedPaths: () => string[] }).unsavedPaths = unsaved;
  assert.deepEqual(writes, []);
  const done = await fixCreationIds(w3, { mode: "renumber", quiet: true });
  assert.equal(done?.renumbered, 2);
  assert.deepEqual(writes, ["map/war3map.doo.json"], "one edit of one file");
  const after = JSON.parse(readFileSync(path, "utf8")) as { doodads: Record<string, unknown>[] };
  assert.deepEqual(after.doodads.map((d) => d.editorId), [0, 1, 581, 582, 583]);
  assert.deepEqual(after.doodads.map((d) => ({ ...d, editorId: 0 })), doo.doodads.map((d) => ({ ...d, editorId: 0 })), "nothing else changed");
  assert.equal((await checkTerrainIds(w3, { quiet: true })).errors, false);
  await splitTerrain(w3, { layout: "main", quiet: true });
  assert.ok(isSplit(w3));
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
  assert.deepEqual(report.duplicates.map(({ members, ...d }) => ({ ...d, members: members.map((m) => [m.file, m.id]) })),
    [{ kind: "units", number: 10000, files: ["map/terrain/sw/units.json", "map/terrain/sw/units.json"], members: [["map/terrain/sw/units.json", "hfoo"], ["map/terrain/sw/units.json", "hfoo"]] }]);
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

test("Check Terrain Seams: two saves that are each fine, merged as git merges them, leave a cliff the check reports; closed subterrains are read too", async () => {
  const { w3, root } = await bigSplit("seams");
  const path = "map/war3map.w3e.txt";
  const io = { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path), writeText: (t: string) => w3.workspace.writeText(path, t), writeBytes: (b: Uint8Array) => w3.workspace.writeBytes(path, b) };
  /** Corner (x, y) to cliff level `level`, saved as the terrain editor saves it. */
  const setLevel = async (x: number, y: number, level: number) => {
    const t = parseW3e(await readTerrainBytes(path, io));
    setLayer(t.corners[y * t.width + x], level);
    await writeTerrainBytes(path, writeW3e(t), io);
  };
  const a1 = join(root, "map", "terrain", "a1", "terrain.txt");
  const original = readFileSync(a1);
  const check = () => checkTerrainSeams(w3, { quiet: true });
  const before = await check();
  assert.deepEqual(before.issues, [], "control: the split itself has none");
  assert.deepEqual(before.seams, [["a0", "a1"], ["a0", "b0"], ["a0", "b1"], ["a1", "a2"], ["a1", "b0"], ["a1", "b1"], ["a1", "b2"], ["a2", "b1"], ["a2", "b2"], ["b0", "b1"], ["b1", "b2"]]);
  // Branch B lowers a1's corner 8,3 to level 0 (a cliff of two beside a0): fine.
  await setLevel(8, 3, 0);
  assert.deepEqual((await check()).issues, [], "branch B alone");
  const branchB = readFileSync(a1);
  assert.notDeepEqual(branchB, original);
  writeFileSync(a1, original);
  await w3.workspace.refresh();
  // Branch A raises a0's corner 7,3 to level 4: fine.
  await setLevel(7, 3, 4);
  assert.deepEqual((await check()).issues, [], "branch A alone");
  // Merged: a0 has A's file, a1 B's (different files, no git conflict). A cliff of four levels across the seam.
  writeFileSync(a1, branchB);
  await w3.workspace.refresh();
  const merged = await check();
  assert.equal(merged.errors, 1);
  assert.deepEqual(merged.issues.map((i) => [i.rule, i.corners]), [["cliff-height", [{ x: 7, y: 3, subterrain: "a0" }, { x: 8, y: 3, subterrain: "a1" }]]]);
  // With only a2 open (a0 and a1 closed, not even in its halo at 7,3), the check still reads the whole terrain from disk.
  await openSubterrains(w3, { names: ["a2"] });
  assert.deepEqual((await check()).issues, merged.issues);
  // Nothing was written by the checks.
  const snap = snapshot(root);
  await check();
  assert.deepEqual(changedFiles(snap, snapshot(root)), []);
  await openSubterrains(w3, { all: true });
  // A flat project has no seams: refused with the reason.
  await assert.rejects(checkTerrainSeams(flat, { quiet: true }), /isn't split/);
});

test("New, Resize, Rename and Join Subterrains: the map stays the same, objects go where their position lies, ranges and the open choice follow", async () => {
  const { w3, root } = await bigSplit("relayout");
  const whole = await loaded(w3);
  const layout = () => JSON.parse(readFileSync(join(root, "map", "terrain", "terrain.json"), "utf8")) as { subterrains: { name: string; folder: string; x: number; y: number; w: number; h: number; idRange: unknown }[] };
  const sub = (name: string) => layout().subterrains.find((s) => s.name === name);
  const doodadsIn = (folder: string) => (JSON.parse(readFileSync(join(root, "map", "terrain", folder, "doodads.json"), "utf8")).doodads as { position: number[] }[]).map((d) => d.position);
  const folders = () => readdirSync(join(root, "map", "terrain"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const same = async (what: string) => assert.deepEqual(await loaded(w3), whole, `${what}: the map changed`);

  // Rename: the folder goes with the name, the range stays.
  const range = sub("a0")!.idRange;
  await renameSubterrain(w3, { name: "a0", to: "south_west", quiet: true });
  assert.deepEqual(folders(), ["a1", "a2", "b0", "b1", "b2", "south_west"]);
  assert.deepEqual(sub("south_west")!.idRange, range);
  await same("rename");
  // Join a1 and a2: one folder, both ranges.
  await joinSubterrains(w3, { names: ["a1", "a2"], to: "south_east", quiet: true });
  assert.deepEqual(folders(), ["b0", "b1", "b2", "south_east", "south_west"]);
  assert.deepEqual(sub("south_east")!.idRange, [[20000, 29999], [30000, 39999]]);
  assert.deepEqual([sub("south_east")!.x, sub("south_east")!.w], [8, 17]);
  await same("join");
  // Resize b0 two corners east, into b1: b1's doodads in those two columns go to b0.
  const b1Before = doodadsIn("b1").length;
  const taken = doodadsIn("b1").filter(([x]) => x < 128 * 10).length;
  assert.ok(taken > 0, "control: there are doodads in the columns taken");
  await resizeSubterrain(w3, { name: "b0", rect: "0,8,10,9", quiet: true });
  assert.deepEqual([sub("b1")!.x, sub("b1")!.w], [10, 6]);
  assert.equal(doodadsIn("b1").length, b1Before - taken);
  assert.ok(doodadsIn("b0").every(([x]) => x < 128 * 10) && doodadsIn("b1").every(([x]) => x >= 128 * 10), "each doodad in the subterrain its position lies in");
  await same("resize");
  // A new one taking b1's west side: the next block of numbers.
  await newSubterrain(w3, { name: "mid", rect: { x: 10, y: 8, w: 2, h: 9 }, quiet: true });
  assert.deepEqual(sub("mid")!.idRange, [70000, 79999]);
  assert.deepEqual([sub("b1")!.x, sub("b1")!.w], [12, 4]);
  await same("new");

  // Refused, nothing written: corners given up that aren't the default corner, a name taken, one cut in pieces.
  const before = snapshot(root);
  await assert.rejects(resizeSubterrain(w3, { name: "b2", rect: "16,8,8,9", quiet: true }), /Resize Subterrain: .*would be lost.* Nothing was changed\./);
  await assert.rejects(renameSubterrain(w3, { name: "b2", to: "MID", quiet: true }), /already/);
  await assert.rejects(newSubterrain(w3, { name: "hole", rect: "20,10,2,2", quiet: true }), /would leave b2 in pieces/);
  assert.deepEqual(changedFiles(before, snapshot(root)), []);

  // With some closed: the open choice follows a rename; the closed files are read for the change (it is of the whole map).
  await openSubterrains(w3, { names: ["south_west", "b1"] });
  await renameSubterrain(w3, { name: "b1", to: "north", quiet: true });
  assert.equal(readFileSync(join(root, ".w3proj", "open-subterrains.json"), "utf8"), "{\n  \"format\": \"w3proj.open-subterrains/1\",\n  \"open\": [\"south_west\", \"north\"]\n}\n");
  await openSubterrains(w3, { all: true });
  await same("rename with some closed");
});

test("the MCP tool change_subterrains: the commands' changes and refusals, without questions", async () => {
  const { w3, root } = await bigSplit("tool");
  const whole = await loaded(w3);
  const folders = () => readdirSync(join(root, "map", "terrain"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const renamed = await changeSubterrainsTool(w3, { action: "rename", name: "a0", to: "south_west" });
  assert.deepEqual(folders(), ["a1", "a2", "b0", "b1", "b2", "south_west"]);
  assert.ok(renamed.written.some((p) => p.startsWith("map/terrain/south_west/")) && renamed.removed.some((p) => p.startsWith("map/terrain/a0/")), JSON.stringify(renamed));
  assert.deepEqual(renamed.subterrains.map((s) => s.name).sort(), ["a1", "a2", "b0", "b1", "b2", "south_west"]);
  await changeSubterrainsTool(w3, { action: "join", names: ["a1", "a2"], to: "south_east" });
  await changeSubterrainsTool(w3, { action: "resize", name: "b0", rect: "0,8,10,9" });
  await changeSubterrainsTool(w3, { action: "new", name: "mid", rect: { x: 10, y: 8, w: 2, h: 9 } });
  assert.deepEqual(folders(), ["b0", "b1", "b2", "mid", "south_east", "south_west"]);
  assert.deepEqual(await loaded(w3), whole, "the map stayed the same");
  // The commands' refusals, word for word; arguments a command would ask for are required; nothing written.
  const before = snapshot(root);
  const reason = (p: Promise<unknown>) => p.then(() => "done", (e: Error) => e.message);
  for (const [tool, command] of [
    [{ action: "resize", name: "b2", rect: "16,8,8,9" }, () => resizeSubterrain(w3, { name: "b2", rect: "16,8,8,9", quiet: true })],
    [{ action: "rename", name: "b2", to: "MID" }, () => renameSubterrain(w3, { name: "b2", to: "MID", quiet: true })],
    [{ action: "new", name: "hole", rect: "20,10,2,2" }, () => newSubterrain(w3, { name: "hole", rect: "20,10,2,2", quiet: true })],
    [{ action: "join", names: ["south_west", "b2"], to: "x" }, () => joinSubterrains(w3, { names: ["south_west", "b2"], to: "x", quiet: true })],
  ] as const) {
    const byTool = await reason(changeSubterrainsTool(w3, tool)), byCommand = await reason(command());
    assert.equal(byTool, byCommand, JSON.stringify(tool));
    assert.match(byTool, /Nothing was changed\.$/, JSON.stringify(tool));
  }
  for (const [args, why] of [
    [{ action: "rename", name: "b2" }, /rename needs to/],
    [{ action: "new", name: "x" }, /new needs rect/],
    [{ action: "join", names: ["b2"], to: "x" }, /join needs names/],
    [{ action: "move" }, /action must be/],
    [{ action: "split" }, /split already/],
  ] as const) await assert.rejects(changeSubterrainsTool(w3, args), why);
  // Refused while something is unsaved, as the commands.
  const unsaved = w3.editors.unsavedPaths;
  (w3.editors as { unsavedPaths: () => string[] }).unsavedPaths = () => ["map/war3map.w3i.json"];
  await assert.rejects(changeSubterrainsTool(w3, { action: "rename", name: "b2", to: "north" }), /save or discard the changes in map\/war3map.w3i.json first/);
  (w3.editors as { unsavedPaths: () => string[] }).unsavedPaths = unsaved;
  assert.deepEqual(changedFiles(before, snapshot(root)), []);
});

// ---- the Terrain Layout editor's calls (terrain-layout/editor.ts through index.ts layoutOps, the backend's preview and undo) ----

test("Terrain Layout editor: a draft of several steps previews what moves (nothing written), applies as one change, Undo takes it back byte for byte, Redo makes it again", async () => {
  const { w3, root } = await bigSplit("layout-editor");
  const whole = await loaded(w3);
  const ops = layoutOps(w3);
  const state = await ops.readState();
  assert.equal(state.layout, "split");
  assert.deepEqual(state.canvas, [25, 17]);
  assert.deepEqual(state.subterrains.map((s) => [s.name, s.x, s.y, s.w, s.h, s.open, s.idRanges]), [
    ["a0", 0, 0, 8, 8, true, [[10000, 19999]]], ["a1", 8, 0, 8, 8, true, [[20000, 29999]]], ["a2", 16, 0, 9, 8, true, [[30000, 39999]]],
    ["b0", 0, 8, 8, 9, true, [[40000, 49999]]], ["b1", 8, 8, 8, 9, true, [[50000, 59999]]], ["b2", 16, 8, 9, 9, true, [[60000, 69999]]],
  ]);
  const picture = await ops.picture();
  assert.ok(picture && picture.width === 25 && picture.height === 17 && picture.rgba.length === 25 * 17 * 4, "a pixel per corner");
  // The draft as the editor makes it: a0 renamed, b0 resized two columns into b1, a new one over b1's west side.
  let d = draftOf(state.subterrains, state.canvas);
  const ok = <T>(v: T | string): T => { if (typeof v === "string") throw new Error(v); return v; };
  d = ok(renameSub(d, "a0", "south_west"));
  d = ok(resizeSub(d, "b0", { x: 0, y: 8, w: 10, h: 9 }));
  d = ok(addSub(d, "mid", { x: 10, y: 8, w: 3, h: 9 }));
  const before = snapshot(root);
  const p = await ops.preview(planOf(d));
  assert.deepEqual(changedFiles(before, snapshot(root)), [], "a preview writes nothing");
  assert.deepEqual(p.subterrains.map((s) => [s.name, s.x, s.w, s.from]), [["south_west", 0, 8, ["a0"]], ["a1", 8, 8, ["a1"]], ["a2", 16, 9, ["a2"]], ["b0", 0, 10, ["b0"]], ["b1", 13, 3, ["b1"]], ["b2", 16, 9, ["b2"]], ["mid", 10, 3, []]]);
  const taken = JSON.parse(readFileSync(join(root, "map", "terrain", "b1", "doodads.json"), "utf8")).doodads as { position: number[] }[];
  const into = (lo: number, hi: number) => taken.filter((t) => t.position[0] >= 128 * lo && t.position[0] < 128 * hi).length;
  assert.ok(into(8, 10) > 0 && into(10, 13) > 0, "control: doodads lie in both strips");
  assert.deepEqual(p.moves.filter((m) => m.kind === "doodads"), [{ kind: "doodads", from: "b1", to: "b0", count: into(8, 10) }, { kind: "doodads", from: "b1", to: "mid", count: into(10, 13) }]);
  // A refused draft: the backend's reason, in words, nothing written.
  const lost = ok(resizeSub(d, "b2", { x: 16, y: 8, w: 8, h: 9 }));
  await assert.rejects(ops.preview(planOf(lost)), /Change Subterrains: .*would be lost/);
  // Applied as one change: the folders and ranges as the commands make them, the map the same.
  const id = await ops.apply(planOf(d));
  const applied = snapshot(root);
  const folders = () => readdirSync(join(root, "map", "terrain"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(folders(), ["a1", "a2", "b0", "b1", "b2", "mid", "south_west"]);
  assert.deepEqual(changedFiles(before, applied).filter((f) => !p.written.includes(f) && !p.removed.includes(f)), [], "what the preview said, nothing else");
  assert.deepEqual(await loaded(w3), whole);
  // Undo: every file as before; refused while something is unsaved; Redo: as applied.
  const unsaved = w3.editors.unsavedPaths;
  (w3.editors as { unsavedPaths: () => string[] }).unsavedPaths = () => ["map/war3map.w3i.json"];
  await assert.rejects(ops.undo(id, false), /save or discard the changes in map\/war3map.w3i.json first/);
  (w3.editors as { unsavedPaths: () => string[] }).unsavedPaths = unsaved;
  assert.deepEqual(changedFiles(applied, snapshot(root)), []);
  await ops.undo(id, false);
  assert.deepEqual(changedFiles(before, snapshot(root)), [], "undone: every file as before");
  assert.deepEqual(folders(), ["a0", "a1", "a2", "b0", "b1", "b2"]);
  await ops.undo(id, true);
  assert.deepEqual(changedFiles(applied, snapshot(root)), [], "redone: as applied");
  // An edit saved since: Undo is refused and changes nothing.
  await editTerrain(w3);
  const edited = snapshot(root);
  await assert.rejects(ops.undo(id, false), /changed since \(map\/terrain\/b2\/terrain\.txt\)/);
  assert.deepEqual(changedFiles(edited, snapshot(root)), []);
  // get_subterrains: the layout on disk (and no editor open here).
  const got = await getSubterrainsTool(w3);
  assert.deepEqual([got.layout, got.open.length, got.editor], ["split", 7, null]);
});

test("change_subterrains delete and preview, and a flat project's split by the grid: previewed, refused, applied", async () => {
  const { w3, root } = await bigSplit("layout-delete");
  const before = snapshot(root);
  // Delete b1: it joins the first neighbour that lines up with it (a1 below it: the same columns).
  const previewed = await changeSubterrainsTool(w3, { action: "delete", name: "b1", preview: true }) as { preview: boolean; plan: string[]; subterrains: { name: string; from: string[] }[] };
  assert.equal(previewed.preview, true);
  assert.deepEqual(previewed.plan, ["a0=a0:0,0,8,8", "a1=a1+b1:8,0,8,17", "a2=a2:16,0,9,8", "b0=b0:0,8,8,9", "b2=b2:16,8,9,9"]);
  assert.deepEqual(changedFiles(before, snapshot(root)), [], "a preview writes nothing");
  const done = await changeSubterrainsTool(w3, { action: "delete", name: "b1" }) as { subterrains: { name: string; h: number }[] };
  assert.deepEqual(done.subterrains.map((s) => [s.name, s.h]), [["a0", 8], ["a1", 17], ["a2", 8], ["b0", 9], ["b2", 9]]);
  await assert.rejects(changeSubterrainsTool(w3, { action: "delete", name: "nope" }), /no subterrain "nope"/);

  // A flat project: the grid's rectangles previewed (objects per subterrain), a refused grid, then split.
  const flatRoot = project("layout-flat");
  const fw3 = await open(flatRoot);
  const ops = layoutOps(fw3);
  const fs = await ops.readState();
  assert.deepEqual([fs.layout, fs.canvas, fs.subterrains], ["flat", [5, 3], []]);
  const flatBefore = snapshot(flatRoot);
  const rects = gridRects({ canvas: fs.canvas, xs: [2], ys: [1] });
  const p = await ops.previewSplit(rects);
  assert.deepEqual(p.subterrains.map((s) => s.name), ["sw", "se", "nw", "ne"]);
  assert.equal(p.subterrains.reduce((n, s) => n + s.units, 0), 1, "the mini map's footman");
  assert.ok(p.removed.includes("map/war3map.w3e.txt"));
  await assert.rejects(ops.previewSplit([{ name: "west", x: 0, y: 0, w: 2, h: 3 }]), /Split Terrain: .*would be lost/);
  assert.deepEqual(changedFiles(flatBefore, snapshot(flatRoot)), []);
  // The tool's split preview, and the single main of a grid without cuts.
  const tp = await changeSubterrainsTool(fw3, { action: "split", preview: true }) as { plan: string[]; subterrains: { name: string }[] };
  assert.deepEqual([tp.plan, tp.subterrains.map((s) => s.name)], [[], ["main"]]);
  assert.deepEqual(gridRects({ canvas: [5, 3], xs: [], ys: [] }).map((r) => r.name), ["main"]);
  await ops.split(rects);
  assert.ok(isSplit(fw3));
  assert.deepEqual((await ops.readState()).subterrains.map((s) => s.name), ["sw", "se", "nw", "ne"]);
  for (const f of FLAT_FILES) assert.equal(await fw3.workspace.readText(f), flatBefore.get(f), `${f} reads as it was`);
});

/** The workspace service behind a headless w3 (for externalChanges, which the extension API doesn't have). */
function workspaceOf(w3: W3Api) {
  const ws = workspaces.get(w3);
  if (!ws) throw new Error("not a headless w3 of this test");
  return ws;
}
