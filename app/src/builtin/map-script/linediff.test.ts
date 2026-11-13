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

const lines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag}${i}`);
test("a big block only one text has is one hunk of its own; the small edits before it stay separate", () => {
  const base = lines(4000);
  const a = [...base]; a[10] = "X"; a[3400] = "Y";
  const b = [...base, ...lines(14700, "tail")];
  const h = lineHunks(a, b);
  assert.deepEqual(h.map((x) => [x.fromA, x.toA]), [[10, 11], [3400, 3401]].concat([[4000, 4000]]).map(([f, t]) => [f, t]));
  assert.deepEqual(h[2], { fromA: 4000, toA: 4000, fromB: 4000, toB: 18700 });
  // The tail instead of the end of the other text (both sides differ there): still the two edits, then one gap.
  const c = [...base, ...lines(500, "other")];
  const h2 = lineHunks(a.concat(lines(300, "gen")), c);
  assert.equal(h2.length, 3);
  assert.deepEqual([h2[0].fromA, h2[1].fromA], [10, 3400]);
});
test("20,000 lines with 3 edits are fast", () => {
  const base = lines(20000);
  const b = [...base]; b[5] = "a"; b[9000] = "b"; b[19990] = "c";
  const t = Date.now();
  const h = lineHunks(base, b);
  assert.equal(h.length, 3);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
});
test("repeated lines still give a valid edit script", () => {
  const a = ["x", "y", "x", "y", "z", "x"], b = ["y", "x", "y", "x", "z", "z", "x"];
  assert.equal(apply(a.join("\n"), b.join("\n")), a.join("\n"));
});

test("many separate hunks stay separate chunks in the merge view's state", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { getChunks, unifiedMergeView } = await import("@codemirror/merge");
  const { eachChangeLastFirst } = await import("./linediff");
  const lines = Array.from({ length: 4143 }, (_, i) => `// filler line ${i}`);
  const b = lines.join("\n");
  for (const H of [13, 20, 60]) {
    const l2 = lines.slice();
    for (let c = 0; c < H; c++) l2[40 + c * 65] += " // EDITED";
    const edits = changesToA(l2.join("\n"), b);
    const typeAll = (one: boolean) => {
      let s = EditorState.create({ doc: b, extensions: [unifiedMergeView({ original: b })] });
      if (one) s = s.update({ changes: edits }).state;
      else eachChangeLastFirst(edits, (c) => { s = s.update({ changes: c }).state; });
      return getChunks(s)?.chunks.length;
    };
    assert.equal(typeAll(false), H);
    if (H >= 20) assert.equal(typeAll(true), 1, "control: in one transaction CodeMirror merges them");
  }
});
test("a 20000-line script with 200 hunks diffs fast", () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `// filler line ${i}`);
  const l2 = lines.slice();
  for (let c = 0; c < 200; c++) l2[40 + c * 90] += " // EDITED";
  const t = Date.now();
  assert.equal(changesToA(l2.join("\n"), lines.join("\n")).length, 200);
  assert.ok(Date.now() - t < 2000);
});
