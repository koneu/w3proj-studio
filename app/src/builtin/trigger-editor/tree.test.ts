import assert from "node:assert/strict";
import { test } from "node:test";
import { writeWtg, type TriggerFile } from "../../lib/triggers/wtg";
import { applyExpanded, collapsedOf, onlyFoldsUnsaved } from "./tree";

const file = (reforged = true): TriggerFile => ({
  reforged, version: 7, unknown: 0, counts: reforged ? Array.from({ length: 8 }, () => ({ count: 0, deleted: [] })) : [], variables: [],
  items: [
    { type: 1, id: 1, name: "Map", isComment: 0, expanded: 1, parent: -1 },
    { type: 4, id: 2, name: "Open", isComment: 0, expanded: 1, parent: 1 },
    { type: 4, id: 3, name: "Closed", isComment: 0, expanded: 0, parent: 1 },
    // Neither 0 nor 1 (seen as open): kept as it is unless the tree closes it.
    { type: 4, id: 4, name: "Odd", isComment: 0, expanded: 2, parent: 1 },
    { type: 2, id: 5, name: "Library", isComment: 0, expanded: 0, parent: 1 },
    // A trigger with a closed category's id: not a category, never changed.
    { type: 8, name: "T", description: "", isComment: 0, id: 3, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 2, ecas: [] },
  ],
});

test("the tree opens as the file says: its closed categories and libraries", () => {
  assert.deepEqual([...collapsedOf(file())].sort(), [3, 5]);
});

test("a tree as the file opened it changes no byte of the file", () => {
  const f = file(), bytes = writeWtg(f);
  applyExpanded(f, collapsedOf(f));
  assert.deepEqual(writeWtg(f), bytes);
});

test("toggled categories are written into the file, others keep their flag", () => {
  const f = file(), collapsed = collapsedOf(f);
  collapsed.add(2);
  collapsed.delete(3);
  collapsed.delete(5);
  applyExpanded(f, collapsed);
  const flags = f.items.filter((i) => "expanded" in i).map((i) => "expanded" in i && i.expanded);
  assert.deepEqual(flags, [1, 0, 1, 2, 1]);
  collapsed.add(4);
  applyExpanded(f, collapsed);
  assert.equal(f.items.find((i) => i.id === 4 && "expanded" in i && i.type === 4 && i.expanded === 0)?.name, "Odd");
});

test("a classic file doesn't store it: nothing changes", () => {
  const f = file(false), before = structuredClone(f);
  applyExpanded(f, new Set([2]));
  assert.deepEqual(f, before);
});

test("only folds unsaved: toggles at the saved state, nothing typed", () => {
  const s = { state: 3, savedAt: 3, toggles: 2, savedToggles: 0, pendingName: false };
  assert.equal(onlyFoldsUnsaved(s), true);
  // controls: each other kind of unsaved change, and a clean editor, says no
  assert.equal(onlyFoldsUnsaved({ ...s, state: 4 }), false);
  assert.equal(onlyFoldsUnsaved({ ...s, pendingName: true }), false);
  assert.equal(onlyFoldsUnsaved({ ...s, toggles: 0 }), false);
});
