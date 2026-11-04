import assert from "node:assert/strict";
import { test } from "node:test";
import { History } from "./undo";

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
