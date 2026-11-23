import assert from "node:assert/strict";
import { test } from "node:test";
import { EDITOR_UNITS_VERSION, editorUnitsVersion } from "./unitsversion";

const unit = (id: string, more: Record<string, unknown> = {}) => ({ id, variation: 0, position: [0, 0, 0], player: 0, itemTable: -1, ...more });

test("a version-8 units file becomes version 13 with the 3.0 fields, as the World Editor's save writes it", () => {
  // we-drive 2026-11-23 (tests/we-compare/units-v13.json): AutumnLeaves (8/11 with skin ids) and a copy without them
  // came back 13/11, every unit with preFlags 0xFFFFFFFF, trailer [0, 0], no extras, its skin id or its type's id.
  const doc = { format: "w3proj.units/1", magic: "W3do", version: 8, subversion: 11, skinIds: false, units: [unit("hfoo"), unit("sloc")] };
  assert.equal(editorUnitsVersion(doc), true);
  assert.equal(doc.version, EDITOR_UNITS_VERSION);
  assert.equal(doc.subversion, 11, "the subversion stays");
  assert.equal("skinIds" in doc, false, "version 13 has no skinIds switch");
  assert.deepEqual(doc.units, [
    unit("hfoo", { skinId: "hfoo", preFlags: 0xffffffff, trailer: [0, 0], extras: [] }),
    unit("sloc", { skinId: "sloc", preFlags: 0xffffffff, trailer: [0, 0], extras: [] }),
  ]);
  // A second call has nothing left to do.
  assert.equal(editorUnitsVersion(doc), false);
});

test("skin ids of a Reforged version-8 file and a subversion of 9 are kept", () => {
  const doc = { version: 8, subversion: 9, skinIds: true, units: [{ id: "hfoo", skinId: "hfo2" }] };
  assert.equal(editorUnitsVersion(doc), true);
  assert.deepEqual(doc, { version: 13, subversion: 9, units: [{ id: "hfoo", skinId: "hfo2", preFlags: 0xffffffff, trailer: [0, 0], extras: [] }] });
  // An empty file is upgraded too (a new start location is added to it by the save).
  const empty = { version: 8, subversion: 11, skinIds: false, units: [] };
  assert.equal(editorUnitsVersion(empty), true);
  assert.deepEqual(empty, { version: 13, subversion: 11, units: [] });
});

test("an entry an undo put back into an upgraded file gets the fields; its own values are kept", () => {
  const own = { id: "hfoo", skinId: "hfoo", preFlags: 7, trailer: [3, 4], extras: [[1, 2, 3, 4, 5, 6, 7, 8, 9]] };
  const doc = { version: 13, subversion: 11, units: [structuredClone(own), { id: "Hpal" }] };
  assert.equal(editorUnitsVersion(doc), true);
  assert.deepEqual(doc.units, [own, { id: "Hpal", skinId: "Hpal", preFlags: 0xffffffff, trailer: [0, 0], extras: [] }]);
  // A version-13 file whose entries are complete is left alone.
  const whole = { version: 13, subversion: 9, units: [structuredClone(own)] };
  assert.equal(editorUnitsVersion(whole), false);
  assert.deepEqual(whole, { version: 13, subversion: 9, units: [own] });
});

test("a version-7 file becomes version 13 too, its subversion 9 kept", () => {
  // we-drive 2026-11-23 (make-units-v13.mjs autumn-v7): the editor saved it as 13 (its 11 there came from flag 0x4000).
  const doc = { version: 7, subversion: 9, units: [{ id: "hfoo" }] };
  assert.equal(editorUnitsVersion(doc), true);
  assert.deepEqual(doc, { version: 13, subversion: 9, units: [{ id: "hfoo", skinId: "hfoo", preFlags: 0xffffffff, trailer: [0, 0], extras: [] }] });
});

test("other versions and documents that aren't lists of entries are left as they are", () => {
  for (const doc of [
    { version: 12, subversion: 11, units: [{ id: "hfoo" }] },
    { version: 8, subversion: 11, units: [{ id: "hfoo" }, 7] },
    { version: 8, subversion: 11, units: [{ id: 5 }] },
    { version: 8, subversion: 11, units: [[]] },
    { version: 8, subversion: 11, units: "none" },
    { version: "x", subversion: 11, units: [] },
  ] as Record<string, unknown>[]) {
    const before = structuredClone(doc);
    assert.equal(editorUnitsVersion(doc), false, JSON.stringify(before));
    assert.deepEqual(doc, before);
  }
});
