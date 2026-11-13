// The record of dropped strings (.w3proj/pruned-strings.json): read strictly, restored only where referenced and
// missing, updated so that it holds only what is gone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePrunedStrings, restorePrunedStrings, serializePrunedStrings, updatePrunedRecord } from "./prunedstrings";
import { StringTable } from "./wts";

const block = (n: number, text: string) => `STRING ${n}\r\n{\r\n${text}\r\n}\r\n\r\n`;

test("the file round-trips, numbers ascending", () => {
  const m = new Map([[12, "two\nlines"], [3, "three"]]);
  const text = serializePrunedStrings(m);
  assert.ok(text.indexOf("\"3\"") < text.indexOf("\"12\""));
  assert.deepEqual([...parsePrunedStrings(text)], [[3, "three"], [12, "two\nlines"]]);
});

test("anything else is refused, never taken for an empty record", () => {
  for (const bad of ["", "{", "null", "[]", "{}", "{\"format\":\"other\",\"strings\":{}}", "{\"format\":\"w3proj.prunedStrings/1\",\"strings\":[]}",
    "{\"format\":\"w3proj.prunedStrings/1\",\"strings\":{\"x\":\"a\"}}", "{\"format\":\"w3proj.prunedStrings/1\",\"strings\":{\"1\":2}}",
    "{\"format\":\"w3proj.prunedStrings/1\",\"strings\":{\"-1\":\"a\"}}", "{\"format\":\"w3proj.prunedStrings/1\",\"strings\":{\"99999999999999999999\":\"a\"}}"]) {
    assert.throws(() => parsePrunedStrings(bad), /pruned-strings\.json/, bad);
  }
});

test("restores only recorded strings that are referenced and missing, at the end with their old numbers", () => {
  const wts = "﻿" + block(1, "one") + block(2, "two");
  const record = new Map([[2, "old two"], [5, "five\nsecond line"], [7, "seven"]]);
  const r = restorePrunedStrings(wts, record, new Set([1, 2, 5]));
  assert.deepEqual(r.restored, [5], "2 is there (its text stays), 7 isn't referenced");
  assert.equal(r.text, wts + "STRING 5\r\n{\r\nfive\r\nsecond line\r\n}\r\n\r\n");
  assert.equal(new StringTable(r.text).get(2), "two");
  const none = restorePrunedStrings(wts, record, new Set([1]));
  assert.deepEqual(none, { text: wts, restored: [] });
});

test("the record after a drop: dropped texts in, numbers in the table out; unchanged is null", () => {
  const before = block(1, "one") + block(2, "two\r\nlines") + block(3, "three");
  const after = block(1, "one") + block(4, "four");
  const next = updatePrunedRecord(new Map([[4, "old four"], [9, "nine"]]), before, [2, 3], after)!;
  assert.deepEqual([...next].sort((a, b) => a[0] - b[0]), [[2, "two\nlines"], [3, "three"], [9, "nine"]]);
  assert.equal(updatePrunedRecord(new Map([[9, "nine"]]), after, [], after), null);
});
