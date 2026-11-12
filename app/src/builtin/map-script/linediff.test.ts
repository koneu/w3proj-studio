import assert from "node:assert/strict";
import { test } from "node:test";
import { changesToA, lineHunks, splitLines } from "./linediff";

const hunks = (a: string, b: string) => lineHunks(splitLines(a), splitLines(b));
// Applies the changes to b: must give a (with line breaks as \n).
function apply(a: string, b: string): string {
  let out = b.replace(/\r\n?/g, "\n"), shift = 0;
  const bn = out;
  for (const c of changesToA(a, b)) { out = out.slice(0, c.from + shift) + c.insert + out.slice(c.to + shift); shift += c.insert.length - (c.to - c.from); }
  assert.ok(bn.length >= 0);
  return out;
}

test("identical texts have no hunks; so do CRLF against LF", () => {
  assert.deepEqual(hunks("a\nb\nc", "a\nb\nc"), []);
  assert.deepEqual(hunks("a\r\nb\r\nc", "a\nb\nc"), []);
  assert.deepEqual(hunks("", ""), []);
});
test("one changed line is one hunk of one line", () => {
  assert.deepEqual(hunks("a\nb\nc", "a\nX\nc"), [{ fromA: 1, toA: 2, fromB: 1, toB: 2 }]);
});
test("inserted and deleted blocks", () => {
  assert.deepEqual(hunks("a\nb\nc\nd", "a\nb\nx\ny\nc\nd"), [{ fromA: 2, toA: 2, fromB: 2, toB: 4 }]);
  assert.deepEqual(hunks("a\nb\nx\ny\nc\nd", "a\nb\nc\nd"), [{ fromA: 2, toA: 4, fromB: 2, toB: 2 }]);
  assert.equal(hunks("a\nb\nc\nd\ne\nf", "a\nX\nc\nd\nY\nf").length, 2);
});
test("an empty side", () => {
  assert.equal(hunks("", "a\nb").length, 1);
  assert.equal(hunks("a\nb", "").length, 1);
});
test("the changes turn b into a", () => {
  const cases: [string, string][] = [["a\nb\nc", "a\nX\nc"], ["a\nb", "a\nb\nc\nd"], ["a\nb\nc\nd", "a\nb"], ["", "q\nr"], ["q\nr", ""], ["a\r\nb\r\n", "b\na\n"], ["x", "y"], ["1\n2\n3\n4\n5\n6", "0\n2\n3\n9\n5\n7\n8"]];
  for (const [a, b] of cases) assert.equal(apply(a, b), a.replace(/\r\n?/g, "\n"), JSON.stringify([a, b]));
});
test("a 20000-line file with 3 edits is 3 hunks, fast", () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `call F(${i % 50}) // ${i}`);
  const other = [...lines];
  other[3000] = "changed"; other.splice(9000, 2); other[15000] += "x";
  const t = Date.now();
  const h = lineHunks(lines, other);
  assert.equal(h.length, 3);
  assert.ok(Date.now() - t < 1000);
});
test("a big different text falls back to one hunk, quickly", () => {
  const a = Array.from({ length: 18000 }, (_, i) => `a${i}`), b = Array.from({ length: 18000 }, (_, i) => `b${i}`);
  const t = Date.now();
  assert.deepEqual(lineHunks(a, b), [{ fromA: 0, toA: 18000, fromB: 0, toB: 18000 }]);
  assert.ok(Date.now() - t < 2000);
});
test("control: the hunks of 18k lines with many scattered edits are found", () => {
  const a = Array.from({ length: 18000 }, (_, i) => `l${i}`), b = a.map((l, i) => (i % 100 === 50 ? `${l}!` : l));
  assert.equal(lineHunks(a, b).length, 180);
});
