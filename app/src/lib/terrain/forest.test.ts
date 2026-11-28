import assert from "node:assert/strict";
import { test } from "node:test";
import { FOREST_SIZES, forestCentre, forestLayout, forestOverlaps, forestPoints, forestSpacing } from "./forest";

/** The points as rows, north first: [y, xs]. */
const rows = (points: [number, number][]) => {
  const m = new Map<number, number[]>();
  for (const [x, y] of points) m.set(y, [...(m.get(y) ?? []), x]);
  return [...m];
};

test("a circle places as many trees as the World Editor, size by size", () => {
  assert.deepEqual(FOREST_SIZES.map((s) => forestPoints(s, "circle").length), [1, 7, 15, 57, 183]);
});

test("a square places as many trees as the World Editor, in the sizes measured", () => {
  assert.deepEqual([2, 3, 5].map((s) => forestPoints(s, "square").length), [9, 25, 81]);
});

test("every second row of a circle is shifted by half a tree", () => {
  assert.deepEqual(rows(forestPoints(3, "circle")), [
    [256, [0]],
    [128, [-192, -64, 64, 192]],
    [0, [-256, -128, 0, 128, 256]],
    [-128, [-192, -64, 64, 192]],
    [-256, [0]],
  ]);
});

test("the largest circle's east edge is open, as in the World Editor", () => {
  const row = rows(forestPoints(8, "circle")).find(([y]) => y === 128)![1];
  assert.deepEqual([row[0], row[row.length - 1], row.length], [-960, 832, 15]);
});

test("no two points of a pattern overlap", () => {
  for (const size of FOREST_SIZES) {
    for (const shape of ["circle", "square"] as const) {
      const p = forestPoints(size, shape).map(([x, y]) => ({ x, y }));
      assert.ok(!p.some((a, i) => p.slice(i + 1).some((b) => forestOverlaps(a, b, 128))), `${shape} ${size}`);
    }
  }
});

test("the centre snaps to 64 and the pattern grows with the footprint", () => {
  assert.deepEqual(forestCentre(20, -1000), [0, -1024]);
  assert.equal(forestSpacing({ width: 4, height: 4 }), 128);
  assert.equal(forestSpacing({ width: 8, height: 4 }), 256);
  assert.equal(forestSpacing({ width: 1, height: 1 }), 64);
  assert.equal(forestSpacing(null), 128);
  assert.deepEqual(forestPoints(2, "circle", 256), forestPoints(2, "circle").map(([x, y]) => [x * 2, y * 2]));
});

test("a type with a footprint is spaced by it on the grid; a pathless doodad by its model's width, freely", () => {
  // A tree (4 cells), a barrel (2), a barn (10): the footprint's longer side, the model's width not looked at.
  assert.deepEqual(forestLayout({ width: 4, height: 4 }, 300), { spacing: 128, free: false });
  assert.deepEqual(forestLayout({ width: 2, height: 2 }, null), { spacing: 64, free: false });
  assert.deepEqual(forestLayout({ width: 10, height: 6 }, null), { spacing: 320, free: false });
  // No footprint: the model's width as measured in the World Editor (Cattail 102.12, Rib Bones 335.82, Lily Pad 61.88).
  assert.deepEqual(forestLayout(null, 102.124), { spacing: 102.124, free: true });
  assert.deepEqual(forestLayout(null, 335.821), { spacing: 335.821, free: true });
  // No model known (or one without a size): a tree's spacing, on the grid, as before.
  for (const span of [null, 0, -5, NaN, Infinity]) assert.deepEqual(forestLayout(null, span), { spacing: 128, free: false });
});

test("the pattern of a pathless doodad is the tree's, scaled to its spacing", () => {
  // Flowers (78.452) at size 3: rows of 1, 4, 5, 4, 1 one spacing apart, every second row shifted by half (World Editor).
  const p = forestPoints(3, "circle", 78.452);
  assert.deepEqual(rows(p).map(([, xs]) => xs.length), [1, 4, 5, 4, 1]);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} isn't ${b}`);
  near(rows(p)[0][0], 2 * 78.452);
  near(rows(p)[1][1][0], -1.5 * 78.452);
  near(rows(p)[2][1][1] - rows(p)[2][1][0], 78.452);
  assert.equal(forestPoints(2, "circle", 78.452).length, 7);
  assert.equal(forestPoints(5, "circle", 78.452).length, 57);
  assert.equal(forestPoints(2, "square", 335.821).length, 9);
});
