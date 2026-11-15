// A `}` inside a string's text: the game ends the string there and drops the rest (user, map 17, 2026-11-08: "Test 2"
// at a line that was just `}`; map 24, 2026-11-15: the name and description lost their " }" at the end), and so do the
// World Editor's reader and Studio's. Every write of the string table goes through StringTable.serialize, which
// refuses such a text instead of writing it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "./wts";

const map = "STRING 1\r\n{\r\nMy Map\r\n}\r\n\r\nSTRING 2\r\n{\r\nA hero\r\n}\r\n\r\nSTRING 3\r\n{\r\nKept\r\n}\r\n";

test("without the refusal the text comes back cut: the oracle for the checks below", () => {
  const raw = map.replace("A hero", "Line one\r\n}\r\nLine three");
  assert.equal(new StringTable(raw).get(2), "Line one");
  assert.equal(new StringTable(raw).get(3), "Kept");
  // map 24's name, as the game showed it
  assert.equal(new StringTable(map.replace("My Map", "24 Texts with a brace }")).get(1), "24 Texts with a brace ");
});

test("a text with a brace line is refused, not written and cut", () => {
  const t = new StringTable(map);
  t.set(2, "Line one\n}\nLine three");
  assert.throws(() => t.serialize(), (e: Error) => /string 2 \(line 2\)/.test(e.message) && /no way to keep one/.test(e.message));
  assert.throws(() => t.markSaved(), /a "}"/);
});

test("map 24's texts are refused: a } at the end, at the start and in the middle of a line", () => {
  for (const v of ["24 Texts with a brace }", "} Loading title starts with a brace", "Loading subtitle: a { and a } in the middle",
    "Loading text, first line\nlast line ends with a space and a brace }", "Line one\n } indented"]) {
    const t = new StringTable(map);
    t.set(2, v);
    assert.throws(() => t.serialize(), /a "}"/, v);
  }
});

test("merging an editor's strings onto the file refuses a cut text", () => {
  const edited = new StringTable(map);
  edited.set(1, "Name\n}\nrest");
  assert.throws(() => StringTable.merge(map, edited, map), /a "}"/);
});

test("a text with a { or a \\} is written and read back whole", () => {
  const t = new StringTable(map);
  t.set(2, "set {a\n  {\nend \\}");
  assert.equal(new StringTable(t.serialize()).get(2), "set {a\r\n  {\r\nend \\}");
});
