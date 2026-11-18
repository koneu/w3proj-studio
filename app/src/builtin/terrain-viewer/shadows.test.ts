import assert from "node:assert/strict";
import { test } from "node:test";
import { setGroundHeight, setLayer, type Terrain } from "../../lib/terrain/w3e";
import { newTerrain, type NewMapOptions } from "./newmap";
import { rampSides } from "../../lib/terrain/cliffs";
import { castShadow, cliffCellHeights, DEFAULT_SUN, rampCellHeights, shadowCellHeights, shadowCliffName, shadowCliffVariation, shadowRampName, shadowStepRise, specialCellHeights, terrainShadows, type ShadowMesh } from "./shadows";

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

test("a single corner raised 512: the editor's shadow cell by cell", () => {
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
  // The gap at (175, 127) is 17 steps off the corner, whose highest cell (448) is lower than the sun's 17 × 80/3 there.
  assert.equal(shd.reduce((n, v) => n + (v ? 1 : 0), 0), Object.values(editor).join(",").split(",").reduce((n, r) => {
    const [a, b] = r.split("-").map(Number);
    return n + (b === undefined ? 1 : b - a + 1);
  }, 0), "nothing else on the map is shaded");
});

// make-shadow-probes.mjs shadow-slopes.w3x (we-drive --save-shadows, branch we-shadow-4, 2026-11-17, HD).

test("the walk rises 80/3 a step: a plane falling 26.63 a step away from the sun is lit, one falling 26.69 dark", () => {
  assert.ok(Math.abs(shadowStepRise(DEFAULT_SUN) - 80 / 3) < 1e-9);
  // Planes facing north, 0 on their north edge (corner row 6), 5 tiles wide: a walk toward the sun (south-west) climbs
  // a / 4 a step on them. The editor's shaded cells per row inside each, rows 8 to 24.
  const editor: Record<number, number[]> = {
    106.25: Array(17).fill(0),
    106.5: Array(17).fill(0),
    106.75: [0, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 20, 20, 20, 0],
    107: [0, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 20, 20, 20, 0],
  };
  for (const [a, rowsWe] of Object.entries(editor)) {
    const t = flat();
    for (let y = 2; y <= 6; y++) for (let x = 13; x <= 18; x++) setGroundHeight(corner(t, x, y), Number(a) * (6 - y));
    const shd = terrainShadows(t);
    const rows = Array.from({ length: 17 }, (_, i) => rowOf(shd, 8 + i, 52, 71).length);
    assert.deepEqual(rows, rowsWe, `a = ${a}`);
  }
});

test("the walk goes on as far as the map: a corner raised 1536 casts 50 cells", () => {
  const t = flat();
  setGroundHeight(corner(t, 6, 22), 1536);
  const shd = terrainShadows(t);
  // The editor's shadow ends at (73, 138), 49 steps off the corner's cells (a walk of 16 stopped at row 104).
  const top = (y: number) => rowOf(shd, y, 0, 255);
  assert.deepEqual([top(138), top(137), top(136), top(135)], [[73], [72, 74], [71, 73], [70, 72]]);
  assert.deepEqual(top(139), []);
});

/** A box model's triangles, 112 wide (x and y -56..56) from z0 to z1, each side counter-clockwise from outside;
 *  `bottom`: with its bottom. */
function boxMesh(z0: number, z1: number, bottom: boolean): ShadowMesh {
  const [a, b] = [-56, 56];
  const quads = [
    [[a, a, z1], [b, a, z1], [b, b, z1], [a, b, z1]],
    ...(bottom ? [[[a, a, z0], [a, b, z0], [b, b, z0], [b, a, z0]]] : []),
    [[a, a, z0], [b, a, z0], [b, a, z1], [a, a, z1]], [[b, b, z0], [a, b, z0], [a, b, z1], [b, b, z1]],
    [[a, b, z0], [a, a, z0], [a, a, z1], [a, b, z1]], [[b, a, z0], [b, b, z0], [b, b, z1], [b, a, z1]],
  ];
  const positions = quads.flat(2), faces: number[] = [];
  quads.forEach((_, q) => faces.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3));
  return { positions: new Float32Array(positions), faces: new Uint32Array(faces) };
}

test("a model's shadow: a cell is dark only when all of the model on its line toward the sun is over the ground", () => {
  // The World Editor's war3map.shd of box models imported into a map (we-drive, branch we-shadow-4, HD; the box's
  // origin at a cell corner, (32, 192) in cells): the runs of shaded cells per row.
  const cases: [string, number, number, boolean, Record<number, string>][] = [
    // Standing on the ground with a bottom: the bottom is on every footprint cell's line, at the ground: lit.
    ["closed", 0, 96, true, { 191: "34", 192: "34-35", 193: "34-36", 194: "31-36", 195: "32-36", 196: "33-36" }],
    // Without its bottom the footprint is dark. The editor leaves (33, 193) lit: its centre is on the edge two of the
    // top's triangles share, where which one takes it comes down to the floats' last bits (not compared).
    ["cap", 0, 96, false, { 190: "30-33", 191: "30-34", 192: "30-35", 193: "30-32,34-36", 194: "31-36", 195: "32-36", 196: "33-36" }],
    // Sunk 32 into the ground: the bottom under the footprint's cells, lit; the shadow shorter.
    ["sunk", -32, 64, true, { 191: "34", 192: "34-35", 193: "34-35", 194: "31-35", 195: "32-35" }],
    // Floating 32 over the ground: all of it over the footprint too, dark.
    ["float", 32, 128, true, { 191: "31-34", 192: "31-35", 193: "31-36", 194: "31-37", 195: "32-38", 196: "33-38", 197: "34-38", 198: "35-38" }],
  ];
  for (const [name, z0, z1, bottom, editor] of cases) {
    const t = flat();
    const out = new Uint8Array(256 * 256);
    castShadow(out, t, { mesh: boxMesh(z0, z1, bottom), x: -4096 + 32 * 32, y: -4096 + 192 * 32, z: 0, angle: 0, scale: [1, 1, 1] });
    if (name === "cap") out[193 * 256 + 33] = 0;
    for (let y = 180; y <= 210; y++) {
      const xs = rowOf(out, y, 0, 255);
      const runs: string[] = [];
      for (let i = 0; i < xs.length; i++) {
        let j = i;
        while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
        runs.push(i === j ? `${xs[i]}` : `${xs[i]}-${xs[j]}`);
        i = j;
      }
      assert.equal(runs.join(","), editor[y] ?? "", `${name}, row ${y}`);
    }
  }
});

test("ramp sides: the ramp model named from the top-left corner on, read a quarter turn round", () => {
  const t = flat();
  // A plateau one level up (corners 24..38 x 30..40) with a ramp down its south face, three corners wide (columns 30
  // to 32: rows 30 high, 29 and 28 low), as shadow-slopes.w3x.
  for (let y = 30; y <= 40; y++) for (let x = 24; x <= 38; x++) setLayer(corner(t, x, y), 3);
  for (let y = 28; y <= 30; y++) for (let x = 30; x <= 32; x++) corner(t, x, y).ramp = true;
  const sides = rampSides(t);
  const west = sides.find((s) => s.x === 29 && s.y === 28);
  assert.ok(west, `the ramp's west side: ${JSON.stringify(sides.map((s) => [s.x, s.y, s.w, s.h]))}`);
  // Drawn as CliffTransABHL (bottom-left, top-left, top-right, bottom-right); the shadows read BHLA.
  assert.equal(shadowRampName(west.outer, west.base), "BHLA");
  // Read a quarter turn round: the side's point (x, y) at the model's (-y, x). A model whose height is its own -x (so
  // the side's y) gives each row of cells its y, in both tiles of a 1 x 2 side.
  const positions = [-256, 0, 256, 0, 0, 0, 0, 256, 0, -256, 256, 256];
  const faces = [0, 1, 2, 0, 2, 3];
  assert.deepEqual([...rampCellHeights(positions, faces, 0, 0).filter((_, i) => i % 4 === 0)], [16, 48, 80, 112]);
  assert.deepEqual([...rampCellHeights(positions, faces, 0, 1).filter((_, i) => i % 4 === 0)], [144, 176, 208, 240]);
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
  // The ground under a cliff model is bilinear (where the ground tiles are split in two): the top-right corner 64 up
  // gives the cell (7/8, 7/8) 64 × 49/64.
  setGroundHeight(corner(t, 21, 21), 8 + 64);
  assert.equal(shadowCellHeights(t, (x, y) => (x === 20 && y === 20 ? plate : null))[83 * 256 + 83], 108 + 49);
});

test("a special doodad's tiles are read from its model as it is drawn, the flat ones too", () => {
  // A plate 100 high over the model's +x half (x 0..192, y -192..192) of a 3 x 3 tile footprint: turned as specials are
  // drawn (270°: specials.ts SPECIAL_FACING), its +x is the footprint's south, so the south row of tiles reads 100 and
  // the north row nothing; turned 0 it would be the east column.
  const plate = [0, -192, 100, 192, -192, 100, 192, 192, 100, 0, 192, 100];
  const faces = [0, 1, 2, 0, 2, 3];
  const south = -Math.PI / 2;
  assert.ok(specialCellHeights(plate, faces, 3, 3, south, 1, 0).every((z) => z === 100), "south row");
  assert.ok(specialCellHeights(plate, faces, 3, 3, south, 1, 2).every(Number.isNaN), "north row");
  assert.ok(specialCellHeights(plate, faces, 3, 3, 0, 2, 1).every((z) => z === 100), "turned 0: the east column");
  assert.ok(specialCellHeights(plate, faces, 3, 3, 0, 0, 1).every(Number.isNaN), "turned 0: not the west column");
  // shadowCellHeights reads a special's tile even when it is flat (no cliff there), over the tile's lowest layer; the
  // same heights without the mark that a special covers it leave a flat tile its ground.
  const t = flat();
  const cells = specialCellHeights(plate, faces, 3, 3, south, 1, 0);
  const lookup = (x: number, y: number) => (x === 31 && y === 30 ? cells : null);
  const marked = Object.assign((x: number, y: number) => lookup(x, y), { special: (x: number, y: number) => x === 31 && y === 30 });
  const h = shadowCellHeights(t, marked);
  assert.deepEqual([124, 125, 126, 127].map((x) => h[121 * 256 + x]), [100, 100, 100, 100]);
  assert.deepEqual([124, 125, 126, 127].map((x) => shadowCellHeights(t, lookup)[121 * 256 + x]), [0, 0, 0, 0]);
  // So such a tile casts: the cells north-east of it are dark (cells past the plate, beyond its own rise).
  const shd = terrainShadows(t, DEFAULT_SUN, marked);
  assert.equal(shd[124 * 256 + 128], 0xff, "a cell up the diagonal from the plate");
  assert.equal(terrainShadows(t, DEFAULT_SUN, lookup)[124 * 256 + 128], 0, "not without the special");
});

test("a variation the shadow's cliff model doesn't have is counted round its variations", () => {
  assert.deepEqual([[0, 2], [1, 2], [2, 2], [2, 3], [3, 2], [1, 1], [5, 0]].map(([v, n]) => shadowCliffVariation(v, n)), [0, 1, 0, 2, 1, 0, 0]);
});
