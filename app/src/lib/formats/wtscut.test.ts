// A line that is just `}` (or starts with it) inside a string's text: the game ends the string there and
// drops the rest (user, map 17, 2026-11-08: "Test 2"), and so does Studio's parser. Every write of the
// string table goes through StringTable.serialize, which refuses such a text instead of writing it.
// Only the API that was there before the fix is used here, so these fail on the old code by assertion.

import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "./wts";

const map = "STRING 1\r\n{\r\nMy Map\r\n}\r\n\r\nSTRING 2\r\n{\r\nA hero\r\n}\r\n\r\nSTRING 3\r\n{\r\nKept\r\n}\r\n";

test("without the refusal the text comes back cut: the oracle for the checks below", () => {
  const raw = map.replace("A hero", "Line one\r\n}\r\nLine three");
  assert.equal(new StringTable(raw).get(2), "Line one");
  assert.equal(new StringTable(raw).get(3), "Kept");
});

test("a text with a brace line is refused, not written and cut", () => {
  const t = new StringTable(map);
  t.set(2, "Line one\n}\nLine three");
  assert.throws(() => t.serialize(), (e: Error) => /string 2 \(line 2\)/.test(e.message) && /" }"/.test(e.message));
  assert.throws(() => t.markSaved(), /starts with "}"/);
});

test("a line that starts with a brace is refused too (Studio's parser ends the block there)", () => {
  const t = new StringTable(map);
  t.set(2, "Line one\n} and more");
  assert.throws(() => t.serialize(), /starts with "}"/);
});

test("merging an editor's strings onto the file refuses a cut text", () => {
  const edited = new StringTable(map);
  edited.set(1, "Name\n}\nrest");
  assert.throws(() => StringTable.merge(map, edited, map), /starts with "}"/);
});

test("a safe text with braces elsewhere is written and read back whole", () => {
  const t = new StringTable(map);
  t.set(2, "set {a}\n  }\nend}");
  assert.equal(new StringTable(t.serialize()).get(2), "set {a}\r\n  }\r\nend}");
});
