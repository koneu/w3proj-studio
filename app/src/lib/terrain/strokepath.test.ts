import assert from "node:assert/strict";
import { test } from "node:test";
import { strokePoints } from "./strokepath";

test("a stroke is stamped along the line, ending where the mouse is", () => {
  assert.deepEqual(strokePoints([0, 0], [100, 0], 32), [[25, 0], [50, 0], [75, 0], [100, 0]]);
  const diagonal = strokePoints([0, 0], [300, 400], 32);
  assert.deepEqual(diagonal.at(-1), [300, 400]);
  for (let i = 1; i < diagonal.length; i++) {
    assert.ok(Math.hypot(diagonal[i][0] - diagonal[i - 1][0], diagonal[i][1] - diagonal[i - 1][1]) <= 32);
  }
});

test("a short move, or none, is one stamp", () => {
  assert.deepEqual(strokePoints([5, 5], [10, 5], 32), [[10, 5]]);
  assert.deepEqual(strokePoints([5, 5], [5, 5], 32), [[5, 5]]);
});
