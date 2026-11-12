import assert from "node:assert/strict";
import { test } from "node:test";
import { brushCells } from "./brush";

const W = 40, H = 40;
/** The loop as it was before the shape was a parameter. */
const before = (cx: number, cy: number, radius: number) => {
  const out: number[] = [];
  for (let y = cy - radius + 1; y < cy + radius; y++) {
    for (let x = cx - radius + 1; x < cx + radius; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H || Math.hypot(x - cx, y - cy) > radius - 0.5) continue;
      out.push(y * W + x);
    }
  }
  return out;
};

test("Round is what it was; Square is every cell with |dx|, |dy| < radius", () => {
  for (const r of [1, 2, 5]) {
    assert.deepEqual(brushCells(20, 20, r, false, W, H), before(20, 20, r));
    const sq = brushCells(20, 20, r, true, W, H);
    assert.equal(sq.length, (2 * r - 1) ** 2);
    assert.ok(sq.includes(20 * W + 20 + (r - 1) + (r - 1) * W), "corner cell");
    assert.ok(!sq.includes(20 * W + 20 + r));
  }
  assert.deepEqual(brushCells(20, 20, 1, true, W, H), [20 * W + 20]);
  assert.equal(brushCells(20, 20, 3, false, W, H).length, 21);
  assert.equal(brushCells(20, 20, 3, true, W, H).length, 25);
});

test("cells outside the map are clipped, for both shapes", () => {
  for (const r of [1, 2, 5]) {
    for (const square of [false, true]) {
      for (const [cx, cy] of [[0, 0], [W - 1, H - 1], [-1, 3], [W, 0]]) {
        const cells = brushCells(cx, cy, r, square, W, H);
        for (const i of cells) assert.ok(i >= 0 && i < W * H && Math.abs((i % W) - cx) < r && Math.abs(Math.floor(i / W) - cy) < r);
        assert.equal(new Set(cells).size, cells.length);
      }
    }
  }
  assert.equal(brushCells(0, 0, 5, true, W, H).length, 25);
  assert.equal(brushCells(-1, 3, 1, true, W, H).length, 0);
  assert.equal(brushCells(W - 1, H - 1, 2, true, W, H).length, 4);
});
