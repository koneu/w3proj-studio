import test from "node:test";
import assert from "node:assert/strict";
import { LineHits, characterCounts, decodeMappings, percent } from "./coverage-core.mjs";

test("mappings decode, with fields relative to the previous segment", () => {
  // Line 0: column 0 -> source 0, 0:0. Line 2: column 2 -> 1:1, then column 5 -> 1:9.
  assert.deepEqual(decodeMappings("AAAA;;EACC,GAAQ"), [
    [0, 0, 0, 0, 0],
    [2, 2, 0, 1, 1],
    [2, 5, 0, 1, 9],
  ]);
});

test("a mapping that needs two digits, and a negative delta, decode", () => {
  // Column 16 takes two base64 digits; the second segment goes back to column 0.
  assert.deepEqual(decodeMappings("gBAAA,CAAhB"), [
    [0, 16, 0, 0, 0],
    [0, 17, 0, 0, -16],
  ]);
});

test("an inner range overrules the range around it", () => {
  const counts = characterCounts(10, [
    { ranges: [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 3, endOffset: 5, count: 0 }] },
  ]);
  assert.deepEqual([...counts], [1, 1, 1, 0, 0, 1, 1, 1, 1, 1]);
});

test("code outside every range has no count", () => {
  assert.deepEqual([...characterCounts(3, [{ ranges: [{ startOffset: 1, endOffset: 9, count: 2 }] }])], [-1, 2, 2]);
});

test("a line with an unexecuted branch isn't covered", () => {
  const hits = new LineHits();
  hits.add("f", 1, 0, true);
  hits.add("f", 1, 8, false);
  hits.add("f", 2, 0, true);
  assert.equal(hits.covered("f", new Set([1, 2])), 1);
});

test("a position that ran in any bundle ran", () => {
  const hits = new LineHits();
  hits.add("f", 1, 8, false);
  hits.add("f", 1, 8, true);
  hits.add("f", 1, 8, false);
  assert.equal(hits.covered("f", new Set([1])), 1);
});

test("a code line no bundle holds isn't covered", () => {
  const hits = new LineHits();
  hits.add("f", 1, 0, true);
  assert.equal(hits.covered("f", new Set([1, 2])), 1);
});

test("a file no test imports counts as nothing covered", () => {
  assert.equal(new LineHits().covered("f", new Set([1, 2, 3])), 0);
  assert.equal(percent({ lines: 3, covered: 0 }), 0);
});
