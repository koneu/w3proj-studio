import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { listCommandOf, LIST_COMMANDS, moveInList, stepInList } from "./objectlist";
import { commandsFor, defaultBindings, eventChord } from "../keybindings";

// The list keys are the terrain viewer's default bindings (extension.json), read as the view reads them: what a key is
// bound to under terrainFocus, then the first list command among those.
const manifest = JSON.parse(readFileSync("src/builtin/terrain-viewer/extension.json", "utf8")) as { contributes: { commands: { id: string }[]; keybindings: { key: string; command: string; when?: string }[] } };
const bindings = defaultBindings([], manifest.contributes.keybindings);
const listKey = (e: { key: string; code?: string; ctrlKey: boolean; metaKey?: boolean; altKey: boolean; shiftKey: boolean }) => {
  const chord = eventChord(e);
  return chord ? listCommandOf(commandsFor(bindings, chord, { terrainFocus: true })) : null;
};

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test("the list commands are declared commands, and only outside terrainFocus their keys do nothing", () => {
  const ids = new Set(manifest.contributes.commands.map((c) => c.id));
  for (const id of Object.keys(LIST_COMMANDS)) assert.ok(ids.has(id), id);
  assert.equal(listCommandOf(commandsFor(bindings, "ctrl+tab", {})), null, "outside the map");
  assert.equal(listCommandOf(["toString", "constructor"]), null, "names of an object's own aren't commands");
});

test("listKey: the World Editor's keys for its list items, with their modifiers exactly", () => {
  assert.equal(listKey(key("Tab", { ctrlKey: true })), "next");
  assert.equal(listKey(key("Tab", { ctrlKey: true, shiftKey: true })), "previous");
  assert.equal(listKey(key("PageUp", { ctrlKey: true })), "up");
  assert.equal(listKey(key("PageDown", { metaKey: true })), "down");
  for (const k of [key("Tab"), key("PageUp"), key("PageDown"), key("Tab", { altKey: true, ctrlKey: true }), key("PageUp", { ctrlKey: true, shiftKey: true }), key("a", { ctrlKey: true })]) {
    assert.equal(listKey(k), null, JSON.stringify(k));
  }
});

test("listKey: WebKitGTK's Ctrl+Shift+Tab (key Unidentified, code Tab) is Select Previous", () => {
  const gtk = (mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ ...key("Unidentified", mods), code: "Tab" });
  assert.equal(listKey(gtk({ ctrlKey: true, shiftKey: true })), "previous");
  assert.equal(listKey({ ...key("Unidentified", { ctrlKey: true }), code: "PageDown" }), "down");
  // Control: without Ctrl, or with another physical key, it's nothing.
  assert.equal(listKey(gtk({ shiftKey: true })), null);
  assert.equal(listKey({ ...key("Unidentified", { ctrlKey: true, shiftKey: true }), code: "KeyQ" }), null);
});

test("stepInList: next and previous go round; with nothing selected the first or the last", () => {
  const l = ["a", "b", "c"];
  assert.equal(stepInList(l, "a", 1), "b");
  assert.equal(stepInList(l, "c", 1), "a");
  assert.equal(stepInList(l, "a", -1), "c");
  assert.equal(stepInList(l, null, 1), "a");
  assert.equal(stepInList(l, null, -1), "c");
  assert.equal(stepInList(l, "gone", 1), "a");
  assert.equal(stepInList([], null, 1), null);
});

test("moveInList: one place up or down, nothing past the ends", () => {
  const l = ["a", "b", "c"];
  assert.deepEqual(moveInList(l, "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveInList(l, "b", 1), ["a", "c", "b"]);
  assert.equal(moveInList(l, "a", -1), null);
  assert.equal(moveInList(l, "c", 1), null);
  assert.equal(moveInList(l, "x", 1), null);
  assert.deepEqual(l, ["a", "b", "c"], "the list itself stays");
});
