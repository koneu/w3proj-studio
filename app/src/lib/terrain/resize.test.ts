import assert from "node:assert/strict";
import { test } from "node:test";
import { resizeTerrain } from "./resize";
import type { Corner, Terrain } from "./w3e";

function terrain(w: number, h: number): Terrain {
  const corner = (i: number): Corner => ({ height: i, water: 0, texture: i % 3, variation: 5, cliffVariation: 0, cliffTexture: 15, layer: 2, ramp: true, blight: true, hasWater: false, boundary: false, rawHeight: 0, rawWater: 0, texExtra: 0 });
  return { width: w, height: h, offsetX: -64, offsetY: -64, corners: Array.from({ length: w * h }, (_, i) => corner(i)) } as unknown as Terrain;
}

test("corners that stay are untouched; new ones continue the edge with a variation of their own", () => {
  const t = terrain(3, 2);
  const random = Math.random;
  Math.random = () => 0.7; // randomVariation: 17, never the 5 of the old corners
  try {
    const r = resizeTerrain(t, [0, 2, 0, 0]);
    assert.equal(r.width, 5);
    assert.equal(r.corners.length, 10);
    assert.deepEqual(r.corners[1], t.corners[1]);
    const added = r.corners[3], edge = t.corners[2];
    assert.equal(added.texture, edge.texture);
    assert.equal(added.height, edge.height);
    assert.equal(added.variation, 17);
    assert.equal(added.ramp, false);
    assert.equal(added.blight, false);
  } finally { Math.random = random; }
});

test("adding on the left and bottom moves the offset, not the world position", () => {
  const r = resizeTerrain(terrain(3, 3), [1, 0, 1, 0]);
  assert.equal(r.offsetX, -64 - 128);
  assert.equal(r.offsetY, -64 - 128);
  assert.deepEqual(r.corners[r.width + 1], terrain(3, 3).corners[0]);
});

import { resizePathingOverrides, type PathingOverrides } from "./resize";

// A 64×64-tile map is 256×256 pathing cells.
const file = (t: Terrain, cells: PathingOverrides["cells"]): PathingOverrides => ({ format: "w3proj.pathing/1", width: (t.width - 1) * 4, height: (t.height - 1) * 4, cells });
const big = () => terrain(65, 65);

test("pathing overrides: growing left/bottom shifts them, growing right/top leaves them", () => {
  const t = big(), f = file(t, [[0, 0, 1, 0], [10, 20, 2, 4]]);
  const l = resizePathingOverrides(f, t, [32, 0, 0, 0]);
  assert.equal(l.width, 384);
  assert.deepEqual(l.cells, [[128, 0, 1, 0], [138, 20, 2, 4]]);
  const b = resizePathingOverrides(f, t, [0, 0, 32, 0]);
  assert.equal(b.height, 384);
  assert.deepEqual(b.cells, [[0, 128, 1, 0], [10, 148, 2, 4]]);
  const rt = resizePathingOverrides(f, t, [0, 32, 0, 32]);
  assert.deepEqual([rt.width, rt.height], [384, 384]);
  assert.deepEqual(rt.cells, f.cells);
});

test("pathing overrides: shrinking each side keeps the same ground cell and drops removed cells", () => {
  const t = big(); // 256 cells a side; 32 tiles are 128 cells
  const A: [number, number, number, number] = [2, 100, 1, 0], B: [number, number, number, number] = [253, 100, 1, 0];
  const C: [number, number, number, number] = [100, 2, 1, 0], D: [number, number, number, number] = [100, 253, 1, 0], E: [number, number, number, number] = [100, 100, 8, 0];
  const f = file(t, [A, B, C, D, E]);
  const text = (r: PathingOverrides) => r.cells.map((c) => c.join(" "));
  const left = resizePathingOverrides(f, t, [-32, 0, 0, 0]);
  assert.equal(left.width, 128);
  assert.deepEqual(text(left), ["125 100 1 0"]);
  const right = resizePathingOverrides(f, t, [0, -32, 0, 0]);
  assert.equal(right.width, 128);
  assert.deepEqual(text(right), ["100 2 1 0", "2 100 1 0", "100 100 8 0", "100 253 1 0"]);
  const bottom = resizePathingOverrides(f, t, [0, 0, -32, 0]);
  assert.equal(bottom.height, 128);
  assert.deepEqual(text(bottom), ["100 125 1 0"]);
  const top = resizePathingOverrides(f, t, [0, 0, 0, -32]);
  assert.equal(top.height, 128);
  assert.deepEqual(text(top), ["100 2 1 0", "2 100 1 0", "100 100 8 0", "253 100 1 0"]);
});

test("pathing overrides: a shrink and a grow together move them by the net offset", () => {
  const t = big(), f = file(t, [[200, 50, 1, 0], [10, 50, 1, 0]]);
  const r = resizePathingOverrides(f, t, [-32, 64, 0, 0]);
  assert.deepEqual([r.width, r.height], [384, 256]);
  assert.deepEqual(r.cells, [[72, 50, 1, 0]]);
});

test("pathing overrides: growing and shrinking back brings them back", () => {
  const t = big(), f = file(t, [[3, 4, 1, 0], [250, 255, 2, 1]]);
  const grown = resizePathingOverrides(f, t, [32, 32, 32, 32]);
  const t2 = terrain(129, 129);
  const back = resizePathingOverrides(grown, t2, [-32, -32, -32, -32]);
  assert.deepEqual(back, f);
});

test("pathing overrides: a file for another size is left alone", () => {
  const t = big(), f = { ...file(t, [[1, 1, 1, 0]]), width: 100 };
  assert.deepEqual(resizePathingOverrides(f, t, [32, 0, 0, 0]), f);
});
