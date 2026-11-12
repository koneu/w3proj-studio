import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Corner, Terrain } from "../../lib/terrain/w3e";
import { buildPathingMap, loadPathingData } from "./pathmap";
import type { Placed } from "./objects";

function slk(rows: string[][]) {
  const out = ["ID;PWXL;N;E"];
  rows.forEach((row, y) => row.forEach((v, x) => { if (v !== "") out.push(`C;X${x + 1};Y${y + 1};K"${v}"`); }));
  return [...out, "E"].join("\r\n");
}

/** A white (blocks everything) uncompressed TGA of w x h pixels. */
function whiteTga(w: number, h: number): Uint8Array {
  const b = new Uint8Array(18 + w * h * 3).fill(255);
  b.fill(0, 0, 18);
  b[2] = 2; b[12] = w; b[14] = h; b[16] = 24; b[17] = 0x20;
  return b;
}

/** Flat dry ground of 8x8 corners. */
function ground(): Terrain {
  const corners: Corner[] = [];
  for (let i = 0; i < 64; i++) corners.push({ layer: 2, ramp: false, height: 0, rawHeight: 0x2000, hasWater: false, water: -2137.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: 0, texExtra: 0 });
  return { version: 11, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], width: 8, height: 8, offsetX: 0, offsetY: 0, corners } as unknown as Terrain;
}

const ROCK = "PathTextures\\Rock.tga", GONE = "war3mapImported\\Gone.tga", HERE = "war3mapImported\\Here.tga";

/** A game with a rock (its own pathing texture) and a flower (none), and a map whose object data gives custom rocks
 *  and a custom flower imported textures: one that is there, two that aren't. */
function project() {
  const game: Record<string, string> = {
    "TerrainArt\\Terrain.slk": slk([["tileID", "walkable", "flyable", "buildable"], ["Ldrt", "1", "1", "1"]]),
    "Doodads\\Doodads.slk": slk([["doodID", "pathTex"], ["LOrk", ROCK], ["LFlw", "_"]]),
    "Units\\DestructableData.slk": slk([["DestructableID", "pathTex", "walkable"]]),
  };
  const mod = (value: string) => [{ field: "dptx", type: "string", value }];
  const w3d = JSON.stringify({ custom: [
    { base: "LOrk", id: "D000", mods: mod(GONE) },
    { base: "LOrk", id: "D001", mods: mod(HERE) },
    { base: "LFlw", id: "D002", mods: mod(GONE) },
  ] });
  const w3 = {
    game: { readText: async (p: string) => { if (p in game) return game[p]; throw new Error(`not found: ${p}`); } },
    workspace: {
      files: () => [{ path: "map/war3map.w3d.json" }],
      readText: async (p: string) => { if (p === "map/war3map.w3d.json") return w3d; throw new Error(`not found: ${p}`); },
      project: () => ({ root: "/maps/M" }),
    },
    backend: { invoke: async () => { throw new Error("no backend"); } },
  } as unknown as W3Api;
  const files: Record<string, Uint8Array> = { [ROCK]: whiteTga(4, 4), [HERE]: whiteTga(2, 2) };
  const read = async (p: string) => { if (p in files) return files[p]; throw new Error(`not found: ${p}`); };
  return { w3, read };
}

const at = (id: string, x: number, y: number): Placed => ({ id, variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1], flags: 2 } as Placed);

test("a doodad whose imported pathing texture isn't found blocks by its type's own texture", async () => {
  const { w3, read } = project();
  const data = await loadPathingData(w3, read);
  assert.deepEqual(data.placedTex("D000"), { path: GONE, fallback: ROCK, dest: false, walkable: false });
  assert.deepEqual(data.placedTex("LOrk"), { path: ROCK, dest: false, walkable: false }, "the game's own: nothing to fall back to");
  const gone = await data.placedImage(data.placedTex("D000")!);
  assert.equal(gone.fellBackTo, ROCK);
  assert.equal(gone.image?.width, 4, "the type's texture");
  const here = await data.placedImage(data.placedTex("D001")!);
  assert.equal(here.image?.width, 2, "an import that is there is used");
  assert.equal(here.fellBackTo, undefined);

  const t = ground();
  const empty = await buildPathingMap(w3, t, [], read);
  const rock = await buildPathingMap(w3, t, [at("D000", 448, 448)], read);
  assert.notDeepEqual(rock.wpm, empty.wpm, "it blocks");
  assert.deepEqual(rock.wpm, (await buildPathingMap(w3, t, [at("LOrk", 448, 448)], read)).wpm, "as the game's rock does");
  assert.deepEqual(rock.fellBack, [[GONE, ROCK]]);
  assert.deepEqual(rock.missing, []);
});

test("with no texture of its type to fall back to, it doesn't block, and that is reported", async () => {
  const { w3, read } = project();
  const t = ground();
  const flower = await buildPathingMap(w3, t, [at("D002", 448, 448)], read);
  assert.deepEqual(flower.missing, [GONE]);
  assert.deepEqual(flower.fellBack, []);
  assert.deepEqual(flower.wpm, (await buildPathingMap(w3, t, [], read)).wpm);
});
