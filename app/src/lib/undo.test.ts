import assert from "node:assert/strict";
import { test } from "node:test";
import { History, StateStack, StepHistory } from "./undo";

/** A history over a small document. */
function setup() {
  const box = { doc: { name: "a", n: 1 } };
  const h = new History(() => JSON.stringify(box.doc), (s) => { box.doc = JSON.parse(s); });
  return { box, h };
}

test("a commit without a change records nothing", () => {
  const { h } = setup();
  assert.equal(h.commit(), false);
  assert.equal(h.canUndo, false);
  assert.equal(h.dirty, false);
});

test("typing in one field visit is one step; undoing to the saved state is clean", () => {
  const { box, h } = setup();
  const visit = {};
  for (const s of ["ab", "abc"]) { box.doc.name = s; h.commit(visit); }
  box.doc.n = 2; h.commit();
  assert.equal(h.dirty, true);
  h.undo();
  assert.deepEqual(box.doc, { name: "abc", n: 1 });
  h.undo();
  assert.deepEqual(box.doc, { name: "a", n: 1 });
  assert.equal(h.dirty, false);
  assert.equal(h.undo(), false);
  h.redo(); h.redo();
  assert.deepEqual(box.doc, { name: "abc", n: 2 });
});

test("saving moves the clean point; a new change drops redo", () => {
  const { box, h } = setup();
  box.doc.n = 2; h.commit();
  h.markSaved();
  assert.equal(h.dirty, false);
  h.undo();
  assert.equal(h.dirty, true);
  box.doc.n = 5; h.commit();
  assert.equal(h.canRedo, false);
});

test("a group ends at undo", () => {
  const { box, h } = setup();
  const visit = {};
  box.doc.name = "x"; h.commit(visit);
  h.undo();
  box.doc.name = "y"; h.commit(visit);
  h.undo();
  assert.equal(box.doc.name, "a");
});

/** An editor over a StateStack as the stack editors use it: `change` pushes the state before, undo/redo swap. */
function stackSetup() {
  const s = new StateStack<{ n: number }>();
  const box = { state: { n: 0 } };
  const change = (n: number) => { s.push(box.state); box.state = { n }; };
  const step = (dir: "undo" | "redo") => { const next = s.move(dir, () => box.state); if (next) box.state = next; return !!next; };
  return { s, box, change, step };
}

test("state stack: each push is one step; undo and redo give the states back in order; a new change drops redo", () => {
  const { s, box, change, step } = stackSetup();
  assert.equal(s.dirty, false);
  assert.equal(step("undo"), false);
  change(1); change(2);
  assert.equal(s.dirty, true);
  assert.ok(step("undo"));
  assert.deepEqual(box.state, { n: 1 });
  assert.ok(step("undo"));
  assert.deepEqual(box.state, { n: 0 });
  assert.equal(s.dirty, false);
  assert.equal(s.canUndo, false);
  assert.ok(step("redo"));
  assert.deepEqual(box.state, { n: 1 });
  change(5);
  assert.equal(s.canRedo, false);
  assert.equal(s.peek("undo")?.n, 1);
});

test("state stack: the saved depth is clean; an edit, undo or redo during the save stays unsaved; an undone save point is lost", () => {
  const { s, change, step } = stackSetup();
  change(1);
  let taken = s.take();
  s.saved(taken);
  assert.equal(s.dirty, false);
  step("undo");
  assert.equal(s.dirty, true);
  step("redo");
  assert.equal(s.dirty, false);
  // An edit while the save writes.
  taken = s.take();
  change(2);
  s.saved(taken);
  assert.equal(s.dirty, true);
  // An undo and redo while the save writes, back at the depth it took: still unsaved (which state the file holds
  // isn't known by depth).
  taken = s.take();
  step("undo");
  step("redo");
  s.saved(taken);
  assert.equal(s.dirty, true);
  // A save point undone past and replaced by another change can't be reached again (same depth, other state).
  s.saved(s.take());
  step("undo");
  change(4);
  assert.equal(s.dirty, true);
});

test("history limit: the oldest steps go; without one every step stays", () => {
  const box = { n: 0 };
  const h = new History(() => String(box.n), (s) => { box.n = Number(s); }, { limit: 3 });
  for (let i = 1; i <= 5; i++) { box.n = i; h.commit(); }
  let undone = 0;
  while (h.undo()) undone++;
  assert.equal(undone, 3);
  assert.equal(box.n, 2);
  // Redo still reaches the newest state.
  while (h.redo());
  assert.equal(box.n, 5);
  // A group is one step: its first commit drops the oldest (2), the next of the group drops none.
  const g = {};
  box.n = 6; h.commit(g);
  box.n = 7; h.commit(g);
  while (h.undo());
  assert.equal(box.n, 3);

  box.n = 0;
  const free = new History(() => String(box.n), (s) => { box.n = Number(s); });
  for (let i = 1; i <= 300; i++) { box.n = i; free.commit(); }
  while (free.undo());
  assert.equal(box.n, 0);
});

test("step history: labelled steps in order, ids unique, a new step drops redo", () => {
  const h = new StepHistory<string>();
  assert.equal(h.state, 0);
  assert.equal(h.undo(), undefined);
  const a = h.push("A", "a"), b = h.push("B", "b");
  assert.notEqual(a, b);
  assert.equal(h.state, b);
  assert.deepEqual(h.undo(), { label: "B", id: b, data: "b" });
  assert.equal(h.state, a);
  assert.equal(h.isNext(b), true);
  assert.equal(h.canRedo, true);
  const c = h.push("C", "c");
  assert.equal(h.canRedo, false);
  assert.equal(h.redo(), undefined);
  assert.ok(c !== a && c !== b);
  assert.deepEqual(h.undo(), { label: "C", id: c, data: "c" });
  assert.deepEqual(h.undo(), { label: "A", id: a, data: "a" });
  assert.equal(h.undo(), undefined);
  assert.equal(h.state, 0);
  assert.equal(h.redo()?.label, "A");
});

test("step history: unsaved by state, not content; a save taken before an edit leaves it unsaved", () => {
  const h = new StepHistory<number>();
  assert.equal(h.dirty, false);
  h.push("on", 1);
  h.push("off", 0);
  assert.equal(h.dirty, true);
  h.undo(); h.undo();
  assert.equal(h.dirty, false);
  h.redo();
  const taken = h.state;
  h.push("edit during the save", 2);
  h.markSaved(taken);
  assert.equal(h.dirty, true);
  assert.equal(h.saved, taken);
  h.undo();
  assert.equal(h.dirty, false);
  // The saved state undone past and another step instead: unsaved for good.
  h.undo();
  h.push("on again", 1);
  assert.equal(h.dirty, true);
  assert.equal(h.sinceSaved(), null);
});

test("step history: sinceSaved lists the steps done after the saved state", () => {
  const h = new StepHistory<string>();
  assert.deepEqual(h.sinceSaved(), []);
  h.push("A", "a");
  h.markSaved();
  assert.deepEqual(h.sinceSaved(), []);
  h.push("B", "b"); h.push("C", "c");
  assert.deepEqual(h.sinceSaved()?.map((s) => s.label), ["B", "C"]);
  h.undo(); h.undo(); h.undo();
  // The saved state is ahead (a redo step's).
  assert.equal(h.sinceSaved(), null);
});

test("step history: clear starts again, saved, and ids aren't given again", () => {
  const h = new StepHistory<string>();
  const a = h.push("A", "a");
  h.clear();
  assert.equal(h.state, 0);
  assert.equal(h.dirty, false);
  assert.equal(h.canUndo, false);
  const b = h.push("B", "b");
  assert.notEqual(b, a);
  assert.equal(h.dirty, true);
});

test("step history limit: the oldest steps go, the state before them stays known", () => {
  const h = new StepHistory<number>({ limit: 2 });
  h.push("1", 1);
  h.markSaved();
  const two = h.push("2", 2);
  h.push("3", 3);
  // Step 1 dropped: the saved state is the oldest state kept.
  h.undo(); h.undo();
  assert.equal(h.undo(), undefined);
  assert.equal(h.dirty, false);
  assert.deepEqual(h.sinceSaved(), []);
  h.redo();
  assert.equal(h.state, two);
  h.push("4", 4);
  h.push("5", 5);
  // The saved state is gone now.
  while (h.undo());
  assert.equal(h.dirty, true);
  assert.equal(h.sinceSaved(), null);
});

test("state stack: move keeps what `current` makes of the step for the way back", () => {
  const s = new StateStack<{ n: number; tag?: string }>();
  s.push({ n: 0, tag: "files" });
  const back = s.move("undo", (next) => ({ n: 1, tag: next.tag }));
  assert.deepEqual(back, { n: 0, tag: "files" });
  assert.deepEqual(s.peek("redo"), { n: 1, tag: "files" });
});
