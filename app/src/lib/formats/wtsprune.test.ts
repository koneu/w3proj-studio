// Strings nothing refers to leave war3map.wts (pruneStrings), as the World Editor drops them on every save: the rest of
// the file stays byte for byte, the strings that stay keep their numbers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable, pruneStrings } from "./wts";

const block = (n: number, text: string, comment?: string) => `STRING ${n}\r\n${comment ? `// ${comment}\r\n` : ""}{\r\n${text}\r\n}\r\n\r\n`;

test("unreferenced strings go with their comments; the others keep numbers, comments, order and bytes", () => {
  const wts = "﻿" + block(1, "Player 1") + block(3, "orphan", "a comment") + block(2, "Force 1", "kept comment") + block(40, "region forty") + block(7, "Unit Seven", "Units: h000");
  const r = pruneStrings(wts, new Set([1, 2, 7, 99]));
  assert.deepEqual(r.dropped, [3, 40]);
  assert.equal(r.text, "﻿" + block(1, "Player 1") + block(2, "Force 1", "kept comment") + block(7, "Unit Seven", "Units: h000"));
  const back = new StringTable(r.text);
  assert.deepEqual([...back.entries()].map(([n]) => n), [1, 2, 7], "no renumbering");
});

test("nothing to drop gives the text itself; an empty reference set drops every string", () => {
  const wts = block(1, "a") + block(2, "b");
  const same = pruneStrings(wts, new Set([1, 2]));
  assert.equal(same.text, wts);
  assert.deepEqual(same.dropped, []);
  const all = pruneStrings(wts, new Set());
  assert.deepEqual(all.dropped, [1, 2]);
  assert.equal(new StringTable(all.text).entries().next().done, true);
});

test("LF files, a last block without a blank line, multi-line texts and a repeated number", () => {
  const wts = "STRING 5\n{\nline one\nline two\n}\nSTRING 6\n{\ngone\n}\nSTRING 5\n{\nagain\n}";
  const r = pruneStrings(wts, new Set([5]));
  assert.deepEqual(r.dropped, [6]);
  assert.equal(r.text, "STRING 5\n{\nline one\nline two\n}\nSTRING 5\n{\nagain\n}");
  const twice = pruneStrings(wts, new Set([6]));
  assert.deepEqual(twice.dropped, [5], "a number given twice is listed once");
  assert.equal(twice.text, "STRING 6\n{\ngone\n}\n");
});

test("a block the parser can't close stays where it is", () => {
  const wts = block(1, "orphan") + "STRING 2\r\n{\r\nno end";
  const r = pruneStrings(wts, new Set());
  assert.deepEqual(r.dropped, [1]);
  assert.equal(r.text, "STRING 2\r\n{\r\nno end");
});

test("the World Editor's save of a real map's table with orphans added (we-drive, SnowareBay): the same strings stay", () => {
  // The map's 13 strings, orphans 50 (after 5), 20 and 21 added; the World Editor's save gave the map's own file back.
  const own = "﻿" + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => block(n, `text ${n}`)).join("");
  const at = own.indexOf("STRING 6");
  const input = own.slice(0, at) + block(50, "orphan 50", "orphan comment 50") + own.slice(at)
    + block(20, "orphan 20\r\nsecond line") + block(21, "orphan 21", "orphan comment 21");
  const refs = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  const r = pruneStrings(input, refs);
  assert.deepEqual(r.dropped, [20, 21, 50]);
  assert.equal(r.text, own, "byte for byte what the World Editor wrote");
});
