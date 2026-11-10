import assert from "node:assert/strict";
import { test } from "node:test";
import { borderFlags, FACE_KEY, isFaceKey, isObjectEditorKey, isRecallKey, joinSteps, scaled, selectionKey, turnKey } from "./selectionkeys";
import { VIEW_KEYS, viewKeyCommand } from "./viewmodes";

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

test("T turns the selection toward the pointer; F is the World Editor's Fog Effects, Ctrl+T its Terrain", () => {
  const keys = { key: "t", code: "KeyT", ctrlKey: false, metaKey: false, altKey: false };
  assert.equal(FACE_KEY, "T");
  assert.equal(isFaceKey(keys), true);
  assert.equal(isFaceKey({ ...keys, key: "T" }), true, "caps lock");
  assert.equal(isFaceKey({ ...keys, key: "Unidentified" }), true, "WebKitGTK's unnamed key, by its code");
  assert.equal(isFaceKey({ ...keys, ctrlKey: true }), false);
  assert.equal(isFaceKey({ ...keys, altKey: true }), false);
  assert.equal(isFaceKey({ ...keys, key: "f", code: "KeyF" }), false);
  // No View key and no selection key takes T.
  assert.equal(viewKeyCommand({ ...keys, shiftKey: false }), null);
  assert.equal(VIEW_KEYS.some((k) => k.key === FACE_KEY), false);
  assert.equal(turnKey({ ...keys, shiftKey: false }), null);
  assert.equal(selectionKey(keys), null);
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

test("H, V and R mirror and turn, but Ctrl+V is still paste", () => {
  const keys = { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(turnKey({ ...keys, key: "h" }), "mirrorX");
  assert.equal(turnKey({ ...keys, key: "v" }), "mirrorY");
  assert.equal(turnKey({ ...keys, key: "r" }), "cw");
  assert.equal(turnKey({ ...keys, key: "R", shiftKey: true }), "ccw");
  assert.equal(turnKey({ ...keys, key: "v", ctrlKey: true }), null);
  assert.equal(turnKey({ ...keys, key: "a" }), null);
});

test("keys the webview calls Unidentified (WebKitGTK) go by the physical key (lib/keys.ts)", () => {
  assert.deepEqual(press("Unidentified", { code: "NumpadAdd" }), { scale: [0.05, 0.05, 0.05] });
  assert.deepEqual(press("Unidentified", { code: "NumpadDivide" }), { rotate: 15 });
  assert.deepEqual(press("Unidentified", { code: "PageUp", ctrlKey: true }), { raise: 16 });
  const plain = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(isRecallKey({ key: "Unidentified", code: "Space", ...plain }), true);
  assert.equal(isObjectEditorKey({ key: "Unidentified", code: "F1", ...plain, ctrlKey: true }), true);
  assert.equal(turnKey({ key: "Unidentified", code: "KeyR", ...plain, shiftKey: true }), "ccw");
});

test("a size has a floor, and no drift from adding fractions", () => {
  assert.deepEqual(scaled([1, 1, 1], [0.05, 0.05, 0]), [1.05, 1.05, 1]);
  assert.deepEqual(scaled([0.05, 0.05, 0.05], [-0.05, -0.05, -0.05]), [0.05, 0.05, 0.05]);
  assert.deepEqual(scaled([1.1, 1, 1], [0.1, 0, 0]), [1.2, 1, 1]);
});
