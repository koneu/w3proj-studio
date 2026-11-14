import assert from "node:assert/strict";
import { test } from "node:test";
import { BLIGHT, BLOCKED, generatePathing, NO_BUILD, NO_FLY, NO_WALK, NO_WATER } from "./pathing";
import type { Corner, Terrain } from "./w3e";

/** Flat dry ground of 4 × 4 tiles at layer 2, no ramps. */
function ground(): Terrain {
  const corners: Corner[] = [];
  for (let i = 0; i < 25; i++) corners.push({ layer: 2, ramp: false, height: 0, rawHeight: 0x2000, hasWater: false, water: -2137.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: 0, texExtra: 0 });
  return { version: 11, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], width: 5, height: 5, offsetX: 0, offsetY: 0, corners } as unknown as Terrain;
}

const corner = (t: Terrain, x: number, y: number) => t.corners[y * t.width + x];
/** The 16 cells of tile (tx, ty). */
function tile(t: Terrain, tx: number, ty: number): number[] {
  const p = generatePathing({ terrain: t, margins: [0, 0, 0, 0], tileRules: new Map() }), w = (t.width - 1) * 4;
  const out: number[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) out.push(p[16 + (ty * 4 + j) * w + tx * 4 + i]);
  return out;
}
const CLIFF = NO_WATER | BLOCKED | NO_BUILD | NO_WALK;

test("a cliff tile with ramp flags on only some corners is blocked, as the World Editor writes it", () => {
  // Autumn Leaves' west cliffs: stray ramp flags on two of a cliff tile's corners (layers 2/3 here).
  const t = ground();
  corner(t, 1, 0).layer = 3; corner(t, 1, 1).layer = 3;
  corner(t, 1, 1).ramp = true; corner(t, 0, 1).ramp = true;
  assert.deepEqual(tile(t, 0, 0), Array(16).fill(CLIFF));
  // Control: without the stray flags the same tile is the same cliff.
  corner(t, 1, 1).ramp = false; corner(t, 0, 1).ramp = false;
  assert.deepEqual(tile(t, 0, 0), Array(16).fill(CLIFF));
});

test("a ramp's middle corners stand half a layer above shallow water, as on Snoware Bay's sunken ramps", () => {
  // A ramp up the x axis over corners 0..2 (layer 2, 2, 3), all of it in water 40 deep by its stored heights.
  const t = ground();
  for (const k of t.corners) { k.hasWater = true; k.water = 40; }
  for (let y = 0; y <= 2; y++) for (let x = 0; x <= 2; x++) { corner(t, x, y).ramp = true; if (x === 2) corner(t, x, y).layer = 3; }
  // Tile (0, 0): the cells nearest corner x 1 (lifted 64, out of the water) are dry, those nearest x 0 are shore.
  const row = tile(t, 0, 0).slice(0, 4);
  assert.deepEqual(row, [NO_WATER | NO_BUILD, NO_WATER | NO_BUILD, NO_WATER, NO_WATER]);
  assert.deepEqual(tile(t, 0, 0).slice(14, 16), [NO_WATER, NO_WATER], "the top row's cells nearest corner (1, 1)");
  // A diagonal ramp (Ekrezem's Maze): corner (1, 1) has a ramp corner a layer up beside it too, and isn't lifted.
  corner(t, 1, 2).layer = 3;
  assert.deepEqual(tile(t, 0, 0).slice(14, 16), [NO_WATER | NO_BUILD, NO_WATER | NO_BUILD], "under water: shore");
  corner(t, 1, 2).layer = 2;
  // Control: without the ramp the whole tile is shallow water.
  for (const k of t.corners) k.ramp = false;
  for (let y = 0; y <= 2; y++) corner(t, 2, y).layer = 2;
  assert.deepEqual(tile(t, 0, 0).slice(0, 4), Array(4).fill(NO_BUILD));
});

test("a tile with the ramp flag on all four corners across one layer is walkable; across two it is a cliff", () => {
  // A ramp up the x axis: foot, middle, top (layers 2, 2, 3).
  const t = ground();
  for (let y = 0; y <= 1; y++) for (let x = 0; x <= 2; x++) { corner(t, x, y).ramp = true; if (x === 2) corner(t, x, y).layer = 3; }
  assert.deepEqual(tile(t, 1, 0), Array(16).fill(NO_WATER), "a ramp");
  corner(t, 2, 1).layer = 4;
  assert.deepEqual(tile(t, 1, 0), Array(16).fill(CLIFF), "two layers can't be a ramp");
});

test("a tile with all four ramp flags that rises a layer with no ramp foot past its low end is a cliff", () => {
  // Autumn Leaves' tile 17,17 (here 1,1): stray flags on 3 × 2 corners around a pit, layers 4 3 4 below 4 4 5.
  const t = ground();
  for (const k of t.corners) k.layer = 4;
  for (let y = 1; y <= 2; y++) for (let x = 1; x <= 3; x++) corner(t, x, y).ramp = true;
  corner(t, 2, 1).layer = 3; corner(t, 3, 2).layer = 5;
  assert.deepEqual(tile(t, 1, 1), Array(16).fill(CLIFF), "the pit's low corner has higher ramp corners on both sides");
  // Control: with the next corner out on the low layer too, the same tile is a ramp's upper half.
  corner(t, 3, 1).layer = 3;
  assert.deepEqual(tile(t, 1, 1), Array(16).fill(NO_WATER));
  // A lone flagged tile across a layer has no foot either.
  const lone = ground();
  corner(lone, 2, 1).layer = 3; corner(lone, 2, 2).layer = 3;
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) corner(lone, x, y).ramp = true;
  assert.deepEqual(tile(lone, 1, 1), Array(16).fill(CLIFF));
  corner(lone, 0, 1).ramp = true;
  assert.deepEqual(tile(lone, 1, 1), Array(16).fill(NO_WATER), "control: a foot corner on the low layer");
});

test("a tile whose lower-left corner is painted Boundary is blocked as the border is, whatever else it is", () => {
  // we-drive on the World Editor's saves (2026-11-14, spec boundary-wpm): 0xce on the 16 cells of the tile whose
  // lower-left corner is painted, over dry ground, a cliff and water alike (0xee with blight); its other tiles stay as
  // they were.
  const BORDER = BLOCKED | NO_WATER | NO_BUILD | NO_FLY | NO_WALK;
  assert.equal(BORDER, 0xce);
  const t = ground();
  corner(t, 1, 1).boundary = true;
  assert.deepEqual(tile(t, 1, 1), Array(16).fill(BORDER));
  for (const [x, y] of [[0, 0], [1, 0], [0, 1]]) assert.deepEqual(tile(t, x, y), Array(16).fill(NO_WATER), `tile ${x},${y} has the corner as another of its four`);
  // Placing objects asks without it (doodads stand on Boundary).
  const free = generatePathing({ terrain: t, margins: [0, 0, 0, 0], tileRules: new Map(), boundary: false });
  assert.equal(free[16 + 4 * 16 + 4], NO_WATER, "boundary: false leaves the tile as it is");
  // A cliff, water under the same tile: still the border's byte; blight stays on it (0xee).
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) corner(t, x, y).blight = true;
  assert.deepEqual(tile(t, 1, 1), Array(16).fill(BORDER | BLIGHT), "blight");
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) corner(t, x, y).blight = false;
  corner(t, 2, 2).layer = 3;
  assert.deepEqual(tile(t, 1, 1), Array(16).fill(BORDER), "a cliff");
  corner(t, 2, 2).layer = 2;
  for (const k of t.corners) { k.hasWater = true; k.water = 40; }
  assert.deepEqual(tile(t, 1, 1), Array(16).fill(BORDER), "water");
  // Control: Remove Boundary gives the water tile back.
  corner(t, 1, 1).boundary = false;
  assert.deepEqual(tile(t, 1, 1), Array(16).fill(NO_BUILD));
});

test("the water's depth is measured from the tileset's own surface", () => {
  // Ashenvale's water lies 76.8 below the stored level, not 89.6: 12.8 deeper than the corners' `water` says.
  const t = ground();
  for (const k of t.corners) { k.hasWater = true; k.water = 45; }
  const cell = (waterOffset?: number) => generatePathing({ terrain: t, margins: [0, 0, 0, 0], tileRules: new Map(), waterOffset })[16];
  assert.equal(cell(), NO_BUILD, "45 deep: shallow, walkable");
  assert.equal(cell(89.6), NO_BUILD, "the usual surface is the default");
  assert.equal(cell(76.8), NO_BUILD | NO_WALK, "57.8 deep on Ashenvale: past the 52 of deep water");
  assert.equal(cell(96), NO_BUILD, "38.6 deep on Dalaran");
});

test("a cliff doodad's blue opens the cliff and dry ground under it, leaves water, and its red blocks", () => {
  // Tile (0, 0) a cliff, (1, 0) dry, (2, 0) deep water; one texture 12 × 4 pixels, all blue, over the three, bottom
  // left on tile (0, 0) and unturned, as a special doodad is placed.
  const t = ground();
  corner(t, 0, 0).layer = 3;
  for (let x = 2; x <= 3; x++) for (let y = 0; y <= 1; y++) { corner(t, x, y).hasWater = true; corner(t, x, y).water = 60; }
  const paint = (w: number, h: number, rgb: [number, number, number]) => {
    const rgba: number[] = [];
    for (let i = 0; i < w * h; i++) rgba.push(...rgb, 255);
    return { x: w * 16, y: h * 16, angle: -Math.PI / 2, width: w, height: h, rgba };
  };
  const cells = (cliffDoodad: boolean, margins: [number, number, number, number] = [0, 0, 0, 0]) => {
    const p = generatePathing({ terrain: t, margins, tileRules: new Map(), stamps: [{ ...paint(12, 4, [0, 0, 255]), cliffDoodad }] });
    return (tx: number) => p[16 + tx * 4];
  };
  const cave = cells(true);
  assert.equal(cave(0), NO_BUILD, "the cliff is open ground");
  assert.equal(cave(1), NO_BUILD, "dry ground can't be built on");
  assert.equal(cave(2), NO_BUILD | NO_WALK, "deep water stays");
  // Control: a regular doodad's blue only adds no-build.
  const plain = cells(false);
  assert.equal(plain(0), CLIFF);
  assert.equal(plain(1), NO_WATER | NO_BUILD);
  assert.equal(plain(2), NO_BUILD | NO_WALK);
  // The map's unplayable border is written over it.
  assert.equal(cells(true, [1, 0, 0, 0])(0), BLOCKED | NO_WATER | NO_BUILD | NO_FLY | NO_WALK);
  // Red blocks, as anywhere.
  // On tile (1, 2):
  const red = generatePathing({ terrain: t, margins: [0, 0, 0, 0], tileRules: new Map(), stamps: [{ ...paint(4, 4, [255, 0, 0]), x: 192, y: 320, cliffDoodad: true }] });
  assert.equal(red[16 + 8 * 16 + 4], NO_WATER | BLOCKED | NO_WALK);
  assert.equal(red[16 + 11 * 16 + 7], NO_WATER | BLOCKED | NO_WALK);
  assert.equal(red[16 + 12 * 16 + 4], NO_WATER, "control: the tile above is open");
});

test("a ramp side piece's flat tile is blocked beside a ramp or a cliff, walkable beside stray ramp flags", () => {
  // Autumn Leaves' tile 17,32: a side piece (tiles 0..1 × 0) under a row of ramp flags (corners 0..2 × 1, layers
  // 3, 2, 2) with no ramp tile above it and low ground all along its far side. The flat tile (1, 0) stays walkable.
  const t = ground();
  corner(t, 0, 1).layer = 3;
  for (let x = 0; x <= 2; x++) corner(t, x, 1).ramp = true;
  assert.deepEqual(tile(t, 0, 0), Array(16).fill(CLIFF), "the side piece's cliff tile");
  assert.deepEqual(tile(t, 1, 0), Array(16).fill(NO_WATER), "its flat tile");
  // Mount Hyjal: a ramp tile (1, 1) across the ramp edge from it blocks the flat tile.
  corner(t, 1, 2).ramp = true; corner(t, 2, 2).ramp = true;
  assert.deepEqual(tile(t, 1, 0), Array(16).fill(CLIFF), "beside a ramp");
  corner(t, 1, 2).ramp = false; corner(t, 2, 2).ramp = false;
  // Autumn Leaves' tile 15,25: the far side a cliff one layer high blocks it too.
  corner(t, 0, 0).layer = 3;
  assert.deepEqual(tile(t, 1, 0), Array(16).fill(CLIFF), "beside a cliff");
});
