import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Corner, Terrain } from "../../lib/terrain/w3e";
import { buildPathingMap, loadPathingData, specialsOf } from "./pathmap";
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

const ROCK = "PathTextures\\Rock.tga", GONE = "war3mapImported\\Gone.tga", HERE = "war3mapImported\\Here.tga", FLOOR = "PathTextures\\8x4Floor.tga";

/** A game with a rock (its own pathing texture) and a flower (none), and a map whose object data gives custom rocks
 *  and a custom flower imported textures: one that is there, two that aren't. */
function project() {
  const game: Record<string, string> = {
    "TerrainArt\\Terrain.slk": slk([["tileID", "walkable", "flyable", "buildable"], ["Ldrt", "1", "1", "1"]]),
    "Doodads\\Doodads.slk": slk([["doodID", "pathTex"], ["LOrk", ROCK], ["LFlw", "_"], ["YCx7", FLOOR]]),
    "Units\\DestructableData.slk": slk([["DestructableID", "pathTex", "walkable"]]),
    "TerrainArt\\Water.slk": slk([["waterID", "height"], ["LSha", "-0.7"], ["ASha", "-0.6"]]),
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
  const files: Record<string, Uint8Array> = { [ROCK]: whiteTga(4, 4), [HERE]: whiteTga(2, 2), [FLOOR]: whiteTga(8, 4) };
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

test("a special doodad's texture lies unturned with its bottom left on its tile", async () => {
  const { w3, read } = project();
  const t = ground();
  // A ruined floor (YCx7's 16 × 8 texture, here 8 × 4: two tiles wide, one high) at tile (2, 3).
  const blocked = (wpm: Uint8Array) => {
    const out: string[] = [];
    for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) if (wpm[16 + y * 28 + x] & 0x02) out.push(`${x},${y}`);
    return out;
  };
  const none = await buildPathingMap(w3, t, [], read);
  assert.deepEqual(blocked(none.wpm), [], "control: open ground");
  const floor = await buildPathingMap(w3, t, [], read, undefined, [{ id: "YCx7", x: 2, y: 3 }]);
  const want: string[] = [];
  for (let y = 12; y < 16; y++) for (let x = 8; x < 16; x++) want.push(`${x},${y}`);
  assert.deepEqual(blocked(floor.wpm), want);
  assert.deepEqual(floor.missing, []);
  // Ids the game doesn't have, and destructables, leave nothing.
  assert.deepEqual(blocked((await buildPathingMap(w3, t, [], read, undefined, [{ id: "Zzzz", x: 2, y: 3 }])).wpm), []);
});

test("specialsOf takes the special doodads of a doodad file and leaves out broken entries", () => {
  assert.deepEqual(specialsOf({ specials: [{ id: "YCx7", z: 0, x: 13, y: 24 }, { id: 5, x: 1, y: 1 }, { id: "LCc0", x: 1.5, y: 2 }, null] }),
    [{ id: "YCx7", z: 0, x: 13, y: 24 }]);
  assert.deepEqual(specialsOf({}), []);
  assert.deepEqual(specialsOf(null), []);
  assert.deepEqual(specialsOf({ specials: "x" }), []);
});

test("deep water is measured from the tileset's water surface (the game's water table)", async () => {
  const { w3, read } = project();
  const data = await loadPathingData(w3, read);
  assert.ok(Math.abs(data.waterOffset("L")! - 89.6) < 1e-9);
  assert.ok(Math.abs(data.waterOffset("A")! - 76.8) < 1e-9);
  assert.equal(data.waterOffset("Z"), undefined, "not in the table: the default");
  // Water 45 over the ground by the usual surface: shallow (0x08). Ashenvale's lies 12.8 higher: deep (no walk, 0x0a).
  const lake = (tileset: string) => {
    const t = ground();
    (t as { tileset: string }).tileset = tileset;
    for (const k of t.corners) { k.hasWater = true; k.water = 45; }
    return t;
  };
  const cell = async (tileset: string) => (await buildPathingMap(w3, lake(tileset), [], read)).wpm[16 + 3 * 28 + 3];
  assert.equal(await cell("L"), 0x08);
  assert.equal(await cell("Z"), 0x08);
  assert.equal(await cell("A"), 0x0a);
});
