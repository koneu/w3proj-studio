import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable, askWtsCuts, checkStringIds, compactStringIds, importStrings, renumberStringRefs, renumberWts, wtsCutLines, wtsCuts, wtsSafeText, wtsStrayLines } from "./wts";

const map = "STRING 1\r\n// Name\r\n{\r\nMy Map\r\n}\r\n\r\nSTRING 2\r\n{\r\nA hero\r\n}\r\n\r\nSTRING 3\r\n{\r\nKept\r\n}\r\n";

test("a translation goes in by number, and only what changed", () => {
  const r = importStrings(map, "STRING 2\n{\nEin Held\n}\n");
  assert.deepEqual([r.changed, r.unknown], [1, 0]);
  assert.ok(r.text.includes("Ein Held"));
  assert.ok(!r.text.includes("A hero"));
  assert.ok(r.text.includes("My Map"));
});

test("the rest of the file stays byte for byte, comments and line ends too", () => {
  const r = importStrings(map, "STRING 2\n{\nEin Held\n}\n");
  assert.equal(r.text, map.replace("A hero", "Ein Held"));
});

test("numbers the map hasn't got stay out, and are counted", () => {
  const r = importStrings(map, "STRING 99\n{\nNobody\n}\n");
  assert.deepEqual([r.changed, r.unknown], [0, 1]);
  assert.equal(r.text, map);
});

test("the same text in other line ends is no change", () => {
  const two = "STRING 1\r\n{\r\nLine one\r\nLine two\r\n}\r\n";
  const r = importStrings(two, "STRING 1\n{\nLine one\nLine two\n}\n");
  assert.equal(r.changed, 0);
  assert.equal(r.text, two);
});

test("a text of several lines keeps the file's line ends", () => {
  const r = importStrings(map, "STRING 3\n{\nZwei\nZeilen\n}\n");
  assert.ok(r.text.includes("Zwei\r\nZeilen"));
});

test("what's exported comes back the same", () => {
  assert.deepEqual([importStrings(map, map).changed, importStrings(map, map).text], [0, map]);
});

// A block whose `}` sits at the end of its last text line, with the next STRING block right after it:
// real files have this (a credits list). The first `}` line used to end the block far later, so the
// next strings were swallowed into this one.

const all = (text: string) => [...new StringTable(text).entries()];
/** Made up, shaped like a credits list: block 7 has no `}` line of its own. */
const credits =
  "\uFEFFSTRING 6\r\n// Units: h000 (Name)\r\n{\r\nExecutive Producer\r\n}\r\n\r\n" +
  "STRING 7\r\n{\r\nJane Doe\r\nJohn Roe, Producer}\r\n\r\n" +
  "STRING 8\r\n// Units: h001 (Name)\r\n// second comment\r\n{\r\nAnnie Poe}\r\n\r\n" +
  "STRING 9\r\n{\r\nThe End\r\n}\r\n";

test("an unclosed block ends at its brace and the next strings are read", () => {
  assert.deepEqual(all(credits), [[6, "Executive Producer"], [7, "Jane Doe\r\nJohn Roe, Producer"], [8, "Annie Poe"], [9, "The End"]]);
});

test("an untouched file with an unclosed block serializes to its own bytes", () => {
  assert.equal(new StringTable(credits).serialize(), credits);
});

test("editing another string leaves the unclosed block as it is", () => {
  const t = new StringTable(credits);
  t.set(9, "Fin");
  assert.equal(t.serialize(), credits.replace("The End", "Fin"));
});

test("an edited unclosed block gets the usual closing line and keeps every other string", () => {
  const t = new StringTable(credits);
  t.set(7, "Someone Else");
  const saved = t.serialize();
  assert.equal(saved, credits.replace("Jane Doe\r\nJohn Roe, Producer}", "Someone Else\r\n}"));
  assert.deepEqual(all(saved), [[6, "Executive Producer"], [7, "Someone Else"], [8, "Annie Poe"], [9, "The End"]]);
  // and the next unclosed one, after the first was fixed
  t.markSaved();
  t.set(8, "Annie Q. Poe");
  assert.deepEqual(all(t.serialize()), [[6, "Executive Producer"], [7, "Someone Else"], [8, "Annie Q. Poe"], [9, "The End"]]);
});

test("an edited unclosed block in a file with plain line ends is closed with them", () => {
  const t = new StringTable("STRING 1\n{\nfoo}\n\nSTRING 2\n{\nbar\n}\n");
  t.set(1, "baz");
  assert.equal(t.serialize(), "STRING 1\n{\nbaz\n}\n\nSTRING 2\n{\nbar\n}\n");
});

test("the merge of two editors keeps strings next to an unclosed block", () => {
  const base = credits, current = credits;
  const mine = new StringTable(base);
  mine.set(8, "Mine");
  const saved = StringTable.merge(base, mine, current);
  assert.deepEqual(all(saved), [[6, "Executive Producer"], [7, "Jane Doe\r\nJohn Roe, Producer"], [8, "Mine"], [9, "The End"]]);
});

test("importing a translation reaches the strings after an unclosed block", () => {
  const r = importStrings(credits, "STRING 9\r\n{\r\nEnde\r\n}\r\n");
  assert.equal(r.changed, 1);
  assert.deepEqual(all(r.text).map(([n]) => n), [6, 7, 8, 9]);
  assert.equal(new StringTable(r.text).get(9), "Ende");
});

test("a text ending in a brace, closed on its own line, is one string", () => {
  assert.deepEqual(all("STRING 1\n{\nset {a}\n}\n\nSTRING 2\n{\nx\n}\n"), [[1, "set {a}"], [2, "x"]]);
});

test("a brace line inside the file is still what ends a block (the first line that starts with a brace)", () => {
  assert.deepEqual(all("STRING 1\n{\nfoo}\nbar\n}\n"), [[1, "foo}\nbar"]]);
});

test("a brace in the middle of a line, or a header that isn't one, does not split a block", () => {
  assert.deepEqual(all("STRING 1\n{\na}b\nSTRING 2\n{\nx\n}\n"), [[1, "a}b\nSTRING 2\n{\nx"]]);
  assert.deepEqual(all("STRING 1\n{\nfoo}\nSTRING 2\nnot a brace\n}\n"), [[1, "foo}\nSTRING 2\nnot a brace"]]);
  assert.deepEqual(all("STRING 1\n{\nfoo}\nSTRING two\n{\nx\n}\n"), [[1, "foo}\nSTRING two\n{\nx"]]);
  assert.deepEqual(all("STRING 1\n{\nfoo\nSTRING 2\n{\nx\n}\n"), [[1, "foo\nSTRING 2\n{\nx"]]);
});

test("a brace followed by junk on the same line is not an end", () => {
  assert.deepEqual(all("STRING 1\n{\nfoo} \nSTRING 2\n{\nx\n}\n"), [[1, "foo} \nSTRING 2\n{\nx"]]);
});

test("several unclosed blocks in a row", () => {
  assert.deepEqual(all("STRING 1\n{\na}\nSTRING 2\n{\nb}\n\n\nSTRING 3\n{\nc\n}\n"), [[1, "a"], [2, "b"], [3, "c"]]);
});


test("blocks followed by a header are recovered even with no brace line anywhere after them", () => {
  assert.deepEqual(all("STRING 1\n{\nfoo}\nSTRING 2\n{\nbar}\n\nSTRING 3\n{\nlast"), [[1, "foo"], [2, "bar"]]);
});

test("a last unclosed block with no header after it, and no brace line, stays unread", () => {
  assert.deepEqual(all("STRING 1\n{\nfoo}\n"), []);
  assert.deepEqual(all("STRING 1\n{\nfoo\nbar"), []);
});

test("a header that doesn't qualify is skipped, a later one that does is used", () => {
  assert.deepEqual(all("STRING 1\n{\nsee\nSTRING 7\n{\nfoo}\nSTRING 2\n{\nx\n}\n"), [[1, "see\nSTRING 7\n{\nfoo"], [2, "x"]]);
});

test("many unclosed blocks are read in one pass, not one search to the end each", () => {
  const n = 30000;
  let text = "";
  for (let i = 1; i <= n; i++) text += `STRING ${i}\r\n{\r\nName ${i}}\r\n\r\n`;
  text += "STRING 0\r\n{\r\nEnd\r\n}\r\n";
  const t0 = Date.now();
  const table = new StringTable(text);
  assert.equal(table.get(n), `Name ${n}`);
  assert.equal(table.get(0), "End");
  assert.equal([...table.entries()].length, n + 1);
  table.set(n, "x");
  assert.ok(table.serialize().includes("x\r\n}"));
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

// A line that is just `}` (or starts with it) inside a text: the game ends the string there and drops the
// rest (map 17, "Test 2"), and so does this parser. Such a text is never written silently.

// (The refusal itself: wtscut.test.ts.)

test("a cut text is listed with its lines", () => {
  const t = new StringTable(map);
  t.set(2, "Line one\n}\nLine three");
  assert.deepEqual(t.cuts(), [{ num: 2, lines: [2] }]);
});

test("the offered change keeps the whole text when read back", () => {
  const t = new StringTable(map);
  t.set(2, "}\nLine one\n}\n} more\nLine five");
  assert.deepEqual(t.fixCuts(), [2]);
  assert.deepEqual(t.cuts(), []);
  const back = new StringTable(t.serialize());
  assert.equal(back.get(2), " }\r\nLine one\r\n }\r\n } more\r\nLine five");
  assert.equal(back.get(3), "Kept");
});

test("a brace ending a line before something that reads as a header is caught and changed too", () => {
  const v = "Cast at once}\nSTRING 9\n{\nnot a string";
  assert.deepEqual(wtsCutLines(v), [1]);
  const safe = wtsSafeText(v);
  assert.equal(safe, "Cast at once} \nSTRING 9\n{\nnot a string");
  const t = new StringTable(map);
  t.set(2, safe);
  assert.equal(new StringTable(t.serialize()).get(2), safe.replace(/\n/g, "\r\n"));
});

test("braces elsewhere in a line, an indented brace and untouched strings are fine", () => {
  for (const v of ["set {a}", "a } b", " }", "\t}", "{\n  }\n", "end}", ""]) assert.deepEqual(wtsCutLines(v), [], v);
  assert.deepEqual(wtsCuts([[4, "x\r\n}"], [1, "ok"], [2, "}"]]), [{ num: 2, lines: [1] }, { num: 4, lines: [2] }]);
  // a string that is not changed is never refused, whatever the file holds
  assert.doesNotThrow(() => new StringTable("STRING 1\n{\n}\nb\n}\n").serialize());
});

test("asking: agreed changes, declined stops, nothing to ask passes", async () => {
  const cuts = [{ num: 3, lines: [2] }];
  let asked = "";
  assert.equal(await askWtsCuts(async (m) => { asked = m; return true; }, cuts), true);
  assert.match(asked, /string 3/);
  assert.equal(await askWtsCuts(async () => false, cuts), false);
  assert.equal(await askWtsCuts(async () => { throw new Error("not asked"); }, []), true);
});

test("hand-written text outside every string is found by line", () => {
  assert.deepEqual(wtsStrayLines(map), []);
  assert.deepEqual(wtsStrayLines(credits), []);
  assert.deepEqual(wtsStrayLines(String.fromCharCode(0xfeff) + "STRING 1\n// c\n{\na\n}\n// after\n\nSTRING 2\n{\nb\n}\n"), []);
  const typed = "STRING 1\r\n{\r\nLine one\r\n}\r\nLine three\r\n}\r\n\r\nSTRING 2\r\n{\r\nb\r\n}\r\n";
  assert.deepEqual(wtsStrayLines(typed), [{ line: 5, text: "Line three" }, { line: 6, text: "}" }]);
});

test("Adjust Map String IDs: headers renumbered in place, texts and everything else byte for byte", () => {
  const ids = new Map([[1, 7], [3, 1]]);
  checkStringIds(new StringTable(map), ids);
  const out = renumberWts(map, ids);
  assert.equal(out, map.replace("STRING 1\r\n", "STRING 7\r\n").replace("STRING 3\r\n", "STRING 1\r\n"));
  const t = new StringTable(out);
  assert.deepEqual([t.get(7), t.get(2), t.get(1)], ["My Map", "A hero", "Kept"]);
  // Nothing to change: the same text; a padded number keeps its width; an unclosed block is renumbered too.
  assert.equal(renumberWts(map, new Map()), map);
  assert.equal(renumberWts(map, new Map([[2, 2]])), map);
  assert.equal(renumberWts("STRING 007\n{\na\n}\n", new Map([[7, 12]])), "STRING 012\n{\na\n}\n");
  const unclosed = "STRING 1\n{\none}\nSTRING 2\n{\ntwo\n}\n";
  assert.equal(renumberWts(unclosed, new Map([[2, 5]])), "STRING 1\n{\none}\nSTRING 5\n{\ntwo\n}\n");
  // A text that looks like a header isn't one.
  const tricky = "STRING 1\n{\nSTRING 2 in the text\n}\nSTRING 2\n{\nb\n}\n";
  assert.equal(renumberWts(tricky, new Map([[2, 9]])), "STRING 1\n{\nSTRING 2 in the text\n}\nSTRING 9\n{\nb\n}\n");
});

test("Adjust Map String IDs: references follow with their padding; clashes and unknown numbers are refused", () => {
  const ids = new Map([[1, 7], [3, 12]]);
  assert.equal(renumberStringRefs('{"name":"TRIGSTR_001","a":"TRIGSTR_3","b":"TRIGSTR_2"}', ids), '{"name":"TRIGSTR_007","a":"TRIGSTR_12","b":"TRIGSTR_2"}');
  assert.equal(renumberStringRefs('call SetMapName( "TRIGSTR_002" )', ids), null, "nothing changed: null");
  const table = new StringTable(map);
  assert.throws(() => checkStringIds(table, new Map([[1, 2]])), /Strings .* would both be 2/);
  assert.throws(() => checkStringIds(table, new Map([[9, 4]])), /no string 9/);
  assert.throws(() => checkStringIds(table, new Map([[1, -1]])), /isn't a string ID/);
  assert.throws(() => checkStringIds(table, new Map([[1, 1.5]])), /isn't a string ID/);
  // A swap is fine.
  checkStringIds(table, new Map([[1, 2], [2, 1]]));
  assert.deepEqual([...compactStringIds(new StringTable("STRING 4\n{\na\n}\nSTRING 9\n{\nb\n}\nSTRING 1\n{\nc\n}\n"))], [[4, 2], [9, 3]]);
  assert.deepEqual([...compactStringIds(table)], [], "already 1, 2, 3");
});
