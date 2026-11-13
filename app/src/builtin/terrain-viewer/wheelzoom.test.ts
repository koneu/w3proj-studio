import assert from "node:assert/strict";
import { test } from "node:test";
import { wheelZoomDistance } from "./wheelzoom";

test("one wheel notch changes the distance by 1.1", () => {
  assert.ok(Math.abs(wheelZoomDistance(1000, true, 200, 1e6) - 1100) < 1e-9);
  assert.ok(Math.abs(wheelZoomDistance(1100, false, 200, 1e6) - 1000) < 1e-9);
});

test("a notch in and a notch out cancel", () => {
  const d = wheelZoomDistance(wheelZoomDistance(2345, false, 200, 1e6), true, 200, 1e6);
  assert.ok(Math.abs(d - 2345) < 1e-9);
});

test("the distance stays within its limits", () => {
  assert.equal(wheelZoomDistance(205, false, 200, 1000), 200);
  assert.equal(wheelZoomDistance(990, true, 200, 1000), 1000);
});
