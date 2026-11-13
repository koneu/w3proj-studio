// The languages' string tables (`_Locales/xxXX.w3mod/war3map.wts`) under Adjust Map String IDs and the tools that add
// strings: the shared fixture tests/fixtures/wts-prune (war3map.wts with 1-10, 0012 and 13; a German table with 1, 3, 5,
// 12 and a German-only 30, LF line ends, a block that ends on its last line).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { addLocaleStrings, adjustStringTables, localeNumbers, localeOnlyNumbers, renumberLocaleTables } from "./localewts";
import { compactStringIds, renumberWts, StringTable } from "./wts";

function fixture(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "wts-prune");
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) throw new Error("tests/fixtures/wts-prune not found");
  }
}
const DE_PATH = "map/_Locales/deDE.w3mod/war3map.wts";
const FR_PATH = "map/_Locales/frFR.w3mod/war3map.wts";
const MAIN = readFileSync(join(fixture(), "map", "war3map.wts"), "utf8");
const DE = readFileSync(join(fixture(), DE_PATH), "utf8");
const block = (n: number, t: string, eol = "\r\n") => `STRING ${n}${eol}{${eol}${t}${eol}}${eol}${eol}`;
/** A French table in CRLF holding none of the numbers that move. */
const FR = block(1, "Nom de la carte") + block(2, "Fantassin");
const entries = (wts: string) => [...new StringTable(wts).entries()];

test("the languages' own numbers: those war3map.wts lacks, with the first table that has them", () => {
  const main = new StringTable(MAIN);
  assert.deepEqual([...localeOnlyNumbers(main, [{ path: DE_PATH, wts: DE }])], [[30, DE_PATH]]);
  assert.deepEqual([...localeOnlyNumbers(main, [{ path: FR_PATH, wts: FR + block(30, "x") }, { path: DE_PATH, wts: DE }])], [[30, FR_PATH]]);
  // Without war3map.wts every number is a language's own.
  assert.deepEqual([...localeOnlyNumbers(null, [{ path: FR_PATH, wts: FR }]).keys()], [1, 2]);
  assert.deepEqual([...localeNumbers([DE, new StringTable(FR)])].sort((a, b) => a - b), [1, 2, 3, 5, 12, 30]);
});

test("renumbering all from 1 steps over a language's own number and renumbers the German table the same way", () => {
  const main = new StringTable(MAIN);
  const localeOnly = localeOnlyNumbers(main, [{ path: DE_PATH, wts: DE }]);
  // The control: without the German table's numbers 0012 and 13 become 11 and 12 all the same (30 is out of reach).
  assert.deepEqual([...compactStringIds(main, 1)], [[12, 11], [13, 12]]);
  const ids = compactStringIds(main, 1, new Set(localeOnly.keys()));
  assert.deepEqual([...ids], [[12, 11], [13, 12]]);
  const r = adjustStringTables(MAIN, [{ path: DE_PATH, wts: DE }, { path: FR_PATH, wts: FR }], ids);
  assert.equal(r.wts, renumberWts(MAIN, ids));
  assert.ok(r.wts.includes("STRING 0011\n"), "the padded number keeps its width");
  // Only the German table changes (French has none of the numbers): its 12 is 11 now, its header's digits the only
  // bytes that changed, and its own 30 stays.
  assert.deepEqual(r.locales.map((l) => l.path), [DE_PATH]);
  const de = r.locales[0].wts;
  assert.equal(de, DE.replace("STRING 12\n", "STRING 11\n"));
  assert.notEqual(de, DE, "the control: the German table did change");
  const before = new Map(entries(DE));
  assert.deepEqual(entries(de), [...before].map(([n, v]) => [ids.get(n) ?? n, v]));
  assert.equal(new StringTable(de).get(30), "nur deutsch");
  // Main and German agree again: 11 is the string 12 was in both.
  assert.equal(new StringTable(r.wts).get(11), new StringTable(MAIN).get(12));
  assert.equal(new StringTable(de).get(11), before.get(12));
});

test("renumbering all from 1: a language's own number in reach is stepped over", () => {
  const main = block(1, "one") + block(2, "two") + block(5, "five");
  const de = block(1, "eins") + block(3, "nur deutsch") + block(5, "fünf");
  const locales = [{ path: DE_PATH, wts: de }];
  // The control: without the German table 5 would become 3, the German-only number.
  assert.deepEqual([...compactStringIds(new StringTable(main), 1)], [[5, 3]]);
  const ids = compactStringIds(new StringTable(main), 1, new Set(localeOnlyNumbers(new StringTable(main), locales).keys()));
  assert.deepEqual([...ids], [[5, 4]]);
  const r = adjustStringTables(main, locales, ids);
  assert.deepEqual(entries(r.locales[0].wts), [[1, "eins"], [3, "nur deutsch"], [4, "fünf"]]);
  assert.deepEqual(entries(r.wts), [[1, "one"], [2, "two"], [4, "five"]]);
});

test("a string can't take a number only a language has; one past it can", () => {
  const locales = [{ path: DE_PATH, wts: DE }];
  assert.throws(() => adjustStringTables(MAIN, locales, new Map([[13, 30]])),
    /String 30 is in map\/_Locales\/deDE\.w3mod\/war3map\.wts but not in war3map\.wts/);
  // The control: without the German table 30 is free.
  assert.ok(adjustStringTables(MAIN, [], new Map([[13, 30]])).wts.includes("STRING 30\n"));
  const r = adjustStringTables(MAIN, locales, new Map([[3, 31]]));
  assert.equal(r.locales[0].wts, DE.replace("STRING 3\n", "STRING 31\n"));
  // Swapping two numbers both tables have.
  const swap = adjustStringTables(MAIN, locales, new Map([[1, 3], [3, 1]]));
  const de = new StringTable(swap.locales[0].wts), was = new StringTable(DE);
  assert.deepEqual([de.get(1), de.get(3)], [was.get(3), was.get(1)]);
  // A string war3map.wts doesn't have is refused as before, whatever a language has.
  assert.throws(() => adjustStringTables(MAIN, locales, new Map([[30, 40]])), /There's no string 30/);
});

test("a table that doesn't read back under its new numbers throws", () => {
  // 5 onto a number the table has already (what checkStringIds refuses first): two blocks of 6 would hide one another.
  const table = block(5, "a", "\n") + block(6, "b", "\n");
  assert.throws(() => renumberLocaleTables([{ path: DE_PATH, wts: table }], new Map([[5, 6]])), /of .* wouldn't read back as string 6/);
  assert.deepEqual(renumberLocaleTables([{ path: DE_PATH, wts: table }], new Map([[5, 7]])).map((l) => entries(l.wts)), [[[7, "a"], [6, "b"]]]);
});

test("new strings: added in the table's own line ends, a number it has with the same text left, another text refused", () => {
  const blocks = [{ num: 31, text: "new\nline two", comment: "Sounds: a comment" }, { num: 32, text: "other" }];
  const de = addLocaleStrings(DE_PATH, DE, blocks);
  assert.ok(de.startsWith(DE));
  assert.equal(de.slice(DE.length), "STRING 31\n// Sounds: a comment\n{\nnew\nline two\n}\n\nSTRING 32\n{\nother\n}\n\n");
  const fr = addLocaleStrings(FR_PATH, FR, blocks);
  assert.equal(fr.slice(FR.length), "STRING 31\r\n// Sounds: a comment\r\n{\r\nnew\r\nline two\r\n}\r\n\r\nSTRING 32\r\n{\r\nother\r\n}\r\n\r\n");
  assert.equal(addLocaleStrings(DE_PATH, de, blocks), de, "a second time: nothing to add");
  assert.throws(() => addLocaleStrings(DE_PATH, DE, [{ num: 30, text: "something else" }]), /string 30 is in .*deDE.* already, with another text/);
  assert.equal(addLocaleStrings(DE_PATH, DE, []), DE);
});
