import assert from "node:assert/strict";
import { test } from "node:test";
import type { Settings, W3Api } from "../extensions/api";
import type { Terrain } from "../lib/terrain/w3e";
import { minimapBase } from "../builtin/terrain-viewer/minimapgen";
import { GameService } from "./game";

const slk = (rows: string[][]) => ["ID;PWXL;N;E", ...rows.flatMap((row, y) => row.map((v, x) => `C;X${x + 1};Y${y + 1};K"${v}"`)), "E"].join("\r\n");
const tables: Record<string, string> = {
  "TerrainArt\\Terrain.slk": slk([["tileID", "dir", "file"], ["Ha05", "TerrainArt\\Cache", "Cache_Grass"]]),
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
const terrain = (): Terrain => {
  const width = 3, height = 3;
  const corners = Array.from({ length: width * height }, () => ({ texture: 0, layer: 2, height: 0, water: 0, hasWater: false }));
  return { width, height, offsetX: 0, offsetY: 0, corners, groundTiles: ["Ha05"], cliffTiles: [], tileset: "H" } as unknown as Terrain;
};
const w3 = () => ({
  settings: { get: (k: string) => (k === "game.graphicsMode" ? "sd" : undefined) },
  game: { readText: async (p: string) => tables[p] ?? assert.fail(`no ${p}`) }, workspace: { files: () => [] },
}) as unknown as W3Api;

test("game.reload empties the minimap's tile colours", async () => {
  const settings = { get: () => undefined, onDidChange: () => ({ dispose() {} }) } as unknown as Settings;
  const game = new GameService(settings);
  const reads: string[] = [];
  const read = async (p: string) => { reads.push(p); return tgaOf([44, 108, 27]); };
  const tile = async () => (await minimapBase(w3(), terrain(), [], read)).tileColor("Ha05");
  await tile();
  const first = reads.length;
  await tile();
  assert.equal(reads.length, first, "kept (the control: without a reload nothing is read again)");
  game.reload();
  await tile();
  assert.ok(reads.length > first, "read again after the reload");
});

