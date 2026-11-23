import assert from "node:assert/strict";
import { test } from "node:test";
import { doodadNumber, EDITOR_DOO_VERSION, editorDooVersion } from "./dooversion";

const UNSET = 0xffffffff;
const v8 = (id: string, editorId: number, more: Record<string, unknown> = {}) =>
  ({ id, variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1], flags: 2, life: 100, itemTable: -1, itemSets: [], editorId, ...more });

test("a version-8 doodads file becomes version 13: the number moves into the trailer, as the World Editor's save writes it", () => {
  // we-drive 2026-11-23 (tests/we-compare/doo-v13.json): AutumnLeaves (8/11 with skin ids) and a copy without them came
  // back 13/11, every doodad with preFlags 0xFFFFFFFF, editorId 0xFFFFFFFF, trailer [its editorId, 0, 0], no extras,
  // its skin id or its type's id; the specials as they were.
  const specials = [{ id: "YTlb", z: 0, x: 3, y: 2 }];
  const doc = { format: "w3proj.doodads/1", magic: "W3do", version: 8, subversion: 11, skinIds: false, doodads: [v8("LTlt", 350), v8("LTba", 7, { itemSets: [[{ id: "phea", chance: 60 }]] })], specialVersion: 0, specials: structuredClone(specials) };
  assert.equal(editorDooVersion(doc), true);
  assert.equal(doc.version, EDITOR_DOO_VERSION);
  assert.equal(doc.subversion, 11, "the subversion stays");
  assert.equal("skinIds" in doc, false, "version 13 has no skinIds switch");
  assert.deepEqual(doc.doodads, [
    v8("LTlt", UNSET, { skinId: "LTlt", preFlags: UNSET, trailer: [350, 0, 0], extras: [] }),
    v8("LTba", UNSET, { itemSets: [[{ id: "phea", chance: 60 }]], skinId: "LTba", preFlags: UNSET, trailer: [7, 0, 0], extras: [] }),
  ]);
  assert.deepEqual(doc.specials, specials);
  // A second call has nothing left to do.
  assert.equal(editorDooVersion(doc), false);
});

test("skin ids of a Reforged version-8 file are kept; an empty file is upgraded too", () => {
  const doc = { version: 8, subversion: 11, skinIds: true, doodads: [{ id: "LTlt", skinId: "LTl2", itemTable: 3, itemSets: [], editorId: 0 }] };
  assert.equal(editorDooVersion(doc), true);
  assert.deepEqual(doc, { version: 13, subversion: 11, doodads: [{ id: "LTlt", skinId: "LTl2", itemTable: 3, itemSets: [], editorId: UNSET, preFlags: UNSET, trailer: [0, 0, 0], extras: [] }] });
  const empty = { version: 8, subversion: 11, skinIds: false, doodads: [] };
  assert.equal(editorDooVersion(empty), true);
  assert.deepEqual(empty, { version: 13, subversion: 11, doodads: [] });
});

test("a version-7 file gets no item table and no item sets besides the 3.0 fields", () => {
  // we-drive 2026-11-23 (make-doo-v13.mjs autumn-doo-v7): itemTable -1, itemSets [].
  const doc = { version: 7, subversion: 11, doodads: [{ id: "LTlt", flags: 2, life: 100, editorId: 12 }] };
  assert.equal(editorDooVersion(doc), true);
  assert.deepEqual(doc, { version: 13, subversion: 11, doodads: [{ id: "LTlt", flags: 2, life: 100, editorId: UNSET, skinId: "LTlt", preFlags: UNSET, itemTable: -1, itemSets: [], trailer: [12, 0, 0], extras: [] }] });
});

test("a version-12 file becomes version 13: its two trailer values follow the number, its own fields stay", () => {
  // we-drive 2026-11-23 (make-doo-v13.mjs autumn-doo-v12): trailer [0, 0] came back [editorId, 0, 0].
  const own = { preFlags: 7, extras: [[1, 2, 3, 4, 5, 6, 7, 8, 9]] };
  const doc = { version: 12, subversion: 11, doodads: [v8("LTlt", 5, { skinId: "LTlt", trailer: [0, 0], ...structuredClone(own) }), v8("LTlt", 6, { skinId: "LTlt", trailer: [1, 2], preFlags: UNSET, extras: [] })] };
  assert.equal(editorDooVersion(doc), true);
  assert.equal(doc.version, 13);
  assert.deepEqual(doc.doodads, [
    v8("LTlt", UNSET, { skinId: "LTlt", trailer: [5, 0, 0], ...own }),
    v8("LTlt", UNSET, { skinId: "LTlt", trailer: [6, 1, 2], preFlags: UNSET, extras: [] }),
  ]);
});

test("a doodad an undo put back into an upgraded file gets the fields; complete ones are left alone", () => {
  const whole = v8("LTlt", UNSET, { skinId: "LTlt", preFlags: 0, trailer: [3, 1, 2], extras: [] });
  const doc = { version: 13, subversion: 11, doodads: [structuredClone(whole), v8("LTba", 9)] };
  assert.equal(editorDooVersion(doc), true);
  assert.deepEqual(doc.doodads, [whole, v8("LTba", UNSET, { skinId: "LTba", preFlags: UNSET, trailer: [9, 0, 0], extras: [] })]);
  // A version-13 file whose doodads are complete is left alone, a real editorId beside the trailer too.
  const kept = { version: 13, subversion: 11, doodads: [structuredClone(whole), { ...structuredClone(whole), editorId: 4 }] };
  const before = structuredClone(kept);
  assert.equal(editorDooVersion(kept), false);
  assert.deepEqual(kept, before);
});

test("other versions and documents that aren't lists of doodads are left as they are", () => {
  for (const doc of [
    { version: 9, subversion: 11, doodads: [{ id: "LTlt", editorId: 1 }] },
    { version: 14, subversion: 11, doodads: [] },
    { version: 8, subversion: 11, doodads: [{ id: "LTlt", editorId: 1 }, 7] },
    { version: 8, subversion: 11, doodads: [{ id: 5, editorId: 1 }] },
    { version: 8, subversion: 11, doodads: [{ id: "LTlt", editorId: "1" }] },
    { version: 12, subversion: 11, doodads: [{ id: "LTlt", editorId: 1, trailer: "x" }] },
    { version: 8, subversion: 11, doodads: [[]] },
    { version: 8, subversion: 11, doodads: null },
    { version: 8, subversion: 11, units: [] },
    { version: "x", subversion: 11, doodads: [] },
  ] as Record<string, unknown>[]) {
    const before = structuredClone(doc);
    assert.equal(editorDooVersion(doc), false, JSON.stringify(before));
    assert.deepEqual(doc, before);
  }
});

test("a doodad's creation number is read from where its layout keeps it", () => {
  assert.equal(doodadNumber({ editorId: UNSET, trailer: [42, 0, 0] }), 42);
  assert.equal(doodadNumber({ editorId: 7 }), 7);
  assert.equal(doodadNumber({ editorId: 7, trailer: [0, 0] }), 7, "a unit's or a version-12 doodad's trailer has two values");
});
