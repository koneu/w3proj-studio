import assert from "node:assert/strict";
import { test } from "node:test";
import { setGroundHeight, setLayer, type Terrain } from "../../lib/terrain/w3e";
import { newTerrain, type NewMapOptions } from "./newmap";
import { cliffCellHeights, shadowCellHeights, shadowCliffName, terrainShadows, SHADOW_WALK_STEPS } from "./shadows";

/** flat.w3x's ground: 64 x 64 tiles, level 2, height 0 (the maps make-shadow-probes.mjs makes start from it). */
function flat(): Terrain {
  return newTerrain({ width: 64, height: 64, tileset: "L", groundTiles: ["Lgrs"], cliffTiles: [], baseTile: "Lgrs", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
}
const corner = (t: Terrain, x: number, y: number) => t.corners[y * t.width + x];
/** The shaded cells of a row (or column) of the 256-wide shd, as a list. */
const rowOf = (shd: Uint8Array, y: number, x0: number, x1: number) => Array.from({ length: x1 - x0 + 1 }, (_, i) => x0 + i).filter((x) => shd[y * 256 + x]);
const colOf = (shd: Uint8Array, x: number, y0: number, y1: number) => Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i).filter((y) => shd[y * 256 + x]);

// The World Editor's war3map.shd of make-shadow-probes.mjs's shadow-terrain.w3x (we-drive --save-shadows, branch
// we-shadow-3, 2026-11-17, HD and SD alike), the parts that are ground only.

test("a 128 high bank one tile wide: the editor's shadow starts a cell down the bank and is four cells long", () => {
  const t = flat();
  for (let y = 6; y <= 16; y++) for (let x = 6; x <= 14; x++) setGroundHeight(corner(t, x, y), 128);
  const shd = terrainShadows(t);
  // The east bank is tile 14 (cells 56 to 59): the editor's 57 to 60 in every row along it; the old ray from the cell
  // centre (16 units a step) took 56 too, the 45° bank's own top cell.
  assert.deepEqual(rowOf(shd, 40, 50, 70), [57, 58, 59, 60]);
  // The north bank, tile 16 (cells 64 to 67): 65 to 68.
  assert.deepEqual(colOf(shd, 40, 60, 75), [65, 66, 67, 68]);
});

test("a single corner raised 512: the editor's shadow cell by cell, cut off after 16 steps toward the sun", () => {
  const t = flat();
  setGroundHeight(corner(t, 40, 28), 512);
  const shd = terrainShadows(t);
  // Rows 109 to 128 of the editor's file, the runs of shaded cells between x 140 and 200 (nothing else is shaded).
  const editor: Record<number, string> = {
    128: "175", 127: "174,176", 126: "173-175", 125: "170-174", 124: "169-173", 123: "168-173", 122: "167-173", 121: "164-172",
    120: "163-171", 119: "162-170", 118: "161-169", 117: "158-169", 116: "157-169", 115: "158-168", 114: "159-167", 113: "160-166",
    112: "161-165", 111: "162-165", 110: "163-165", 109: "164",
  };
  const runs = (y: number) => {
    const out: string[] = [];
    let start = -1;
    for (let x = 140; x <= 201; x++) {
      const on = x <= 200 && shd[y * 256 + x] !== 0;
      if (on && start < 0) start = x;
      else if (!on && start >= 0) { out.push(start === x - 1 ? `${start}` : `${start}-${x - 1}`); start = -1; }
    }
    return out.join(",");
  };
  for (let y = 100; y <= 140; y++) assert.equal(runs(y), editor[y] ?? "", `row ${y}`);
  // The gap at (175, 127) is the 17th step: the walk stops at SHADOW_WALK_STEPS.
  assert.equal(SHADOW_WALK_STEPS, 16);
  assert.equal(shd.reduce((n, v) => n + (v ? 1 : 0), 0), Object.values(editor).join(",").split(",").reduce((n, r) => {
    const [a, b] = r.split("-").map(Number);
    return n + (b === undefined ? 1 : b - a + 1);
  }, 0), "nothing else on the map is shaded");
});

test("ground cells are read over the tile's two triangles, split from the top-left to the bottom-right corner", () => {
  const t = flat();
  setGroundHeight(corner(t, 10, 11), 128); // a tile's top-left corner
  const h = shadowCellHeights(t);
  // Tile (10, 10): the cell on the split diagonal next to the raised corner, (u, v) = (1/8, 7/8), takes 7/8 of it,
  // where bilinear would give 7/8 × 7/8.
  assert.equal(h[(40 + 3) * 256 + 40], 112);
  // The cell beside the diagonal on the far side, (3/8, 5/8): in the top-right triangle, 1 - 3/8 of the corner.
  assert.equal(h[(40 + 2) * 256 + 41], 80);
});

test("cliff tiles: the model named from the top-left corner on, read a quarter turn round, over the lowest layer", () => {
  const t = flat();
  // An east face: the tile's west corners one level up.
  setLayer(corner(t, 20, 20), 3);
  setLayer(corner(t, 20, 21), 3);
  assert.equal(shadowCliffName(t, 20, 20), "BAAB", "read from the top-left: top-left, top-right, bottom-right, bottom-left");
  // A model whose height falls along its own y (z = 128 - y): read a quarter turn round, the tile's cell (u, v) at the
  // model's (1 - v, u), so its height follows the tile's u, from 112 in the west cells to 16 in the east ones.
  const positions = [-128, 0, 128, 0, 0, 128, 0, 128, 0, -128, 128, 0];
  const cells = cliffCellHeights(positions, [0, 1, 2, 0, 2, 3]);
  assert.deepEqual([...cells.subarray(0, 4)], [112, 80, 48, 16]);
  assert.deepEqual([...cells.subarray(12, 16)], [112, 80, 48, 16], "the same in every row");
  // A point no triangle covers is unknown.
  assert.ok(cliffCellHeights([-128, 0, 0, -127, 0, 0, -128, 1, 0], [0, 1, 2]).every(Number.isNaN));
  // shadowCellHeights takes them over the tile's lowest layer and its ground height; another tile stays ground.
  setGroundHeight(corner(t, 20, 20), 8);
  setGroundHeight(corner(t, 21, 20), 8);
  setGroundHeight(corner(t, 20, 21), 8);
  setGroundHeight(corner(t, 21, 21), 8);
  const plate = new Float32Array(16).fill(100);
  plate[5] = NaN;
  const h = shadowCellHeights(t, (x, y) => (x === 20 && y === 20 ? plate : null));
  assert.deepEqual([80, 81, 82, 83].map((x) => h[82 * 256 + x]), [108, 108, 108, 108], "100 over level 2 and the ground's 8");
  // Its unknown cell (1, 1) and the tile without a model: ground between its corners (136 in the west, 8 in the east).
  assert.equal(h[81 * 256 + 81], 136 - 128 * 0.375);
  assert.deepEqual([80, 81, 82, 83].map((x) => shadowCellHeights(t)[82 * 256 + x]), [120, 88, 56, 24]);
});
