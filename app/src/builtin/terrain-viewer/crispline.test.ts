import assert from "node:assert/strict";
import { test } from "node:test";
import { crispPixels } from "./crispline";

/** x and y map straight to the picture: clip x = x / 100, clip y = y / 100 (no depth), w = 1. */
const FLAT = [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
const pairs = (flat: number[]) => Array.from({ length: flat.length / 2 }, (_, i) => `${flat[i * 2]},${flat[i * 2 + 1]}`);

test("a line is one pixel wide: each step moves to a neighbour, no pixel twice, the end pixel last", () => {
  // From (-40, -30) to (30, 20) in a 200 x 200 picture (pixel 60, 130 to 130, 80 after the flip), and back as a closed pair.
  const px = crispPixels([-40, -30, 0, 30, 20, 0], FLAT, 200, 200);
  const half = px.slice(0, px.length / 2);
  const cells = pairs(half);
  assert.equal(new Set(cells).size, cells.length, "no pixel twice along a segment");
  assert.deepEqual(cells[0], "60,130");
  assert.equal(cells.at(-1), "130,80");
  for (let i = 1; i < cells.length; i++) {
    const [a, b] = [cells[i - 1], cells[i]].map((c) => c.split(",").map(Number));
    assert.ok(Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1, "a neighbour");
  }
  // One pixel per column on a shallow line (control: a two-pixel line would have two in some column).
  const perColumn = new Map<number, number>();
  for (let i = 0; i < half.length; i += 2) perColumn.set(half[i], (perColumn.get(half[i]) ?? 0) + 1);
  assert.deepEqual([...new Set(perColumn.values())], [1]);
});

test("a segment is cut to the picture and to the front of the camera", () => {
  // Far past the right edge: only the pixels inside are listed.
  const px = crispPixels([0, 0, 0, 5000, 0, 0], FLAT, 200, 200);
  assert.ok(px.length > 0 && px.every((v, i) => (i % 2 ? v >= 0 && v < 200 : v >= 100 && v < 200)), "inside the picture, from the middle to the edge");
  // Wholly outside: nothing.
  assert.deepEqual(crispPixels([500, 500, 0, 600, 500, 0], FLAT, 200, 200), []);
  // Behind the camera (w < 0): nothing.
  const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, -1];
  assert.deepEqual(crispPixels([0, 0, 0, 10, 0, 0], behind, 200, 200), []);
});

test("fewer than two points make no line", () => {
  assert.deepEqual(crispPixels([], FLAT, 200, 200), []);
  assert.deepEqual(crispPixels([1, 1, 0], FLAT, 200, 200), []);
});
