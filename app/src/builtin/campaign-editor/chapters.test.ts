import assert from "node:assert/strict";
import { test } from "node:test";
import { addChapter, type ChapterList } from "./chapters";

const empty = (): ChapterList => ({ chapters: [], mapOrder: [] });

test("the first chapter of a new campaign is shown from the start, later ones are not", () => {
  const c = empty();
  assert.equal(addChapter(c, "One.w3x", "One"), 0);
  assert.equal(addChapter(c, "Two.w3x", "Two"), 1);
  assert.deepEqual(c.chapters.map((x) => x.flags), [1, 0]);
  assert.deepEqual(c.chapters.map((x) => x.chapter), ["Chapter 1", "Chapter 2"]);
});

test("every chapter names a map that is in the map order, once", () => {
  const c = empty();
  addChapter(c, "One.w3x", "One");
  addChapter(c, "Two.w3x", "Two");
  c.chapters.pop();
  addChapter(c, "two.w3x", "Two");
  assert.deepEqual(c.mapOrder.map((m) => m.map), ["One.w3x", "Two.w3x"]);
  assert.ok(c.chapters.every((x) => c.mapOrder.some((m) => m.map === x.map) || x.map === "two.w3x"));
});

test("a campaign whose first button was hidden by hand gets the next one shown", () => {
  const c = empty();
  addChapter(c, "One.w3x", "One");
  c.chapters[0].flags = 0;
  addChapter(c, "Two.w3x", "Two");
  assert.deepEqual(c.chapters.map((x) => x.flags), [0, 1]);
});
