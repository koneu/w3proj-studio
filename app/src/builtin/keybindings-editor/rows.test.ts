import assert from "node:assert/strict";
import { test } from "node:test";
import { keyLabel, normalizeKey } from "../../lib/keybindings";
import { parseQuery, rowsOf, type Item } from "./rows";

const items: Item[] = [
  { command: "w3.terrain.cycleGrid", title: "Grid Display", category: "Terrain", bindings: [{ key: "g", command: "w3.terrain.cycleGrid", when: "terrainFocus", source: "default", extensionId: "w3.terrainViewer" }], userTouched: false },
  { command: "w3.terrain.camera.panUp", title: "Camera - Translate Up", category: "Terrain", bindings: [
    { key: "up", command: "w3.terrain.camera.panUp", when: "terrainFocus", source: "default" },
    { key: "numpad8", command: "w3.terrain.camera.panUp", when: "terrainFocus", source: "default" }], userTouched: false },
  { command: "workbench.save", title: "Save", category: "File", bindings: [{ key: "ctrl+alt+s", command: "workbench.save", source: "user" }], userTouched: true },
  { command: "w3.map.new", title: "New Map…", category: "Project", bindings: [], userTouched: false },
];
const rows = (q: string) => rowsOf(items, parseQuery(q, normalizeKey), keyLabel).map((r) => `${r.item.command}${r.binding ? `=${r.binding.key}` : ""}`);

test("a row per key, one for a command without; commands with keys first", () => {
  assert.deepEqual(rows(""), ["workbench.save=ctrl+alt+s", "w3.terrain.camera.panUp=up", "w3.terrain.camera.panUp=numpad8", "w3.terrain.cycleGrid=g", "w3.map.new"]);
});

test("a search finds commands, titles, keys as written and as read, when and source", () => {
  assert.deepEqual(rows("grid"), ["w3.terrain.cycleGrid=g"]);
  assert.deepEqual(rows("NumPad 8"), ["w3.terrain.camera.panUp=numpad8"]);
  assert.deepEqual(rows("ctrl+alt"), ["workbench.save=ctrl+alt+s"]);
  assert.deepEqual(rows("terrain translate"), ["w3.terrain.camera.panUp=up", "w3.terrain.camera.panUp=numpad8"]);
  assert.deepEqual(rows("@source:user"), ["workbench.save=ctrl+alt+s"]);
  assert.deepEqual(rows("@source:none"), ["w3.map.new"]);
  assert.deepEqual(rows("@key:G"), ["w3.terrain.cycleGrid=g"], "a key exactly, written any way");
  assert.deepEqual(rows("@key:Ctrl+Alt+S"), ["workbench.save=ctrl+alt+s"]);
  assert.deepEqual(rows("@command:w3.map.new"), ["w3.map.new"]);
  assert.deepEqual(rows("nothing-like-this"), []);
});
