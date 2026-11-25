// object-text-census.mjs: one map's counts from its unpacked map/ folder. Moved fields count as references, literals or
// empty texts in the main and Skin files alike (levels and sets too); other fields only count their references; the
// editor's object comment in war3map.wts is told from a comment of the map's own.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { censusOf } from "./object-text-census.mjs";

const objects = (custom) => JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom });
const moved = new Set(["unam", "utip", "anam"]);

test("moved fields are counted by form in main and Skin files, other fields only by references", () => {
  const dir = scratchDir("w3proj-object-text-census-");
  writeFileSync(join(dir, "war3map.w3u.json"), objects([{ base: "hfoo", id: "h000", mods: [
    { field: "unam", type: "string", value: "Plain" },
    { field: "utip", type: "string", value: "" },
    { field: "umdl", type: "string", value: "TRIGSTR_009" },
    { field: "uhpm", type: "int", value: 5 },
  ] }]));
  writeFileSync(join(dir, "war3mapSkin.w3u.json"), objects([{ base: "hfoo", id: "h000", mods: [{ field: "utip", type: "string", value: "TRIGSTR_003" }] }]));
  writeFileSync(join(dir, "war3map.w3a.json"), objects([{ base: "AHhb", id: "A000", sets: [{ flag: 0, mods: [{ field: "anam", type: "string", level: 0, data: 0, value: "TRIGSTR_004" }] }] }]));
  writeFileSync(join(dir, "war3map.wts"), "STRING 3\r\n// Units: h000 (Plain), Tip (Tooltip - Basic)\r\n{\r\nTip\r\n}\r\n");
  writeFileSync(join(dir, "war3map.w3i.json"), JSON.stringify({ players: [{ name: "TRIGSTR_001" }] }));
  const c = censusOf(dir, moved);
  assert.deepEqual(
    { refs: c.refs, literal: c.literal, empty: c.empty, skinFiles: c.skinFiles, otherRefs: c.otherRefs, weComments: c.weComments },
    { refs: 2, literal: 1, empty: 1, skinFiles: 1, otherRefs: 1, weComments: true },
  );
  assert.deepEqual(c.byField.utip, { refs: 1, literal: 0, empty: 1 });
});

test("a comment of the map's own is not the editor's mark", () => {
  const dir = scratchDir("w3proj-object-text-census-");
  writeFileSync(join(dir, "war3map.wts"), "STRING 3\r\n// my notes: Units: h000\r\n{\r\nTip\r\n}\r\n");
  assert.equal(censusOf(dir, moved).weComments, false);
});
