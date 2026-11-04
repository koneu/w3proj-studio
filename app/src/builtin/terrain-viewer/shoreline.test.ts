import assert from "node:assert/strict";
import { test } from "node:test";
import type { Corner, Terrain } from "../../lib/terrain/w3e";
import { planShoreline } from "./shoreline";

const MODELS = { straight: "S", outside: "O", inside: "I" };

/** A 6×6-corner map, ground at 0; `under` corners get water 40 deep, the rest are dry. */
function map(under: (x: number, y: number) => boolean, allWater = false): Terrain {
  const width = 6, height = 6;
  const corners: Corner[] = Array.from({ length: width * height }, (_, i) => {
    const x = i % width, y = Math.floor(i / width), wet = under(x, y);
    return {
      height: 0, water: wet ? 40 : -50, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 15, layer: 2,
      ramp: false, blight: false, hasWater: wet || allWater, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
    };
  });
  return { version: 11, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: [], cliffTiles: [], width, height, offsetX: 0, offsetY: 0, corners, trailer: new Uint8Array(0) };
}

/** Instances as "model@tileX,tileY:degrees". */
function placed(t: Terrain) {
  return planShoreline(t, MODELS).flatMap((r) => r.instances.map((i) => {
    const raw = Math.round((Math.atan2(i.world[1], i.world[0]) * 180) / Math.PI);
    const deg = raw === -180 ? 180 : raw;
    return `${r.path}@${(i.world[12] - 64) / 128},${(i.world[13] - 64) / 128}:${deg}`;
  })).sort();
}

test("a square lake: straight pieces face the land, inside corners face the water", () => {
  const t = map((x, y) => x >= 2 && x <= 3 && y >= 2 && y <= 3);
  assert.deepEqual(placed(t), [
    // Inside corners on the diagonal tiles, each turned so its water corner (made for −X +Y) points at the lake.
    "I@1,1:-90", "I@1,3:180", "I@3,1:0", "I@3,3:90",
    // Straight pieces on the side tiles, land (made for −X) pointing away from the lake.
    "S@1,2:0", "S@2,1:90", "S@2,3:-90", "S@3,2:180",
  ].sort());
  // At the water level.
  assert.equal(planShoreline(t, MODELS)[0].instances[0].world[14], 40);
});

test("a one-corner island in water gets outside corners; dry tiles and open water nothing", () => {
  const t = map((x, y) => !(x === 2 && y === 2), true);
  assert.deepEqual(placed(t), ["O@1,1:-90", "O@1,2:180", "O@2,1:0", "O@2,2:90"].sort());
  assert.deepEqual(placed(map(() => false)), []);
  assert.deepEqual(placed(map(() => true)), []);
});
