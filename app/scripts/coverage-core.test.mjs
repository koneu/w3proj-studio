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

/** The base64 VLQ of an integer, as a source map writes it (the test's own encoder). */
function vlq(n) {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let v = n < 0 ? -n * 2 + 1 : n * 2, out = "";
  do {
    const digit = v % 32;
    v = Math.floor(v / 32);
    out += B64[digit | (v > 0 ? 32 : 0)];
  } while (v > 0);
  return out;
}

test("the test's own encoder agrees with the decoder on small values (control for the large ones)", () => {
  for (const n of [0, 1, -1, 15, 16, -16, 500, -500]) assert.deepEqual(decodeMappings(`${vlq(n)}AAA`), [[0, n, 0, 0, 0]], String(n));
});

test("a value of three digits or more, and one past 2^30, decode (no 32-bit overflow)", () => {
  for (const n of [1000, -1000, 2 ** 20, 2 ** 29, 2 ** 30, -(2 ** 30), 2 ** 31 + 5]) {
    assert.deepEqual(decodeMappings(`${vlq(n)}AAA`), [[0, n, 0, 0, 0]], String(n));
  }
  // The large value in the original column field (4th), relative to the previous segment, too.
  assert.deepEqual(decodeMappings(`AAAA,CAA${vlq(2 ** 30)}`), [[0, 0, 0, 0, 0], [0, 1, 0, 0, 2 ** 30]]);
});

test("empty segments hold no mapping, and a segment of one field only moves the column", () => {
  assert.deepEqual(decodeMappings(",,AAAA,"), [[0, 0, 0, 0, 0]], "empty segments around a mapping");
  assert.deepEqual(decodeMappings(""), []);
  assert.deepEqual(decodeMappings(";;"), []);
  // One field (a generated column only): the next segment counts from it.
  assert.deepEqual(decodeMappings("E,CAAA"), [[0, 3, 0, 0, 0]], "2 from the lone field, then 1");
  assert.deepEqual(decodeMappings("AAAA,E;CAAA"), [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]], "a new line starts its column at 0");
});

test("a character that isn't base64 is refused, not read as a zero digit", () => {
  assert.throws(() => decodeMappings("AA!A"), /isn't a base64 digit/);
  assert.throws(() => decodeMappings("AAAA,A A"), /isn't a base64 digit/);
  assert.deepEqual(decodeMappings("AAAA"), [[0, 0, 0, 0, 0]], "control: valid");
});

test("percent: a file with no code lines counts as fully covered, not NaN", () => {
  assert.equal(percent({ lines: 0, covered: 0 }), 100);
  assert.equal(percent({ lines: 4, covered: 1 }), 25);
});
