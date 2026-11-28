import assert from "node:assert/strict";
import { test } from "node:test";
import { History } from "../../lib/undo";
import { ObjectLedger } from "./objectledger";

interface Obj { base: string; id?: string; mods: { field: string; value: string | number }[] }
interface File { custom: Obj[]; original: Obj[] }

/** A file of `n` custom objects (and some standard ones), the kind of size a big map has. */
const generated = (n: number): File => ({
  custom: Array.from({ length: n }, (_, i) => ({ base: "hfoo", id: `u${String(i).padStart(3, "0")}`, mods: [{ field: "unam", value: `Footman ${i}` }, { field: "uhpm", value: 420 + i }] })),
  original: Array.from({ length: 20 }, (_, i) => ({ base: `o${String(i).padStart(3, "0")}`, mods: i % 2 ? [{ field: "uhpm", value: i }] : [] })),
});

const make = (file: File, strings = { now: "" }) => {
  const ledger = new ObjectLedger<Obj>(file, {
    hasMods: (o) => o.mods.length > 0,
    head: () => "v3",
    extra: { take: () => strings.now, put: (s) => { strings.now = s; } },
    limit: 199,
  });
  ledger.markSaved(ledger.point());
  return ledger;
};

/** Runs `work` and tells how many characters JSON.stringify produced meanwhile, and in how many calls. */
function stringified(work: () => void): { chars: number; calls: number } {
  const real = JSON.stringify;
  let chars = 0, calls = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const out = real(...args);
    calls++;
    chars += out?.length ?? 0;
    return out;
  }) as typeof JSON.stringify;
  try { work(); } finally { JSON.stringify = real; }
  return { chars, calls };
}

test("an edit in a file of 1000+ objects serialises only the object it touched: no file-sized string for undo or for the dirty check", () => {
  const file = generated(1500);
  const ledger = make(file);
  const whole = JSON.stringify(file).length;
  const o = file.custom[700];
  const cost = stringified(() => {
    o.mods[0].value = "Renamed";
    assert.equal(ledger.commit([o]), true);
    assert.equal(ledger.differs(), true);
  });
  assert.equal(cost.calls, 1, "one call: the touched object");
  assert.ok(cost.chars < 300 && cost.chars * 100 < whole, `${cost.chars} characters for a file of ${whole}`);
  // Undo and redo and the dirty check after them serialise nothing at all.
  const moving = stringified(() => { ledger.undo(); assert.equal(ledger.differs(), false); ledger.redo(); assert.equal(ledger.differs(), true); });
  assert.equal(moving.calls, 0);
});

test("control: the counter does see a whole-file snapshot per edit (how undo and the dirty check used to work)", () => {
  const file = generated(1500);
  const whole = JSON.stringify(file).length;
  const history = new History(() => JSON.stringify(file), () => {});
  const cost = stringified(() => {
    file.custom[700].mods[0].value = "Renamed";
    history.commit();
    void (JSON.stringify(file) !== "saved");
  });
  assert.ok(cost.chars >= 1.5 * whole, `the old way wrote ${cost.chars} characters`);
});

test("one edit is one undo step, whatever objects it touched; undo and redo put the content back in the same objects", () => {
  const file = generated(10);
  const ledger = make(file);
  const [a, b] = [file.custom[1], file.custom[2]];
  a.mods[1].value = 1; b.mods[1].value = 2;
  assert.equal(ledger.commit([a, b]), true);
  a.mods.push({ field: "usca", value: 3 });
  assert.equal(ledger.commit([a]), true);
  assert.equal(ledger.undo(), true);
  assert.deepEqual(a.mods.map((m) => m.field), ["unam", "uhpm"]);
  assert.equal(a.mods[1].value, 1, "the first edit stays");
  assert.equal(ledger.undo(), true);
  assert.equal(a.mods[1].value, 421);
  assert.equal(b.mods[1].value, 422, "both objects of the first edit are back with one undo");
  assert.equal(file.custom[1], a, "the same object, not a copy");
  assert.equal(ledger.undo(), false);
  assert.equal(ledger.redo(), true);
  assert.equal(a.mods[1].value, 1);
  assert.equal(b.mods[1].value, 2);
  // A new edit drops what could be redone.
  b.mods[0].value = "x";
  ledger.commit([b]);
  assert.equal(ledger.canRedo, false);
});

test("a change that changes nothing, or touches nothing, leaves no history entry", () => {
  const file = generated(5);
  const ledger = make(file);
  assert.equal(ledger.commit([file.custom[0]]), false);
  assert.equal(ledger.commit("all"), false);
  assert.equal(ledger.commit([]), false);
  file.custom[0].mods[0].value = file.custom[0].mods[0].value; // set to what it is
  assert.equal(ledger.commit([file.custom[0]]), false);
  assert.equal(ledger.canUndo, false);
  assert.equal(ledger.differs(), false);
});

test("unsaved: undo back to the saved state is clean, an edit changed back by hand too, and an undo past the save is unsaved", () => {
  const file = generated(5);
  const ledger = make(file);
  const o = file.custom[2];
  o.mods[1].value = 9;
  ledger.commit([o]);
  assert.equal(ledger.differs(), true);
  ledger.undo();
  assert.equal(ledger.differs(), false, "undone to the saved state");
  ledger.redo();
  o.mods[1].value = 422; // typed back to what it was
  ledger.commit([o]);
  assert.equal(ledger.differs(), false, "the same content as saved is clean");
  // Save here, edit, then undo past the save point.
  o.mods[1].value = 10;
  ledger.commit([o]);
  ledger.markSaved(ledger.point());
  assert.equal(ledger.differs(), false);
  ledger.undo();
  assert.equal(ledger.differs(), true, "back before the save: unsaved");
  ledger.redo();
  assert.equal(ledger.differs(), false, "and forward to it: saved again");
});

test("an edit made while a save writes stays unsaved: the save marks the point taken when it began", () => {
  const file = generated(5);
  const ledger = make(file);
  const o = file.custom[0];
  o.mods[0].value = "first";
  ledger.commit([o]);
  const written = ledger.point(); // the save begins
  o.mods[0].value = "second"; // typed while it writes
  ledger.commit([o]);
  ledger.markSaved(written); // the save ends
  assert.equal(ledger.differs(), true);
  ledger.undo();
  assert.equal(ledger.differs(), false, "undo to what the file holds is clean");
});

test("adding, removing and reordering objects are steps too; a standard object without modifications isn't part of the file", () => {
  const file = generated(4);
  const ledger = make(file);
  const added: Obj = { base: "hfoo", id: "uNEW", mods: [] };
  file.custom.push(added);
  assert.equal(ledger.commit([]), true);
  assert.equal(ledger.differs(), true);
  ledger.undo();
  assert.equal(file.custom.length, 4);
  assert.equal(ledger.differs(), false);
  ledger.redo();
  assert.equal(file.custom.at(-1), added);
  // Removing: the object and its edits come back with an undo.
  const gone = file.custom[0];
  gone.mods[0].value = "edited before removal";
  ledger.commit([gone]);
  file.custom = file.custom.filter((o) => o !== gone);
  ledger.commit([]);
  ledger.undo();
  assert.equal(file.custom[0], gone);
  assert.equal(gone.mods[0].value, "edited before removal");
  ledger.undo();
  assert.equal(gone.mods[0].value, "Footman 0");
});

test("a standard entry added empty is not a change to the file; with a modification it is", () => {
  const file = generated(2);
  const ledger = make(file);
  file.original.push({ base: "zzzz", mods: [] });
  ledger.commit([]);
  assert.equal(ledger.differs(), false);
  file.original.at(-1)!.mods.push({ field: "uhpm", value: 1 });
  ledger.commit([file.original.at(-1)!]);
  assert.equal(ledger.differs(), true);
  ledger.undo();
  assert.equal(ledger.differs(), false);
});

test("the editor's other state (its strings) goes back with each step, and a change to it alone is a step", () => {
  const file = generated(3);
  const strings = { now: "s0" };
  const ledger = make(file, strings);
  strings.now = "s1";
  assert.equal(ledger.commit([]), true);
  const o = file.custom[0];
  o.mods[0].value = "x";
  strings.now = "s2";
  ledger.commit([o]);
  ledger.undo();
  assert.equal(strings.now, "s1");
  ledger.undo();
  assert.equal(strings.now, "s0");
  ledger.redo();
  ledger.redo();
  assert.equal(strings.now, "s2");
  assert.equal(o.mods[0].value, "x");
});

test("199 undo steps are kept, the oldest go first", () => {
  const file = generated(2);
  const ledger = make(file);
  for (let i = 1; i <= 205; i++) { file.custom[0].mods[1].value = i; ledger.commit([file.custom[0]]); }
  let steps = 0;
  while (ledger.undo()) steps++;
  assert.equal(steps, 199);
  assert.equal(file.custom[0].mods[1].value, 6, "205 edits, the first 6 can't be taken back");
});

test("objects of an outside change are taken as the new start; the saved point is what the caller says it is", () => {
  const file = generated(3);
  const ledger = make(file);
  file.custom[1].mods[0].value = "mine";
  ledger.commit([file.custom[1]]);
  const theirs = generated(3);
  theirs.custom[0].mods[0].value = "theirs";
  file.custom = [theirs.custom[0], file.custom[1], theirs.custom[2]];
  ledger.markSaved(ledger.pointOf("v3", theirs.custom, theirs.original));
  ledger.reset();
  assert.equal(ledger.canUndo, false);
  assert.equal(ledger.differs(), true, "my edit is still unsaved");
  file.custom[1].mods[0].value = "Footman 1";
  ledger.commit([file.custom[1]]);
  assert.equal(ledger.differs(), false);
});

test("a changed file head (version) is unsaved", () => {
  const file = generated(1);
  let head = "v3";
  const ledger = new ObjectLedger<Obj>(file, { hasMods: (o) => o.mods.length > 0, head: () => head, extra: { take: () => "", put: () => {} }, limit: 10 });
  ledger.markSaved(ledger.point());
  head = "v2";
  assert.equal(ledger.differs(), true);
});
