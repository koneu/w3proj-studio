import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { AREA_COMMAND, borderFlags, CANCEL_COMMAND, FACE_COMMAND, HELD_COMMANDS, joinSteps, MOUSE_CONTROLS, mouseControlOf, OBJECT_EDITOR_COMMAND, RECALL_COMMAND, runsAsCommand, scaled, selectionEditOf, turnOf } from "./selectionkeys";
import { commandsFor, defaultBindings, eventChord, keyLabel, mouseChord, mouseCommandsFor, primaryKey, UNDO_BINDINGS, UNDO_CONTEXT } from "../../lib/keybindings";

// The selection's keys are the terrain viewer's default key bindings (extension.json), read as the view reads them:
// what a key is bound to under terrainFocus (lib/keybindings.ts commandsFor), then what those commands do.
const manifest = JSON.parse(readFileSync("src/builtin/terrain-viewer/extension.json", "utf8")) as { contributes: { keybindings: { key: string; command: string; when?: string }[] } };
const bindings = defaultBindings([], manifest.contributes.keybindings);
type Ev = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean };
const bound = (e: Ev) => { const c = eventChord({ ...e, shiftKey: !!e.shiftKey }); return c ? commandsFor(bindings, c, { terrainFocus: true }) : []; };
const selectionKey = (e: Ev) => selectionEditOf(bound(e));
const turnKey = (e: Ev) => turnOf(bound(e));
const isRecallKey = (e: Ev) => bound(e).includes(RECALL_COMMAND);
const isFaceKey = (e: Ev) => bound(e).includes(FACE_COMMAND);
const isObjectEditorKey = (e: Ev) => bound(e).includes(OBJECT_EDITOR_COMMAND);
const viewKeyCommand = (e: Ev) => bound(e).find(runsAsCommand) ?? null;
const FACE_KEY = keyLabel(primaryKey(bindings, FACE_COMMAND) ?? "");

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
  assert.deepEqual(press("/"), { rotate: 5 });
  assert.deepEqual(press("*"), { rotate: -5 });
});

test("the number pad with NumLock on nudges (the World Editor's Edit > Nudge Selection, we-drive 2026-11-13)", () => {
  assert.deepEqual(press("4", { code: "Numpad4" }), { nudge: [-8, 0] });
  assert.deepEqual(press("6", { code: "Numpad6" }), { nudge: [8, 0] });
  assert.deepEqual(press("8", { code: "Numpad8" }), { nudge: [0, 8] });
  assert.deepEqual(press("2", { code: "Numpad2" }), { nudge: [0, -8] });
  // The diagonals nudge both ways by the whole step (we-drive 2026-11-13: a tree 64 and 64).
  assert.deepEqual(press("7", { code: "Numpad7" }), { nudge: [-8, 8] });
  assert.deepEqual(press("9", { code: "Numpad9" }), { nudge: [8, 8] });
  assert.deepEqual(press("1", { code: "Numpad1" }), { nudge: [-8, -8] });
  assert.deepEqual(press("3", { code: "Numpad3" }), { nudge: [8, -8] });
});

test("Ctrl and the arrows aren't the nudge: in the World Editor they zoom and turn the camera", () => {
  for (const [key, code] of [["ArrowLeft", "ArrowLeft"], ["ArrowRight", "ArrowRight"], ["ArrowUp", "ArrowUp"], ["ArrowDown", "ArrowDown"], ["4", "Numpad4"], ["8", "Numpad8"]]) {
    assert.equal(press(key, { ctrlKey: true, code }), null, `ctrl+${code}`);
  }
  assert.equal(press("ArrowUp", { code: "Numpad8" }), null, "NumLock off: an arrow, which pans the view");
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
  assert.equal(bindings.some((b) => b.key === "t" && runsAsCommand(b.command)), false);
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
  assert.deepEqual(press("Unidentified", { code: "NumpadDivide" }), { rotate: 5 });
  assert.deepEqual(press("Unidentified", { code: "PageUp", ctrlKey: true }), { raise: 16 });
  const plain = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(isRecallKey({ key: "Unidentified", code: "Space", ...plain }), true);
  assert.equal(isObjectEditorKey({ key: "Unidentified", code: "F1", ...plain, ctrlKey: true }), true);
  assert.equal(turnKey({ key: "Unidentified", code: "KeyR", ...plain, shiftKey: true }), "ccw");
});

test("mouse controls by default: the middle button pans, the right turns, Alt and Ctrl with the left move and face", () => {
  type M = Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>;
  const control = (button: number, mods: M = {}, selection = true) => {
    const chord = mouseChord({ type: "mousedown", button, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    const ids = chord ? mouseCommandsFor(bindings, chord, { terrainFocus: true }) : [];
    return mouseControlOf(ids, (c) => c === "translate" || c === "rotate" || selection);
  };
  assert.equal(control(1), "translate");
  assert.equal(control(1, { ctrlKey: true, shiftKey: true }), "translate", "with modifiers too, as before");
  assert.equal(control(2), "rotate");
  assert.equal(control(2, { ctrlKey: true }), "rotate");
  assert.equal(control(0, { altKey: true }), "moveToPointer");
  assert.equal(control(0, { ctrlKey: true }), "rotateToPointer");
  assert.equal(control(0, { metaKey: true }), "rotateToPointer", "Cmd counts as Ctrl");
  assert.equal(control(0, { ctrlKey: true, altKey: true }), "moveToPointer", "Alt first, as before");
  assert.equal(control(0, { altKey: true, shiftKey: true }), "moveToPointer");
  assert.equal(control(0, { altKey: true }, false), null, "nothing selected: the left button's own (select, box)");
  for (const mods of [{}, { shiftKey: true }] as M[]) assert.equal(control(0, mods), null, JSON.stringify(mods));
  assert.equal(control(3), null, "back and forward do nothing");
  // The wheel zooms, with or without modifiers; Wheel Up comes nearer.
  const wheel = (deltaY: number, mods: M = {}) => {
    const chord = mouseChord({ type: "wheel", button: 0, deltaY, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    return chord ? mouseCommandsFor(bindings, chord, { terrainFocus: true }) : [];
  };
  assert.deepEqual(wheel(-100), ["w3.terrain.camera.zoomIn"]);
  assert.deepEqual(wheel(100, { ctrlKey: true }), ["w3.terrain.camera.zoomOut"]);
  // Their commands are held, not run, and declared.
  const declared = new Set((manifest as unknown as { contributes: { commands: { id: string }[] } }).contributes.commands.map((c) => c.id));
  for (const id of [...Object.values(MOUSE_CONTROLS), AREA_COMMAND]) { assert.ok(HELD_COMMANDS.has(id), id); assert.ok(declared.has(id), id); assert.equal(runsAsCommand(id), false, id); }
});

test("Undo's keys reach the map too (its editor says undoKeys), but the view doesn't run them: the editor's handler does", () => {
  // With the workbench's Undo and Redo bindings, Ctrl+Z on the canvas is bound to workbench.undo there; run by the view
  // as one of "the other commands bound here" as well, a resize was undone twice (app-smoke resizeUndo).
  const all = [...defaultBindings([], UNDO_BINDINGS), ...bindings];
  const ctx = { terrainFocus: true, [UNDO_CONTEXT]: true };
  for (const chord of ["ctrl+z", "ctrl+y", "ctrl+shift+z"]) {
    const ids = commandsFor(all, chord, ctx);
    assert.ok(ids.length > 0, `${chord} is bound on the map (control)`);
    assert.equal(ids.find(runsAsCommand), undefined, chord);
  }
});

test("Escape cancels, A held selects an area (Shift too, not with Ctrl or Alt)", () => {
  const plain = { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.deepEqual(bound({ ...plain, key: "Escape" }), [CANCEL_COMMAND]);
  assert.ok(bound({ ...plain, key: "a" }).includes(AREA_COMMAND));
  assert.ok(bound({ ...plain, key: "A", shiftKey: true }).includes(AREA_COMMAND));
  assert.ok(bound({ ...plain, key: "Unidentified", code: "KeyA" }).includes(AREA_COMMAND), "WebKitGTK's unnamed key");
  for (const mods of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) assert.equal(bound({ ...plain, key: "a", ...mods }).includes(AREA_COMMAND), false, JSON.stringify(mods));
  assert.equal(runsAsCommand(CANCEL_COMMAND), false);
});

test("a size has a floor, and no drift from adding fractions", () => {
  assert.deepEqual(scaled([1, 1, 1], [0.05, 0.05, 0]), [1.05, 1.05, 1]);
  assert.deepEqual(scaled([0.05, 0.05, 0.05], [-0.05, -0.05, -0.05]), [0.05, 0.05, 0.05]);
  assert.deepEqual(scaled([1.1, 1, 1], [0.1, 0, 0]), [1.2, 1, 1]);
});
