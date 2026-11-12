import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWaterOffsets, parseW3e, waterLevelAt, waterSurfaceAt, writeW3e, WATER_OFFSET, type Corner, type Terrain } from "../../lib/terrain/w3e";
import { applyTilesetWater } from "./wateroffset";

/** A 2x2-corner terrain of tileset `tileset` with ground at -100 and every corner holding water word 0x2000 + 4 * 200. */
function lake(tileset: string): Terrain {
  const corners: Corner[] = [];
  for (let i = 0; i < 4; i++) {
    corners.push({
      height: -100, water: 200 - WATER_OFFSET, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 15, layer: 2, ramp: false, blight: false,
      hasWater: true, boundary: false, rawHeight: 0x2000 - 400, rawWater: 0x2000 + 800, texExtra: 0,
    });
  }
  return {
    version: 11, tileset, customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Adrt"], cliffTiles: [], width: 2, height: 2,
    offsetX: 0, offsetY: 0, corners, trailer: new Uint8Array(0),
  };
}

function slk(rows: string[][]) {
  const out = ["ID;PWXL;N;E"];
  rows.forEach((row, y) => row.forEach((v, x) => { if (v !== "") out.push(`C;X${x + 1};Y${y + 1};K"${v}"`); }));
  return [...out, "E"].join("\r\n");
}
const game = (water: string | Error) => ({ game: { readText: async () => { if (water instanceof Error) throw water; return water; } } });
const WATER = slk([["waterID", "height"], ["LSha", "-0.7"], ["ASha", "-0.6"], ["XSha", "oops"]]);

test("a tileset's water offset is its Water.slk height times -128", () => {
  const offs = parseWaterOffsets([{ waterID: "ASha", height: "-0.6" }, { waterID: "LSha", height: "-0.7" }, { waterID: "XSha", height: "" }, { waterID: "Bad", height: "-1" }]);
  assert.ok(Math.abs(offs.get("A")! - 76.8) < 1e-9);
  assert.ok(Math.abs(offs.get("L")! - 89.6) < 1e-9);
  assert.equal(offs.has("X"), false, "no height");
  assert.equal(offs.has("B"), false, "not a shallow-water row");
});

test("Ashenvale's water lies 76.8 under its stored level, the surface included; the stored bytes stay", async () => {
  const t = lake("A");
  const bytes = writeW3e(t);
  const read = parseW3e(bytes);
  assert.ok(Math.abs(read.corners[0].water - (200 - 89.6)) < 1e-9, "read with the default first");
  await applyTilesetWater(game(WATER), read);
  assert.ok(Math.abs(read.corners[0].water - (200 - 76.8)) < 1e-9);
  assert.ok(Math.abs(waterSurfaceAt(read, 64, 64)! - (200 - 76.8)) < 1e-9, "the drawn surface");
  assert.deepEqual(writeW3e(read), bytes, "unchanged file");
  assert.equal(waterLevelAt(200 - 76.8, read.waterOffset), 0x2000 + 800, "a tool writes the level that reads back as that surface");
  await applyTilesetWater(game(WATER), read);
  assert.ok(Math.abs(read.corners[0].water - (200 - 76.8)) < 1e-9, "applying twice changes nothing more");
});

test("a Lordaeron-like tileset keeps 89.6; a missing, unreadable or heightless Water.slk too", async () => {
  for (const [letter, water] of [["L", WATER], ["A", new Error("not found")], ["A", "garbage"], ["X", WATER], ["Q", WATER]] as const) {
    const t = parseW3e(writeW3e(lake(letter)));
    await applyTilesetWater(game(water), t);
    assert.ok(Math.abs(t.corners[0].water - (200 - 89.6)) < 1e-9, `${letter} ${String(water).slice(0, 12)}`);
  }
});
