import assert from "node:assert/strict";
import { test } from "node:test";
import { scaled, selectionKey } from "./selectionkeys";

const press = (key: string, more: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  selectionKey({ key, code: more.code ?? "", ctrlKey: false, metaKey: false, altKey: false, ...more });

test("Ctrl+PageUp and PageDown move a doodad up and down", () => {
  assert.deepEqual(press("PageUp", { ctrlKey: true }), { raise: 16 });
  assert.deepEqual(press("PageDown", { ctrlKey: true }), { raise: -16 });
});

test("sizes: plus and minus all over, Home and End across, PageUp and PageDown upwards", () => {
  assert.deepEqual(press("+"), { scale: [0.05, 0.05, 0.05] });
  assert.deepEqual(press("-"), { scale: [-0.05, -0.05, -0.05] });
  assert.deepEqual(press("Home"), { scale: [0.05, 0.05, 0] });
  assert.deepEqual(press("End"), { scale: [-0.05, -0.05, 0] });
  assert.deepEqual(press("PageUp"), { scale: [0, 0, 0.05] });
  assert.deepEqual(press("PageDown"), { scale: [0, 0, -0.05] });
});

test("slash and star turn", () => {
  assert.deepEqual(press("/"), { rotate: 15 });
  assert.deepEqual(press("*"), { rotate: -15 });
});

test("Ctrl with arrows or the number pad nudges, in any NumLock state", () => {
  assert.deepEqual(press("ArrowLeft", { ctrlKey: true, code: "ArrowLeft" }), { nudge: [-32, 0] });
  assert.deepEqual(press("4", { ctrlKey: true, code: "Numpad4" }), { nudge: [-32, 0] });
  assert.deepEqual(press("ArrowUp", { ctrlKey: true, code: "Numpad8" }), { nudge: [0, 32] });
});

test("plain arrows and everything else stay out of it", () => {
  assert.equal(press("ArrowLeft", { code: "ArrowLeft" }), null, "they pan the view");
  assert.equal(press("a"), null);
  assert.equal(press("z", { ctrlKey: true }), null, "undo isn't ours");
  assert.equal(press("PageUp", { altKey: true }), null);
});

test("a size has a floor, and no drift from adding fractions", () => {
  assert.deepEqual(scaled([1, 1, 1], [0.05, 0.05, 0]), [1.05, 1.05, 1]);
  assert.deepEqual(scaled([0.05, 0.05, 0.05], [-0.05, -0.05, -0.05]), [0.05, 0.05, 0.05]);
  assert.deepEqual(scaled([1.1, 1, 1], [0.1, 0, 0]), [1.2, 1, 1]);
});
