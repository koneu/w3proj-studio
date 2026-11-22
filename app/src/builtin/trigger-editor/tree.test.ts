import assert from "node:assert/strict";
import { test } from "node:test";
import { writeWtg, type TriggerFile } from "../../lib/triggers/wtg";
import { applyExpanded, childrenOf, collapsedOf, moveItem, onlyFoldsUnsaved, subtree, treeStructure } from "./tree";

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

/** Two categories sharing an id, as World Editor maps have them (Forsaken07Interlude: "Initialization" and "MapEvents"
 *  both 0x2000003): each with its own triggers, the second with a subcategory. Items in file order (a preorder). */
const sharedIds = (): TriggerFile => {
  const t = (name: string, id: number, parent: number) => ({ type: 8 as const, name, description: "", isComment: 0, id, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent, ecas: [] });
  const c = (name: string, id: number, parent: number) => ({ type: 4 as const, id, name, isComment: 0, expanded: 1, parent });
  return {
    reforged: true, version: 7, unknown: 2, counts: Array.from({ length: 8 }, () => ({ count: 9, deleted: [] })), variables: [],
    items: [
      { type: 1, id: 0, name: "Map", isComment: 0, expanded: 1, parent: -1 },
      c("Initialization", 0x2000003, 0), t("Melee Initialization", 0x3000001, 0x2000003), t("Intro", 0x3000002, 0x2000003),
      c("MapEvents", 0x2000003, 0), t("Boss Dies", 0x3000003, 0x2000003), c("Sub", 0x2000004, 0x2000003), t("Deep", 0x3000004, 0x2000004),
      t("At Root", 0x3000005, 0),
    ],
  };
};

test("a category's contents come from the tree's structure: another category with the same id keeps its own", () => {
  const f = sharedIds();
  const [init, events] = f.items.filter((i) => i.type === 4 && i.id === 0x2000003);
  const names = (items: { name: string }[]) => items.map((i) => i.name);
  assert.deepEqual(names(subtree(f, init)), ["Initialization", "Melee Initialization", "Intro"]);
  assert.deepEqual(names(subtree(f, events)), ["MapEvents", "Boss Dies", "Sub", "Deep"]);
  assert.deepEqual(names(childrenOf(f, init)), ["Melee Initialization", "Intro"]);
  assert.deepEqual(names(childrenOf(f, null)), ["Initialization", "MapEvents", "At Root"]);
  const s = treeStructure(f);
  assert.equal(s.parentOf.get(f.items.find((i) => i.name === "Boss Dies")!), events);
  assert.equal(s.parentOf.get(f.items.find((i) => i.name === "Deep")!)?.name, "Sub");
  // Control: by id alone the two categories' triggers are one list.
  assert.equal(f.items.filter((i) => i.parent === init.id && i.type === 8).length, 3);
});

test("moving a category with a shared id takes its own contents along, and a classic file reads by id", () => {
  const f = sharedIds();
  const events = f.items.find((i) => i.name === "MapEvents")!, init = f.items.find((i) => i.name === "Initialization")!;
  moveItem(f, events, init, "before");
  assert.deepEqual(f.items.map((i) => i.name), ["Map", "MapEvents", "Boss Dies", "Sub", "Deep", "Initialization", "Melee Initialization", "Intro", "At Root"]);
  assert.deepEqual(subtree(f, init).map((i) => i.name), ["Initialization", "Melee Initialization", "Intro"]);
  // Classic: categories first, then the triggers naming one by id.
  const classic: TriggerFile = { ...file(false), items: [
    { type: 4, id: 0, name: "A", isComment: 0, expanded: 1, parent: -1 }, { type: 4, id: 1, name: "B", isComment: 0, expanded: 1, parent: -1 },
    { type: 8, name: "In B", description: "", isComment: 0, id: 0, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 1, ecas: [] },
  ] };
  assert.deepEqual(subtree(classic, classic.items[1]).map((i) => i.name), ["B", "In B"]);
  assert.deepEqual(subtree(classic, classic.items[0]).map((i) => i.name), ["A"]);
});

test("only folds unsaved: toggles at the saved state, nothing typed", () => {
  const s = { state: 3, savedAt: 3, toggles: 2, savedToggles: 0, pendingName: false };
  assert.equal(onlyFoldsUnsaved(s), true);
  // controls: each other kind of unsaved change, and a clean editor, says no
  assert.equal(onlyFoldsUnsaved({ ...s, state: 4 }), false);
  assert.equal(onlyFoldsUnsaved({ ...s, pendingName: true }), false);
  assert.equal(onlyFoldsUnsaved({ ...s, toggles: 0 }), false);
});
