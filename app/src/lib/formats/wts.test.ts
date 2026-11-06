import assert from "node:assert/strict";
import { test } from "node:test";
import { importStrings } from "./wts";

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
