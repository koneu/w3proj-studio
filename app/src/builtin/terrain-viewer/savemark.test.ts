import test from "node:test";
import assert from "node:assert/strict";
import { SaveMark } from "./savemark";

test("an edit made while a save is in flight stays dirty", () => {
  const m = new SaveMark();
  const t = m.begin(2); // 2 edits applied when the files were taken
  assert.equal(m.isDirty(3), true);
  m.finish(t); // the save ends after a third edit
  assert.equal(m.isDirty(3), true);
  assert.equal(m.isDirty(2), false);
});

test("a save with no edit meanwhile leaves it clean", () => {
  const m = new SaveMark();
  m.finish(m.begin(4));
  assert.equal(m.isDirty(4), false);
});

test("undo past the saved position, then a new edit, is not the saved state", () => {
  const m = new SaveMark();
  m.finish(m.begin(3));
  m.truncated(2); // undone to 2, then a new edit drops the old redo steps
  assert.equal(m.isDirty(3), true);
});

test("the same during a save: the dropped step was the one being written", () => {
  const m = new SaveMark();
  const t = m.begin(3);
  m.truncated(2);
  m.finish(t);
  assert.equal(m.isDirty(3), true);
  assert.equal(m.isDirty(2), true);
});

test("undo and redo across a save follow the saved position", () => {
  const m = new SaveMark();
  m.finish(m.begin(3));
  assert.equal(m.isDirty(2), true);
  assert.equal(m.isDirty(3), false);
  m.truncated(3); // a new edit at the top drops nothing below the mark
  assert.equal(m.isDirty(4), true);
});

test("a reload resets the mark", () => {
  const m = new SaveMark();
  m.finish(m.begin(5));
  m.reset();
  assert.equal(m.isDirty(0), false);
});
