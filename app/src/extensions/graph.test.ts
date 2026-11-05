import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedBy, neededBy, requires } from "./graph";

const all = [
  { id: "core" },
  { id: "terrain", extensionDependencies: ["core"] },
  { id: "painter", extensionDependencies: ["terrain"] },
  { id: "objects", extensionDependencies: ["terrain", "core"] },
  { id: "alone" },
  { id: "broken", extensionDependencies: ["gone"] },
];

test("what an extension needs", () => {
  assert.deepEqual(requires("objects", all), ["terrain", "core"]);
  assert.deepEqual(requires("alone", all), []);
  assert.deepEqual(requires("nobody", all), []);
});

test("what stops working without one: also through others", () => {
  assert.deepEqual(neededBy("core", all).sort(), ["objects", "painter", "terrain"]);
  assert.deepEqual(neededBy("terrain", all).sort(), ["objects", "painter"]);
  assert.deepEqual(neededBy("alone", all), []);
});

test("a dependency loop ends", () => {
  const loop = [{ id: "a", extensionDependencies: ["b"] }, { id: "b", extensionDependencies: ["a"] }];
  assert.deepEqual(neededBy("a", loop), ["b"]);
  assert.deepEqual(blockedBy("a", loop, new Set()), []);
});

test("what keeps one from working: off or missing, directly or not", () => {
  assert.deepEqual(blockedBy("painter", all, new Set(["core"])), ["core"]);
  assert.deepEqual(blockedBy("painter", all, new Set()), []);
  assert.deepEqual(blockedBy("broken", all, new Set()), ["gone"]);
});
