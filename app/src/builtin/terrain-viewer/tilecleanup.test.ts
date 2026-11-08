import assert from "node:assert/strict";
import { test } from "node:test";
import { setGroundHeight, type Terrain } from "../../lib/terrain/w3e";
import type { CliffType } from "./cliffs";
import { applyTileList, planRemoval, tileUse, unusedTiles } from "./tilecleanup";

const type = (cliffID: string, groundTile: string) => ({ cliffID, groundTile, cliffModelDir: "Cliffs", rampModelDir: "CliffTrans", texDir: "", texFile: "" }) as CliffType;
const TYPES = new Map([type("CLdi", "Ldrt"), type("CLgr", "Lgrs"), type("CLro", "Lrok")].map((c) => [c.cliffID, c]));

/** 8 × 8 tiles of Lgrs at level 2. Ldrt, Lrok and Lgrd (no cliff type) are in the list; cliff types 0..2 are CLdi,
 *  CLgr, CLro in list order. */
function flat(groundTiles = ["Ldrt", "Lgrs", "Lrok", "Lgrd"]): Terrain {
  const width = 9, height = 9;
  return {
    version: 12, tileset: "L", customTilesets: true, customTilesetsRaw: 1, groundTiles, cliffTiles: ["CLdi", "CLgr", "CLro"],
    width, height, offsetX: 0, offsetY: 0, trailer: new Uint8Array(0),
    corners: Array.from({ length: width * height }, () => {
      const c = {
        height: 0, water: 0, texture: 1, variation: 0, cliffVariation: 0, cliffTexture: 15, layer: 2,
        ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
      };
      setGroundHeight(c, 0);
      return c;
    }),
  };
}
const corner = (t: Terrain, x: number, y: number) => t.corners[y * t.width + x];
/** A one-corner mesa at (4, 4) whose four cliff tiles (bottom-left corners (3,3), (4,3), (3,4), (4,4)) are of
 *  cliff type `cliff`. */
function mesa(t: Terrain, cliff: number) {
  corner(t, 4, 4).layer = 3;
  for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) corner(t, x, y).cliffTexture = cliff;
}

test("a tile is in use where corners show it, or where a cliff is made of it", () => {
  const t = flat();
  corner(t, 0, 0).texture = 3;
  mesa(t, 0);
  const use = tileUse(t, TYPES);
  assert.deepEqual(use.ground, [0, 80, 0, 1]);
  assert.deepEqual(use.cliffs, [4, 0, 0, 0], "Ldrt's cliff type makes the mesa");
  assert.deepEqual(unusedTiles(use), [2], "only Lrok: Ldrt is a cliff, Lgrd a corner");
});

test("cliff type 15 (or one past the list) is the first type, as the renderer draws it", () => {
  const t = flat();
  mesa(t, 15);
  assert.deepEqual(tileUse(t, TYPES).cliffs, [4, 0, 0, 0]);
  const u = flat();
  mesa(u, 9);
  assert.deepEqual(tileUse(u, TYPES).cliffs, [4, 0, 0, 0]);
});

test("flat ground and ramps are no cliffs; without the cliff types nothing counts as one", () => {
  const t = flat();
  for (const c of t.corners) c.cliffTexture = 2;
  assert.deepEqual(tileUse(t, TYPES).cliffs, [0, 0, 0, 0]);
  mesa(t, 2);
  assert.deepEqual(tileUse(t, new Map()).cliffs, [0, 0, 0, 0]);
});

test("removing used tiles needs a replacement that stays", () => {
  const t = flat();
  mesa(t, 0);
  const use = tileUse(t, TYPES);
  assert.throws(() => planRemoval(t.groundTiles, [1], new Map(), use), /Lgrs is in use \(81 corners, 0 cliff tiles\)/);
  assert.throws(() => planRemoval(t.groundTiles, [0], new Map(), use), /Ldrt is in use \(0 corners, 4 cliff tiles\)/);
  assert.throws(() => planRemoval(t.groundTiles, [1, 2], new Map([[1, 2]]), use), /is removed too/);
  assert.throws(() => planRemoval(t.groundTiles, [1], new Map([[1, 7]]), use), /isn't in the list/);
  assert.throws(() => planRemoval(t.groundTiles, [0, 1, 2, 3], new Map([[0, 1], [1, 0]]), use), /at least one ground tile/);
  assert.throws(() => planRemoval(t.groundTiles, [4], new Map(), use), /no ground tile 4/);
  assert.throws(() => planRemoval(t.groundTiles, [], new Map(), use), /No ground tile/);
  // Control: the same with what's needed goes through.
  assert.deepEqual(planRemoval(t.groundTiles, [1, 2], new Map([[1, 3]]), use).tiles, ["Ldrt", "Lgrd"]);
});

test("the unused tiles go, the rest keep their corners under new indices", () => {
  const t = flat();
  corner(t, 0, 0).texture = 3;
  const before = t.corners.map((c) => t.groundTiles[c.texture]);
  const plan = planRemoval(t.groundTiles, unusedTiles(tileUse(t, TYPES)), new Map(), tileUse(t, TYPES));
  assert.deepEqual(plan.removed, ["Ldrt", "Lrok"]);
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.deepEqual(t.groundTiles, ["Lgrs", "Lgrd"]);
  assert.deepEqual(t.corners.map((c) => t.groundTiles[c.texture]), before, "every corner shows what it showed");
  assert.deepEqual(t.cliffTiles, ["CLgr"], "Ldrt's and Lrok's cliff types went with them");
});

test("a forced removal repaints the corners and gives the cliffs the replacement's cliff type", () => {
  const t = flat();
  for (let x = 0; x < 9; x++) corner(t, x, 0).texture = 2;
  mesa(t, 2);
  const use = tileUse(t, TYPES);
  // Lrok (corners and the mesa's cliffs) becomes Ldrt.
  const plan = planRemoval(t.groundTiles, [2], new Map([[2, 0]]), use);
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.deepEqual(t.groundTiles, ["Ldrt", "Lgrs", "Lgrd"]);
  for (let x = 0; x < 9; x++) assert.equal(t.groundTiles[corner(t, x, 0).texture], "Ldrt");
  assert.equal(t.groundTiles[corner(t, 4, 4).texture], "Lgrs", "other corners keep their tile");
  assert.equal(corner(t, 3, 3).cliffTexture, 0, "the mesa is now CLdi (type 0 of CLdi, CLgr)");
  assert.deepEqual(tileUse(t, TYPES).cliffs, [4, 0, 0]);
});

test("a replacement without a cliff type: the cliffs take the corner's ground's", () => {
  const t = flat();
  mesa(t, 2);
  const plan = planRemoval(t.groundTiles, [2], new Map([[2, 3]]), tileUse(t, TYPES));
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.equal(corner(t, 3, 3).cliffTexture, 1, "Lgrs's CLgr, the ground there");
});

test("a type that stays keeps its cliffs when tiles before it go", () => {
  const t = flat();
  mesa(t, 2);
  for (const c of t.corners) if (c.texture === 1) c.texture = 3;
  const use = tileUse(t, TYPES);
  const plan = planRemoval(t.groundTiles, [0, 1], new Map(), use);
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.deepEqual(t.groundTiles, ["Lrok", "Lgrd"]);
  assert.equal(corner(t, 3, 3).cliffTexture, 0, "CLro is type 0 now");
  assert.deepEqual(tileUse(t, TYPES).cliffs, [4, 0]);
});

test("the custom tiles flag follows the list: the tileset's own list is 0, another 1", () => {
  const own = ["Ldrt", "Lgrs", "Lrok"];
  const t = flat([...own, "Lgrd"]);
  const plan = planRemoval(t.groundTiles, [3], new Map(), tileUse(t, TYPES));
  applyTileList(t, plan.tiles, plan.map, TYPES, own);
  assert.equal(t.customTilesetsRaw, 0);
  assert.equal(t.customTilesets, false);
  const u = flat([...own, "Lgrd"]);
  const p2 = planRemoval(u.groundTiles, [2], new Map(), tileUse(u, TYPES));
  applyTileList(u, p2.tiles, p2.map, TYPES, own);
  assert.equal(u.customTilesetsRaw, 1);
  assert.equal(u.customTilesets, true);
});
