import assert from "node:assert/strict";
import { test } from "node:test";
import { listWindow } from "./listwindow";

const heights = Array.from({ length: 1000 }, () => 20);

test("the start of the list: what is in view and a margin after it, the rest as space", () => {
  assert.deepEqual(listWindow(heights, 0, 100, 40), { from: 0, to: 9, before: 0, after: 991 * 20 });
});

test("the middle: a margin on both sides, and the spaces and rows add up to the whole list", () => {
  const w = listWindow(heights, 5000, 100, 40);
  assert.deepEqual(w, { from: 248, to: 257, before: 4960, after: 14860 });
  assert.equal(w.before + (w.to - w.from) * 20 + w.after, 20000);
});

test("scrolled past the end of a list that got shorter: its end is shown", () => {
  const w = listWindow(heights.slice(0, 300), 15000, 100, 40);
  assert.equal(w.to, 300);
  assert.equal(w.after, 0);
  assert.ok(w.from < 300);
});

test("entries of different heights, and an empty list", () => {
  assert.deepEqual(listWindow([30, 20, 20, 30, 20], 50, 20, 0), { from: 2, to: 3, before: 50, after: 50 });
  assert.deepEqual(listWindow([], 0, 100, 40), { from: 0, to: 0, before: 0, after: 0 });
});
