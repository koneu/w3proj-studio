import assert from "node:assert/strict";
import { test } from "node:test";
import { listKey, moveInList, stepInList } from "./objectlist";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test("listKey: the World Editor's keys for its list items, with their modifiers exactly", () => {
  assert.equal(listKey(key("Tab", { ctrlKey: true })), "next");
  assert.equal(listKey(key("Tab", { ctrlKey: true, shiftKey: true })), "previous");
  assert.equal(listKey(key("PageUp", { ctrlKey: true })), "up");
  assert.equal(listKey(key("PageDown", { metaKey: true })), "down");
  for (const k of [key("Tab"), key("PageUp"), key("PageDown"), key("Tab", { altKey: true, ctrlKey: true }), key("PageUp", { ctrlKey: true, shiftKey: true }), key("a", { ctrlKey: true })]) {
    assert.equal(listKey(k), null, JSON.stringify(k));
  }
});

test("stepInList: next and previous go round; with nothing selected the first or the last", () => {
  const l = ["a", "b", "c"];
  assert.equal(stepInList(l, "a", 1), "b");
  assert.equal(stepInList(l, "c", 1), "a");
  assert.equal(stepInList(l, "a", -1), "c");
  assert.equal(stepInList(l, null, 1), "a");
  assert.equal(stepInList(l, null, -1), "c");
  assert.equal(stepInList(l, "gone", 1), "a");
  assert.equal(stepInList([], null, 1), null);
});

test("moveInList: one place up or down, nothing past the ends", () => {
  const l = ["a", "b", "c"];
  assert.deepEqual(moveInList(l, "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveInList(l, "b", 1), ["a", "c", "b"]);
  assert.equal(moveInList(l, "a", -1), null);
  assert.equal(moveInList(l, "c", 1), null);
  assert.equal(moveInList(l, "x", 1), null);
  assert.deepEqual(l, ["a", "b", "c"], "the list itself stays");
});
