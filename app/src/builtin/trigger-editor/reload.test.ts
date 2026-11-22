import assert from "node:assert/strict";
import { test } from "node:test";
import { textTriggers, type Item, type TriggerFile, type TriggerItem } from "../../lib/triggers/wtg";
import { mergeReload, sameTree, type ReloadSide } from "./reload";

const trig = (name: string, id: number, parent: number, over: Partial<TriggerItem> = {}): TriggerItem =>
  ({ type: 8, name, description: "", isComment: 0, id, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent, ecas: [], ...over });
const cat = (name: string, id: number, parent = 0): Item => ({ type: 4, id, name, isComment: 0, expanded: 1, parent });

/** A tree read from map/triggers/: two categories, a GUI trigger, a custom text and a variable; each item with its file. */
function base(): ReloadSide {
  const file: TriggerFile = {
    reforged: true, version: 7, unknown: 2, counts: Array.from({ length: 8 }, () => ({ count: 0, deleted: [] })),
    variables: [{ name: "Gold", type: "integer", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 0x6000000, parent: 0x2000000 }],
    items: [
      { type: 1, id: 0, name: "Map", isComment: 0, expanded: 1, parent: -1 },
      cat("Setup", 0x2000000), trig("Start", 0x3000000, 0x2000000), trig("Script", 0x3000001, 0x2000000, { isCustom: true }),
      { type: 64, id: 0x6000000, name: "Gold", parent: 0x2000000 },
      cat("Combat", 0x2000001), trig("Fight", 0x3000002, 0x2000001),
    ],
  };
  const files = [null, "map/triggers/Setup", "map/triggers/Setup/Start.gui.json", "map/triggers/Setup/Script.j", null, "map/triggers/Combat", "map/triggers/Combat/Fight.gui.json"];
  return { file, texts: [null, "// script", null], header: "// header", files };
}

const clone = (s: ReloadSide): ReloadSide => structuredClone(s);
const named = (s: { file: TriggerFile }, name: string) => s.file.items.find((i) => i.name === name) as TriggerItem;
const textOf = (r: { file: TriggerFile; texts: (string | null)[] }, name: string) => r.texts[textTriggers(r.file).findIndex((t) => t.name === name)];

test("a trigger changed here keeps its change; the others take the files' changes; no conflict when the files left it alone", () => {
  const b = base(), mine = clone(b), theirs = clone(b);
  named(mine, "Start").enabled = false;
  named(theirs, "Fight").description = "from git";
  theirs.texts[1] = "// script from git";
  theirs.header = "// header from git";
  const r = mergeReload(b, mine, theirs);
  assert.equal(named(r, "Start").enabled, false, "mine kept");
  assert.equal(named(r, "Fight").description, "from git", "theirs taken");
  assert.equal(textOf(r, "Script"), "// script from git");
  assert.equal(r.header, "// header from git");
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.kept, 1);
});

test("a trigger changed on both sides keeps mine and is a conflict; mine's text goes with it", () => {
  const b = base(), mine = clone(b), theirs = clone(b);
  mine.texts[1] = "// mine";
  theirs.texts[1] = "// theirs";
  named(mine, "Fight").name = "Fight Mine";
  named(theirs, "Fight").name = "Fight Theirs";
  mine.header = "// my header";
  theirs.header = "// their header";
  const r = mergeReload(b, mine, theirs);
  assert.equal(textOf(r, "Script"), "// mine");
  assert.ok(named(r, "Fight Mine") && !named(r, "Fight Theirs"));
  assert.equal(r.header, "// my header");
  assert.deepEqual(r.conflicts.sort(), ["#header", "map/triggers/Combat/Fight.gui.json", "map/triggers/Setup/Script.j"]);
});

test("added and removed items: the files' new trigger appears, mine stays where I put it, a removal holds unless changed there", () => {
  const b = base(), mine = clone(b), theirs = clone(b);
  // Mine: a new trigger after Start (no file yet), and Fight removed.
  mine.file.items.splice(3, 0, trig("New Here", 0x3000009, 0x2000000));
  mine.texts.splice(1, 0, null);
  mine.files.splice(3, 0, null);
  const fight = mine.file.items.findIndex((i) => i.name === "Fight");
  mine.file.items.splice(fight, 1);
  mine.files.splice(fight, 1);
  mine.texts.pop();
  // Theirs: a new trigger in Combat, with an id that mine's new one also has.
  theirs.file.items.push(trig("From Git", 0x3000009, 0x2000001));
  theirs.files.push("map/triggers/Combat/From_Git.gui.json");
  theirs.texts.push(null);
  const r = mergeReload(b, mine, theirs);
  assert.deepEqual(r.file.items.map((i) => i.name), ["Map", "Setup", "Start", "New Here", "Script", "Gold", "Combat", "From Git"]);
  const ids = r.file.items.filter((i) => i.type === 8).map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "ids stay unique");
  assert.equal(named(r, "New Here").parent, 0x2000000);
  assert.deepEqual(r.conflicts, []);
  // Removed here but changed in the files: theirs stays, flagged.
  const theirs2 = clone(b);
  named(theirs2, "Fight").enabled = false;
  const r2 = mergeReload(b, mine, theirs2);
  assert.ok(named(r2, "Fight"));
  assert.deepEqual(r2.conflicts, ["map/triggers/Combat/Fight.gui.json"]);
});

test("sameTree: the same files whatever ids memory gave; a change of any item, text, header or variable is another", () => {
  const b = base(), other = clone(b);
  for (const it of other.file.items) if (it.type === 8) it.id += 0x100;
  assert.equal(sameTree(b, other), true);
  for (const change of [
    (s: ReloadSide) => { named(s, "Fight").enabled = false; },
    (s: ReloadSide) => { s.texts[1] = "// other"; },
    (s: ReloadSide) => { s.header = null; },
    (s: ReloadSide) => { s.file.variables[0].initialValue = "1"; },
  ]) {
    const c = clone(b);
    change(c);
    assert.equal(sameTree(b, c), false);
  }
});

test("variables: one added here comes along with its node, one removed in the files goes, a both-sides change keeps mine", () => {
  const b = base(), mine = clone(b), theirs = clone(b);
  mine.file.variables.push({ name: "Wood", type: "integer", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 0x6000001, parent: 0x2000001 });
  mine.file.items.push({ type: 64, id: 0x6000001, name: "Wood", parent: 0x2000001 });
  mine.files.push(null);
  mine.file.variables[0].initialValue = "5";
  theirs.file.variables[0].initialValue = "7";
  const r = mergeReload(b, mine, theirs);
  assert.deepEqual(r.file.variables.map((v) => [v.name, v.initialValue]), [["Gold", "5"], ["Wood", ""]]);
  const wood = r.file.items.find((i) => i.type === 64 && i.name === "Wood")!;
  assert.equal(wood.id, r.file.variables[1].id);
  assert.equal(wood.parent, named(r, "Combat").id);
  assert.deepEqual(r.conflicts, ["$Gold"]);
  // Control: nothing changed here, the files' removal of a variable holds.
  const gone = clone(b);
  gone.file.variables = [];
  gone.file.items = gone.file.items.filter((i) => i.type !== 64);
  gone.files = gone.files.filter((_, i) => b.file.items[i].type !== 64);
  const r2 = mergeReload(b, clone(b), gone);
  assert.deepEqual(r2.file.variables, []);
  assert.equal(r2.file.items.some((i) => i.type === 64), false);
});
