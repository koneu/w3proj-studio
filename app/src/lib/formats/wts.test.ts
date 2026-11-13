import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringTable, askWtsCuts, checkStringIds, compactStringIds, WtsReader, importStrings, pruneStrings, removeStrings, renumberStringRefs, renumberWts, wtsCutLines, wtsCuts, wtsSafeText, wtsStrayLines } from "./wts";

/** Processor time of this process in ms: unlike the clock, it doesn't grow while other gates hold the machine. */
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

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
  const t0 = cpuMs();
  const table = new StringTable(text);
  assert.equal(table.get(n), `Name ${n}`);
  assert.equal(table.get(0), "End");
  assert.equal([...table.entries()].length, n + 1);
  table.set(n, "x");
  assert.ok(table.serialize().includes("x\r\n}"));
  // A search to the end per block takes minutes here; one pass takes well under a tenth of the limit.
  assert.ok(cpuMs() - t0 < 4000, `took ${cpuMs() - t0} ms of processor time`);
});

test("the reader finds what the header, close and unclosed patterns find, on random text", () => {
  // The patterns the reader replaced, as the specification it must match exactly.
  const HEADER = /STRING\s+(\d+)\s*(?:\/\/[^\n]*\n\s*)*\{\r?\n/g;
  const CLOSE = /\r?\n\}/g;
  const UNCLOSED = /\}(?=\r?\n(?:[ \t]*\r?\n)*STRING\s+\d+\s*(?:\/\/[^\n]*\n\s*)*\{\r?\n)/g;
  const parts = ["STRING", "STRING ", "STRING\t", " ", "\t", "\n", "\r\n", "\r", " ", "　", "﻿", "1", "07", "x",
    "{", "}", "//", "// c", "/", "STRING 1\n{\n", "STRING 2 // c\n{\r\n", "\n}", "}\n\nSTRING 3\n{\n"];
  let seed = 12345;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const exec = (re: RegExp, text: string, from: number) => { re.lastIndex = from; return re.exec(text); };
  for (let round = 0; round < 3000; round++) {
    let text = "";
    for (let i = rand(30); i >= 0; i--) text += parts[rand(parts.length)];
    const r = new WtsReader(text);
    for (let from = 0; from <= text.length; from++) {
      const h = exec(HEADER, text, from), got = r.findHeader(from);
      assert.deepEqual(got && [got.at, got.num, text.slice(got.digits, got.digitsEnd), got.end],
        h && [h.index, Number(h[1]), h[1], h.index + h[0].length], JSON.stringify([text, from]));
      const c = exec(CLOSE, text, from), gotC = r.findClose(from);
      assert.deepEqual(gotC, c && { index: c.index, end: c.index + c[0].length }, JSON.stringify([text, from]));
      assert.equal(r.findUnclosed(from), exec(UNCLOSED, text, from)?.index ?? null, JSON.stringify([text, from]));
    }
  }
});

test("a long run of comment lines is read once, however many headers start in it", () => {
  // Every line starts a header (`STRING 2`) whose comment group runs to the end of the file, and none has a `{`.
  // Read once per line, 30,000 lines take seconds and 200,000 minutes; read once, both take milliseconds.
  for (const n of [30_000, 200_000]) {
    const text = "STRING 1\n" + "// STRING 2 \n".repeat(n);
    const t0 = cpuMs();
    assert.deepEqual([...new StringTable(text).entries()], []);
    assert.ok(cpuMs() - t0 < 3000, `${n} lines took ${cpuMs() - t0} ms of processor time to read`);
    assert.deepEqual(wtsStrayLines(text), []);
    assert.equal(renumberWts(text, new Map([[1, 5]])), text);
    // The same run inside a block's text, and between two blocks.
    const framed = `STRING 3\n{\n${text}}\n\nSTRING 4\n// one\n{\nlast\n}\n`;
    const table = new StringTable(framed);
    assert.deepEqual([...table.entries()].map(([k, v]) => [k, v.length]), [[3, text.length - 1], [4, 4]]);
    table.set(4, "x");
    assert.equal(table.serialize(), framed.replace("last", "x"));
    assert.equal(removeStrings(framed, new Set([3])), "STRING 4\n// one\n{\nlast\n}\n");
    assert.ok(cpuMs() - t0 < 3000, `${n} lines took ${cpuMs() - t0} ms of processor time`);
  }
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

// ---- Stray carriage returns (`\r\r\n`, `\r\r`) -------------------------------------------------

/** tests/fixtures/wts-crcrlf/war3map.wts, found from where the tests run (app/ or the repository). The Rust port
 *  reads the same file (crates/w3proj/src/wts.rs, `stray_carriage_returns_stay_where_they_are`). */
function crcrlfFixture(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "wts-crcrlf", "war3map.wts");
    if (existsSync(p)) return readFileSync(p, "utf8");
    if (dirname(dir) === dir) throw new Error("tests/fixtures/wts-crcrlf not found");
  }
}

test("stray carriage returns: read as part of the text, kept byte for byte outside an edited string", () => {
  // The four Chosen Ones campaigns' war3campaign.wts have `\r\r\n` inside a text, the Forsaken06/11Finale war3map.wts
  // `\r\r` mid-line; the fixture has those, and one after a comment, before and after a `}` line, after a header.
  const text = crcrlfFixture();
  const CRCRLF = "\r\r\n";
  assert.equal(text.split(CRCRLF).length - 1, 6, "the fixture has its six \\r\\r\\n");
  const t = new StringTable(text);
  assert.deepEqual([...t.entries()], [
    [1, `The bounces does half the ${CRCRLF}damage of the original explosion.`],
    [2, "To edit"],
    [3, "for the first time in years. \r\rIn the quiet calm of..."],
    [4, "ends in one\r"],
    [5, "after a header"],
    [6, "last"],
  ]);
  assert.equal(t.serialize(), text, "no change: the file's own bytes");
  assert.deepEqual(wtsStrayLines(text), [], "the blank lines with a stray CR between blocks are no stray text");

  // An edit of another string changes only that string's bytes.
  const at = text.indexOf("To edit");
  t.set(2, "Edited\ntwo lines");
  assert.equal(t.serialize(), text.slice(0, at) + "Edited\r\ntwo lines" + text.slice(at + "To edit".length));
  t.markSaved();
  assert.equal(t.get(1), `The bounces does half the ${CRCRLF}damage of the original explosion.`, "the neighbours read the same");

  // An edit of the string itself: what stays of the CRs is what the new text has. A text that still has them
  // keeps them; plain line breaks (what a text box gives back) become the file's line ends.
  const one = new StringTable(text);
  const from = text.indexOf("The bounces"), to = text.indexOf("explosion.") + "explosion.".length;
  one.set(1, `${one.get(1)!} More.`);
  assert.equal(one.serialize(), text.slice(0, to) + " More." + text.slice(to));
  one.set(1, "The bounces does half the \n\ndamage of the original explosion.");
  assert.equal(one.serialize(), text.slice(0, from) + "The bounces does half the \r\n\r\ndamage of the original explosion." + text.slice(to));

  // Merging another editor's change onto the file, importing a translation, dropping and renumbering keep them too.
  const edited = new StringTable(text);
  edited.set(6, "LAST");
  assert.equal(StringTable.merge(text, edited, text), text.replace("last\r\n}", "LAST\r\n}"));
  assert.equal(importStrings(text, "STRING 5\n{\nnach einem Kopf\n}\n").text, text.replace("after a header", "nach einem Kopf"));
  const dropped = pruneStrings(text, new Set([1, 3, 5, 6]));
  assert.deepEqual(dropped.dropped, [2, 4]);
  const cut = (s: string, a: string, b: string) => s.slice(0, s.indexOf(a)) + s.slice(s.indexOf(b));
  assert.equal(dropped.text, cut(cut(text, "STRING 2", "STRING 3"), "STRING 4", "STRING 5"));
  assert.equal(renumberWts(text, new Map([[5, 50]])), text.replace(`STRING 5${CRCRLF}`, `STRING 50${CRCRLF}`));
});
