import assert from "node:assert/strict";
import { test } from "node:test";
import { FOREST_SIZES, forestCentre, forestOverlaps, forestPoints, forestSpacing } from "./forest";

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
