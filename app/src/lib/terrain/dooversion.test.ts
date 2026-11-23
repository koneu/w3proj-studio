import assert from "node:assert/strict";
import { test } from "node:test";
import type { LightFixed, ModelLight } from "../model/mdx";
import { doodadNumber, EDITOR_DOO_VERSION, editorDooVersion, lightBlock, lightBlocks } from "./dooversion";

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

/** A float's bits as the codec keeps them. */
const bits = (f: number) => { const v = new DataView(new ArrayBuffer(4)); v.setFloat32(0, f, true); return v.getUint32(0, true); };
/** A u32's float, as the game's models store their values. */
const float = (u: number) => { const v = new DataView(new ArrayBuffer(4)); v.setUint32(0, u, true); return v.getFloat32(0, true); };
const SD_REST = { shadowStart: 0, shadowEnd: 0, quadratic: float(973279855), linear: 0, damping: float(925353388) };
/** A light with fixed values only, as the readers give it. */
const light = (fixed: LightFixed): ModelLight => ({ node: { name: "Omni01", objectId: 0, parentId: -1, flags: 0x200, kind: "lite" }, type: 0, attenuationStart: 80, attenuationEnd: 200, color: fixed.color, intensity: fixed.intensity, fixed });

test("a model's light as the World Editor's save writes it into a doodad's extras", () => {
  // we-drive 2026-11-23 (tests/we-compare/doo-lights.json, SD): the game's models' values as stored (their f32 bits) and
  // the blocks the editor's save wrote for them.
  const lamp = (intensity: number) => light({ color: [1, 1, 1], intensity, ...SD_REST });
  assert.deepEqual(lightBlocks([lamp(11)]), [[0, 0, 0xffffffff, bits(11), 0, 0, 973279855, 0, 925353388]], "LOlp variation 0");
  // YOlp: colour 1, 0.968628, 0.623529 (times 255: 247.0001 and 158.9999, cut down), intensity 0 under a KLAI track.
  const yolp = light({ color: [1, float(1064826881), float(1059037081)], intensity: 0, ...SD_REST });
  yolp.intensity = 1;
  assert.deepEqual(lightBlocks([yolp]), [[0, 0, 0xfffff79e, 0, 0, 0, 973279855, 0, 925353388]], "the fixed intensity, not the drawn one");
  // Two lights (YOf1, DTs0): one block each, numbered.
  assert.deepEqual(lightBlocks([lamp(30), lamp(30)])?.map((b) => b[0]), [0, 1]);
  // make-doo-lights.mjs LightA: every value its own.
  const a = light({ color: [0.25, 0.5, 0.75].map(Math.fround) as [number, number, number], intensity: 6.5, shadowStart: 30, shadowEnd: 90, quadratic: Math.fround(0.002), linear: Math.fround(0.03), damping: Math.fround(0.0004) });
  assert.deepEqual(lightBlocks([a]), [[0, 0, 0xff3f7fbf, bits(6.5), bits(30), bits(90), bits(0.002), bits(0.03), bits(0.0004)]]);
  // Out of range and unreadable colours stay within a byte.
  assert.equal(lightBlock(0, { color: [2, -1, NaN], intensity: 0, ...SD_REST })[2], 0xffff0000);
  assert.deepEqual(lightBlocks(undefined), [], "a model without lights");
  assert.equal(lightBlocks([{ ...lamp(1), fixed: undefined }]), null, "a light without its fixed values isn't guessed at");
});

test("a doodad without lights of its own gets its model's when the file is saved, a version-13 file's too", () => {
  const block = [0, 0, 0xffffffff, bits(11), 0, 0, 973279855, 0, 925353388];
  const own = [[0, 1, 0xff102030, 1, 2, 3, 4, 5, 6]];
  const lights = new Map<string, number[][] | null>([["LOlp", [block]], ["LTlt", []], ["ZZZZ", null]]);
  const lightsOf = (d: Readonly<Record<string, unknown>>) => lights.get(String(d.id));
  const v13 = (id: string, extras: number[][]) => ({ ...v8(id, UNSET, { skinId: id, preFlags: UNSET, trailer: [1, 0, 0] }), extras });
  const doc = { version: 13, subversion: 11, doodads: [v13("LOlp", []), v13("LOlp", structuredClone(own)), v13("LTlt", []), v13("ZZZZ", []), v13("QQQQ", [])] };
  assert.equal(editorDooVersion(doc, lightsOf), true);
  assert.deepEqual(doc.doodads.map((d) => d.extras), [[block], own, [], [], []], "its own lights kept; a model without lights, an unread one and an unknown type keep []");
  assert.notEqual(doc.doodads[0].extras[0], block, "a copy of the block");
  assert.equal(editorDooVersion(doc, lightsOf), false, "nothing left to do");
  // Without the models' lights (no lookup) nothing is given.
  const plain = { version: 13, subversion: 11, doodads: [v13("LOlp", [])] };
  assert.equal(editorDooVersion(plain), false);
  // An upgraded version-8 doodad (no extras at all) gets them as well.
  const old = { version: 8, subversion: 11, skinIds: false, doodads: [v8("LOlp", 5)] };
  assert.equal(editorDooVersion(old, lightsOf), true);
  assert.deepEqual(old.doodads[0], v8("LOlp", UNSET, { skinId: "LOlp", preFlags: UNSET, trailer: [5, 0, 0], extras: [block] }));
});

test("a doodad's creation number is read from where its layout keeps it", () => {
  assert.equal(doodadNumber({ editorId: UNSET, trailer: [42, 0, 0] }), 42);
  assert.equal(doodadNumber({ editorId: 7 }), 7);
  assert.equal(doodadNumber({ editorId: 7, trailer: [0, 0] }), 7, "a unit's or a version-12 doodad's trailer has two values");
});
