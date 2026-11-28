import assert from "node:assert/strict";
import { test } from "node:test";
import type { Settings, W3Api } from "../../extensions/api";
import { markImport } from "../../lib/modecache";
import type { Terrain } from "../../lib/terrain/w3e";
import { GameService } from "../../workbench/game";
import { importScope } from "./filewatch";
import { minimapBase } from "./minimapgen";
import { newTerrain, type NewMapOptions } from "./newmap";
import { loadSkins, type Placed } from "./objects";
import { clearShadowMeshes, predictShadows } from "./shadowmap";
import { terrainShadows } from "./shadows";
import { towerModel } from "../../lib/testhelpers/tower";

// What a cache made from the game's files keeps, and what it must not: a file the map imports under a game path.

const slk = (rows: string[][]) => ["ID;PWXL;N;E", ...rows.flatMap((row, y) => row.map((v, x) => `C;X${x + 1};Y${y + 1};K"${v}"`)), "E"].join("\r\n");
const tables: Record<string, string> = {
  "TerrainArt\\Terrain.slk": slk([["tileID", "dir", "file"], ...["Ha01", "Ha02", "Ha03", "Ha04", "Ha05"].map((id) => [id, "TerrainArt\\Cache", "Cache_Grass"])]),
  "TerrainArt\\CliffTypes.slk": slk([["cliffID", "texDir", "texFile"]]),
  "TerrainArt\\Water.slk": slk([["waterID", "height", "mmAlpha", "mmRed", "mmGreen", "mmBlue"], ["HSha", "-0.7", "64", "0", "0", "192"]]),
  "Doodads\\Doodads.slk": slk([["doodID"]]),
  "Units\\DestructableData.slk": slk([["DestructableID"]]),
};
function tgaOf([r, g, b]: number[]): Uint8Array {
  const t = new Uint8Array(18 + 4);
  t[2] = 2; t[12] = 1; t[14] = 1; t[16] = 32; t[17] = 0x28;
  t.set([b, g, r, 255], 18);
  return t;
}
const GRASS = "TerrainArt\\Cache\\Cache_Grass.blp";
const gameGrass: [number, number, number] = [44, 108, 27];
const terrain2 = (id: string): Terrain => {
  const width = 3, height = 3;
  const corners = Array.from({ length: width * height }, () => ({ texture: 0, layer: 2, height: 0, water: 0, hasWater: false }));
  return { width, height, offsetX: 0, offsetY: 0, corners, groundTiles: [id], cliffTiles: [], tileset: "H" } as unknown as Terrain;
};
const mapW3 = () => ({
  settings: { get: (k: string) => (k === "game.graphicsMode" ? "sd" : undefined) },
  game: { readText: async (p: string) => tables[p] ?? assert.fail(`no ${p}`) }, workspace: { files: () => [] },
}) as unknown as W3Api;

/** A reader as projectfiles.readFile: the project's import when it has one under the path, else the game's file. */
function reader(imports: Map<string, number[]>, reads: string[]) {
  return async (p: string): Promise<Uint8Array> => {
    reads.push(p);
    const own = imports.get(p);
    if (own) return markImport(tgaOf(own));
    return tgaOf(gameGrass);
  };
}

test("minimap tile colours: project A's import under a game path isn't used for project B, and a changed import is read again; the game's colour stays", async () => {
  // Each case has a tile id of its own: the cache is by id (and mode), kept for the process.
  const tile = async (id: string, read: (p: string) => Promise<Uint8Array>) => (await minimapBase(mapW3(), terrain2(id), [], read)).tileColor(id);
  const gameReads: string[] = [];
  // Project B opened first, no import: the game's colour, kept.
  assert.deepEqual(await tile("Ha01", reader(new Map(), gameReads)), gameGrass);
  const afterFirst = gameReads.length;
  assert.deepEqual(await tile("Ha01", reader(new Map(), gameReads)), gameGrass);
  assert.equal(gameReads.length, afterFirst, "a game-file colour is kept: no second read");

  // Project A imports a texture under the game's path; project B (the same tile id) has none.
  assert.deepEqual(await tile("Ha02", reader(new Map([[GRASS, [1, 2, 3]]]), [])), [1, 2, 3], "project A: its own import");
  const b: string[] = [];
  assert.deepEqual(await tile("Ha02", reader(new Map(), b)), gameGrass, "project B: the game's texture, not A's import");
  assert.ok(b.length > 0, "B read it");

  // The import changed in the same project: read again.
  assert.deepEqual(await tile("Ha04", reader(new Map([[GRASS, [10, 20, 30]]]), [])), [10, 20, 30]);
  assert.deepEqual(await tile("Ha04", reader(new Map([[GRASS, [40, 50, 60]]]), [])), [40, 50, 60], "the changed import");
  assert.deepEqual(await tile("Ha04", reader(new Map(), [])), gameGrass, "the import removed");
});

test("game.reload empties the minimap's tile colours", async () => {
  const settings = { get: () => undefined, onDidChange: () => ({ dispose() {} }) } as unknown as Settings;
  const game = new GameService(settings);
  const reads: string[] = [];
  const read = reader(new Map(), reads);
  const tile = async () => (await minimapBase(mapW3(), terrain2("Ha05"), [], read)).tileColor("Ha05");
  await tile();
  const first = reads.length;
  await tile();
  assert.equal(reads.length, first, "kept (the control: without a reload nothing is read again)");
  game.reload();
  await tile();
  assert.ok(reads.length > first, "read again after the reload");
});

test("shadow meshes: a model the map imports under a game path isn't kept for another project or after it changed", async () => {
  clearShadowMeshes();
  const size = 16;
  const flat = newTerrain({ width: size, height: size, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  const ground = terrainShadows(flat);
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[Zimp]\nfile=Doodads\\ImportCache\\Rock\nshadow=1",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const mode = "sd-import-cache-test";
  const skins = await loadSkins({ settings: { get: () => mode }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api);
  const at: Placed = { id: "Zimp", variation: 0, position: [flat.offsetX + 8 * 128, flat.offsetY + 8 * 128, 0], angle: 0, scale: [1, 1, 1] };
  const cells = (m: Uint8Array) => m.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0);
  const predict = (read: (p: string) => Promise<Uint8Array>) => predictShadows(flat, [at], skins, () => undefined, read, undefined, undefined, () => mode);
  let gameReads = 0;
  const game = async () => { gameReads++; return towerModel(0, 300); };
  const own = (h: number) => async () => markImport(towerModel(0, h));

  // Project A imports a tall model under the path; project B has the game's short one.
  const a = cells(await predict(own(1500)));
  const b = cells(await predict(game));
  assert.ok(a > b, `the control: the import casts more than the game's model (${a}, ${b})`);
  assert.equal(gameReads, 1, "project B read the game's model, not A's import");
  // The import changed (same project): read again, as well as the one removed.
  assert.ok(cells(await predict(own(600))) < a, "the changed import");
  assert.equal(cells(await predict(game)), b);
  // The game's model stays kept.
  assert.equal(gameReads, 1, "a game-file mesh is kept: not read again");
});

test("importScope differs for another project and for an import added, removed or renamed, not for other files", () => {
  const files = (...p: string[]) => p.map((path) => ({ path }));
  const base = importScope("/a", files("map/war3map.w3e", "map/war3mapImported/x.mdx"));
  assert.equal(importScope("/a", files("map/war3mapImported/x.mdx", "map/war3map.w3e", "map/war3map.shd")), base, "other files and the order don't count");
  assert.notEqual(importScope("/b", files("map/war3mapImported/x.mdx")), base, "another project");
  assert.notEqual(importScope("/a", files()), base, "removed");
  assert.notEqual(importScope("/a", files("map/war3mapImported/x.mdx", "map/Units/Human/y.blp")), base, "added");
  assert.notEqual(importScope("/a", files("map/war3mapImported/z.mdx")), base, "renamed");
});
