import assert from "node:assert/strict";
import { test } from "node:test";
import { borderFlags, isObjectEditorKey, isRecallKey, joinSteps, scaled, selectionKey } from "./selectionkeys";

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

test("Space alone recalls the selection", () => {
  const keys = { key: " ", code: "Space", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(isRecallKey(keys), true);
  assert.equal(isRecallKey({ ...keys, ctrlKey: true }), false);
  assert.equal(isRecallKey({ ...keys, shiftKey: true }), false);
  assert.equal(isRecallKey({ ...keys, key: "a" }), false);
});

test("Ctrl+F1 is the Object Editor, plain F1 isn't", () => {
  const keys = { key: "F1", code: "F1", ctrlKey: true, metaKey: false, altKey: false };
  assert.equal(isObjectEditorKey(keys), true);
  assert.equal(isObjectEditorKey({ ...keys, ctrlKey: false }), false);
  assert.equal(isObjectEditorKey({ ...keys, altKey: true }), false);
});

test("the border flag follows where a doodad stands, and leaves the others alone", () => {
  assert.equal(borderFlags(2, true), 3);
  assert.equal(borderFlags(3, false), 2);
  assert.equal(borderFlags(6, true), 7, "visible and fixed height stay");
  assert.equal(borderFlags(7, false), 6);
  assert.equal(borderFlags(3, true), 3);
});

test("joined steps undo backwards and redo forwards", () => {
  const log: string[] = [];
  const step = (name: string, objects: boolean) => ({ undo: () => log.push("undo " + name), redo: () => log.push("redo " + name), terrain: false, objects });
  const held = joinSteps(joinSteps(step("a", false), step("b", false)), step("c", true));
  held.undo();
  held.redo();
  assert.deepEqual(log, ["undo c", "undo b", "undo a", "redo a", "redo b", "redo c"]);
  assert.equal(held.objects, true);
  assert.equal(held.terrain, false);
});

test("a size has a floor, and no drift from adding fractions", () => {
  assert.deepEqual(scaled([1, 1, 1], [0.05, 0.05, 0]), [1.05, 1.05, 1]);
  assert.deepEqual(scaled([0.05, 0.05, 0.05], [-0.05, -0.05, -0.05]), [0.05, 0.05, 0.05]);
  assert.deepEqual(scaled([1.1, 1, 1], [0.1, 0, 0]), [1.2, 1, 1]);
});
