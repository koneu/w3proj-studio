import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileInfo } from "../../extensions/api";
import { checkpointName, checkpointState, checkpointTime, newestFirst, toPrune } from "./checkpoints";

test("a checkpoint's name carries its time, for maps and campaigns", () => {
  const at = new Date(2026, 10, 5, 9, 7, 3);
  assert.equal(checkpointName("C:\\p\\build\\My Map.w3x", at), "My Map 2026-11-05 09-07-03.w3x");
  assert.equal(checkpointName("C:/p/build/Saga.w3n", at), "Saga 2026-11-05 09-07-03.w3n");
  assert.equal(checkpointTime("My Map 2026-11-05 09-07-03.w3x"), at.getTime());
  assert.equal(checkpointTime("My Map.w3x"), null);
  assert.equal(checkpointTime("My Map 2026-11-05.w3x"), null);
});

test("newest first; other files don't count", () => {
  const names = ["a 2026-01-01 00-00-00.w3x", "notes.txt", "a 2026-03-01 00-00-00.w3x", "a 2026-02-01 00-00-00.w3x"];
  assert.deepEqual(newestFirst(names).map((c) => c.name), ["a 2026-03-01 00-00-00.w3x", "a 2026-02-01 00-00-00.w3x", "a 2026-01-01 00-00-00.w3x"]);
  assert.deepEqual(toPrune(names, 2), ["a 2026-01-01 00-00-00.w3x"]);
  assert.deepEqual(toPrune(names, 5), []);
});

test("pruning always leaves the newest, and never touches other files", () => {
  const names = ["a 2026-01-01 00-00-00.w3x", "a 2026-03-01 00-00-00.w3x", "precious.w3x"];
  assert.deepEqual(toPrune(names, 0), ["a 2026-01-01 00-00-00.w3x"]);
});

test("files in a folder below build/checkpoints (recovered/) are no checkpoints: not counted, never pruned", () => {
  const names = ["a 2026-01-01 00-00-00.w3x", "a 2026-03-01 00-00-00.w3x", "recovered/a 2025-01-01 00-00-00.w3x"];
  assert.deepEqual(toPrune(names, 1), ["a 2026-01-01 00-00-00.w3x"]);
  assert.deepEqual(newestFirst(names).map((c) => c.name), ["a 2026-03-01 00-00-00.w3x", "a 2026-01-01 00-00-00.w3x"]);
});

test("when a checkpoint is due", () => {
  const file = (modified: number, size = 10): FileInfo => ({ path: "map/x", size, modified });
  const min = 60_000, big = 1 << 30;
  assert.equal(checkpointState([file(100)], null, 200, 5 * min, big), "due", "the first comes at once");
  assert.equal(checkpointState([], null, 200, 5 * min, big), "unchanged");
  assert.equal(checkpointState([file(100)], 200, 10 * min, 5 * min, big), "unchanged");
  assert.equal(checkpointState([file(300)], 200, 2 * min, 5 * min, big), "wait");
  assert.equal(checkpointState([file(300)], 200, 6 * min, 5 * min, big), "due");
  assert.equal(checkpointState([file(300, big + 1)], 200, 6 * min, 5 * min, big), "too large");
});
