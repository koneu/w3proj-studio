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

test("a square lake: straight pieces face the land, inside corners face the water, on the lake's −X and −Y sides", () => {
  const t = map((x, y) => x >= 2 && x <= 3 && y >= 2 && y <= 3);
  assert.deepEqual(placed(t), [
    // The inside corner on the diagonal tile, turned so its water corner (made for −X +Y) points at the lake.
    "I@1,1:-90",
    // Straight pieces on the side tiles, land (made for −X) pointing away from the lake.
    "S@1,2:0", "S@2,1:90",
    // None on the +X and +Y sides (the World Editor's pools and river, we-drive): their tiles' +X +Y corner is dry.
  ].sort());
  // At the water level.
  assert.equal(planShoreline(t, MODELS)[0].instances[0].world[14], 40);
});

test("a one-corner island in water gets outside corners; dry tiles and open water nothing", () => {
  const t = map((x, y) => !(x === 2 && y === 2), true);
  assert.deepEqual(placed(t), ["O@1,2:180", "O@2,1:0", "O@2,2:90"].sort(), "not the tile whose +X +Y corner is the dry one");
  assert.deepEqual(placed(map(() => false)), []);
  assert.deepEqual(placed(map(() => true)), []);
});

test("the map's wave flags: rolling shores (no cliff) and cliff shores separately", () => {
  const lake = map((x, y) => x >= 2 && x <= 3 && y >= 2 && y <= 3);
  assert.equal(planShoreline(lake, MODELS, { cliffShores: true, rollingShores: false }).length, 0);
  assert.equal(planShoreline(lake, MODELS, { cliffShores: false, rollingShores: true }).flatMap((r) => r.instances).length, 3);
  // The lake's land one layer up: cliff tiles now, so only "cliff shores" matters.
  for (const c of lake.corners) if (!c.hasWater) c.layer = 3;
  assert.equal(planShoreline(lake, MODELS, { cliffShores: false, rollingShores: true }).length, 0);
  assert.equal(planShoreline(lake, MODELS, { cliffShores: true, rollingShores: false }).flatMap((r) => r.instances).length, 3);
});

test("water too shallow for waves: the editor's pools got none up to 23 deep and waves from 26 on", () => {
  const pool = (depth: number) => {
    const t = map((x, y) => x >= 2 && x <= 3 && y >= 2 && y <= 3);
    for (const c of t.corners) if (c.hasWater) c.water = depth;
    return placed(t).length;
  };
  for (const depth of [8, 16, 20, 23]) assert.equal(pool(depth), 0, `${depth} deep`);
  for (const depth of [26, 29, 31, 48, 96]) assert.equal(pool(depth), 3, `${depth} deep`);
  // Map 03's lake: its last wet corner 21 deep, the next 74: the waves stand between those two, not at the dry corner.
  const lake = map((x) => x >= 2, true);
  lake.corners.forEach((c, i) => { const x = i % 6; c.water = x === 2 ? 21 : x > 2 ? 74 : -50; });
  assert.deepEqual([...new Set(placed(lake).map((p) => p.split("@")[1].split(",")[0]))], ["2"]);
});
