import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCKED, generatePathing, NO_BUILD, NO_WALK, NO_WATER } from "./pathing";
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

test("a tile with the ramp flag on all four corners across one layer is walkable; across two it is a cliff", () => {
  const t = ground();
  corner(t, 1, 0).layer = 3; corner(t, 1, 1).layer = 3;
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) corner(t, x, y).ramp = true;
  assert.deepEqual(tile(t, 0, 0), Array(16).fill(NO_WATER), "a ramp");
  corner(t, 1, 1).layer = 4;
  assert.deepEqual(tile(t, 0, 0), Array(16).fill(CLIFF), "two layers can't be a ramp");
});
