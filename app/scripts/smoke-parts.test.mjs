import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePart, secondsFromLogs, splitParts, UNKNOWN_SECONDS } from "./smoke-parts.mjs";

test("--part: k of n, k from 1 to n", () => {
  assert.deepEqual(parsePart("1/3"), [1, 3]);
  assert.deepEqual(parsePart("6/6"), [6, 6]);
  assert.deepEqual(parsePart("1/1"), [1, 1]);
  for (const bad of ["0/3", "4/3", "1/0", "1/17", "a/3", "1/3x", "1", "", "-1/3", "1.5/3"]) assert.equal(parsePart(bad), null, bad);
});

test("split: every check once, in order, and the longest part as short as it can be", () => {
  const names = ["a", "b", "c", "d", "e", "f"], seconds = { a: 50, b: 10, c: 10, d: 10, e: 10, f: 10 };
  const parts = splitParts(names, 2, seconds);
  assert.deepEqual(parts.flat(), [0, 1, 2, 3, 4, 5]);
  // 50 | 50, not 60 | 40 or 70 | 30.
  assert.deepEqual(parts, [[0], [1, 2, 3, 4, 5]]);
  // Three parts: the long check alone again; the rest is cut somewhere, each part with a check.
  const three = splitParts(names, 3, seconds);
  assert.deepEqual(three.flat(), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(three[0], [0]);
  assert.ok(three.every((p) => p.length > 0));
  assert.deepEqual(splitParts(names, 1, seconds), [[0, 1, 2, 3, 4, 5]]);
});

test("split: what part 1 does before its checks counts as its time", () => {
  const names = ["a", "b", "c", "d"], seconds = { a: 10, b: 10, c: 10, d: 10 };
  assert.deepEqual(splitParts(names, 2, seconds), [[0, 1], [2, 3]]);
  assert.deepEqual(splitParts(names, 2, seconds, { first: 15 }), [[0], [1, 2, 3]]);
});

test("split: a check without a time counts as an average one, and a bad time as none given", () => {
  const names = ["known", "new1", "new2", "new3"];
  assert.deepEqual(splitParts(names, 2, { known: 4 * UNKNOWN_SECONDS }), [[0], [1, 2, 3]]);
  assert.deepEqual(splitParts(names, 2, {}), [[0, 1], [2, 3]]);
  assert.deepEqual(splitParts(names, 2, { known: 3 * UNKNOWN_SECONDS, new1: -1, new2: "7" }), [[0], [1, 2, 3]]);
});

test("split: no part is empty while there are checks for it; more parts than checks leaves the last ones empty", () => {
  // One long check and three short: three parts still get a check each.
  assert.deepEqual(splitParts(["a", "b", "c", "d"], 3, { a: 500, b: 1, c: 1, d: 1 }).map((p) => p.length), [1, 1, 2]);
  assert.deepEqual(splitParts(["a", "b"], 4, {}), [[0], [1], [], []]);
  assert.deepEqual(splitParts([], 2, {}), [[], []]);
});

test("times: the longest time of each check in the logs, whole seconds; other lines left out", () => {
  const a = "  took 30.0 s: start, build and the project checks\n  took 12.4 s: byHand\n  took 3.6 s: keyChords\napp smoke ok\n";
  const b = "  took 6.7 s: start (part 2 of 6)\n  took 14.6 s: byHand\n";
  assert.deepEqual(secondsFromLogs([a, b]), { byHand: 15, keyChords: 4 });
});
