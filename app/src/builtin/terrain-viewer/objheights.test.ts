import assert from "node:assert/strict";
import { test } from "node:test";
import { pastedFlags, pastedHeight } from "./objheights";
import { FIXED_HEIGHT } from "./selectionkeys";

test("a pasted fixed-height object keeps its height over the ground, only when preserving", () => {
  assert.equal(pastedHeight(100, 40, true, true), 140);
  assert.equal(pastedHeight(100, 40, true, false), 100);
  assert.equal(pastedHeight(100, 40, false, true), 100, "an object without a height of its own sits on the ground");
  assert.equal(pastedHeight(100, -25, true, true), 75);
});

test("pasting without preserving drops the fixed height; the other flags stay", () => {
  assert.equal(pastedFlags(2 | FIXED_HEIGHT, true), 2 | FIXED_HEIGHT);
  assert.equal(pastedFlags(2 | FIXED_HEIGHT | 1, false), 2 | 1);
  assert.equal(pastedFlags(2, false), 2);
});
