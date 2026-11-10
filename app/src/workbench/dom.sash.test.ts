import assert from "node:assert/strict";
import { test } from "node:test";
import { sashWidth, storedSashWidth } from "./dom";

test("a dragged width stays within min and max; min wins when there's less room", () => {
  assert.equal(sashWidth(300, 120.4, 180, 900), 420);
  assert.equal(sashWidth(300, -500, 180, 900), 180);
  assert.equal(sashWidth(300, 2000, 180, 900), 900);
  assert.equal(sashWidth(300, 0, 180, 100), 180, "a window narrower than the minimum");
});

test("a remembered width is a positive number, else none", () => {
  assert.equal(storedSashWidth("412"), 412);
  for (const bad of [null, "", "abc", "-5", "0", "Infinity"]) assert.equal(storedSashWidth(bad), null, String(bad));
});
