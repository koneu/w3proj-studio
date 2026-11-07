import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPlaced, type PlacedLike } from "./pickmatch";

const list: PlacedLike[] = [
  { id: "hfoo", editorId: 1, position: [100, 200, 0] },
  { id: "hfoo", editorId: 2, position: [100, 200, 0] },
  { id: "hpea", editorId: 3, position: [100, 200, 0] },
  { id: "hfoo", editorId: 4, position: [900, 900, 0] },
];

test("same spot, same id: the creation number decides", () => {
  assert.equal(matchPlaced(list, { id: "hfoo", editorId: 2, x: 100, y: 200 }), 1);
  assert.equal(matchPlaced(list, { id: "hfoo", editorId: 1, x: 100, y: 200 }), 0);
});

test("without a number: id and position", () => {
  assert.equal(matchPlaced(list, { id: "hpea", x: 100, y: 200 }), 2);
  assert.equal(matchPlaced(list, { id: "hfoo", x: 900, y: 900 }), 3);
});

test("a stale number falls back to the position", () => {
  assert.equal(matchPlaced(list, { id: "hfoo", editorId: 99, x: 900, y: 900 }), 3);
});

test("a unique number finds a moved object, and never a neighbour", () => {
  assert.equal(matchPlaced(list, { id: "hfoo", editorId: 4, x: 100, y: 200 }), 3);
  assert.equal(matchPlaced(list, { id: "hfoo", editorId: 1, x: 5, y: 5 }), 0);
});

test("a repeated number is told apart by position; nothing there is -1", () => {
  const twins: PlacedLike[] = [{ id: "hfoo", editorId: 7, position: [0, 0, 0] }, { id: "hfoo", editorId: 7, position: [50, 50, 0] }];
  assert.equal(matchPlaced(twins, { id: "hfoo", editorId: 7, x: 50, y: 50 }), 1);
  assert.equal(matchPlaced(twins, { id: "hfoo", x: 5, y: 5 }), -1);
});
