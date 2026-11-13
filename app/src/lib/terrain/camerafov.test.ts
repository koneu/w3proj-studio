import assert from "node:assert/strict";
import { test } from "node:test";
import { horizontalFov, verticalFov } from "./camerafov";

const RAD = Math.PI / 180;

test("verticalFov: the horizontal field of view stays, the vertical one shrinks as the view widens", () => {
  // 70 degrees at 4:3 is the old preview's 55.4 vertical (control: the old formula).
  assert.ok(Math.abs(verticalFov(70 * RAD, 4 / 3) - 2 * Math.atan(Math.tan(35 * RAD) / (4 / 3))) < 1e-12);
  assert.ok(Math.abs(verticalFov(70 * RAD, 4 / 3) / RAD - 55.4) < 0.1);
  const wide = verticalFov(70 * RAD, 16 / 9), square = verticalFov(70 * RAD, 1);
  assert.ok(wide < verticalFov(70 * RAD, 4 / 3) && verticalFov(70 * RAD, 4 / 3) < square);
  // The width seen at a distance is the same in every view: tan(h/2) = tan(v/2) * aspect.
  for (const a of [1, 4 / 3, 16 / 9, 2.4]) assert.ok(Math.abs(Math.tan(verticalFov(70 * RAD, a) / 2) * a - Math.tan(35 * RAD)) < 1e-12);
  assert.ok(Math.abs(wide / RAD - 43.0) < 0.1);
});

test("horizontalFov undoes verticalFov at any aspect, and a bad aspect counts as 4:3", () => {
  for (const a of [0.8, 4 / 3, 1.403, 16 / 9, 21 / 9]) for (const f of [30, 70, 110]) {
    assert.ok(Math.abs(horizontalFov(verticalFov(f * RAD, a), a) / RAD - f) < 1e-9, `${f} at ${a}`);
  }
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(verticalFov(70 * RAD, bad), verticalFov(70 * RAD, 4 / 3));
});
