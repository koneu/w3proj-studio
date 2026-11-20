import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "../../lib/formats/wts";
import { mdxPathOf } from "../../lib/model/mdxpath";
import { ICON_FIELD, KINDS, KIND_LABELS, trigstrText } from "./shared";

test("kind labels follow the kinds table, and only kinds with an icon have an icon field", () => {
  assert.deepEqual(Object.keys(KIND_LABELS), KINDS.map((k) => k.ext));
  assert.equal(KIND_LABELS.w3h, "Buffs/Effects");
  assert.deepEqual(Object.keys(ICON_FIELD).sort(), ["w3a", "w3h", "w3q", "w3t", "w3u"]);
  for (const k of Object.keys(ICON_FIELD)) assert.ok(KIND_LABELS[k]);
});

test("a TRIGSTR value gives its text; anything else, or a missing string, gives null", () => {
  const table = new StringTable("STRING 7\n{\nHello\n}\n");
  assert.equal(trigstrText(table, "TRIGSTR_007"), "Hello");
  assert.equal(trigstrText(table, "TRIGSTR_7"), "Hello");
  assert.equal(trigstrText(table, "TRIGSTR_008"), null);
  assert.equal(trigstrText(table, "Hello"), null);
  assert.equal(trigstrText(table, 7), null);
  // control: the test can fail
  assert.notEqual(trigstrText(table, "TRIGSTR_007"), null);
});

test("a model path names the game's .mdx", () => {
  assert.equal(mdxPathOf("Units\\Human\\Footman\\Footman.mdl"), "Units\\Human\\Footman\\Footman.mdx");
  assert.equal(mdxPathOf("A.MDL"), "A.mdx");
  assert.equal(mdxPathOf("Units\\Footman"), "Units\\Footman.mdx");
  assert.equal(mdxPathOf("A.mdx"), "A.mdx");
});
