import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRandom, autoCycleAfterPlace, cycledId, levelBytes, levelOf, positionsFor, randomName, randomOf, placeAngle, randomWhatOf, rollLook, type LookOptions } from "./randomplace";

const tree = { numVar: 10, randScale: true, minScale: 0.8, maxScale: 1.2, fixedRot: null };
const plain: LookOptions = { variation: null, randomVariation: false, randomRotation: false, randomScale: "off" };
/** A fixed sequence of "random" numbers, so every roll is known. */
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("Random Rotation turns doodads only: a unit or an item keeps facing 270", () => {
  const on = { ...plain, randomRotation: true };
  assert.ok(near(rollLook({ ...tree, kind: "w3d" }, on, () => 0.25).angle, Math.PI / 2));
  for (const kind of ["w3u", "w3t"]) assert.ok(near(rollLook({ ...tree, kind }, on, () => 0.25).angle, (270 * Math.PI) / 180), kind);
});

test("with nothing random a placement is the first variation, facing 270, unscaled", () => {
  const look = rollLook(tree, plain, () => { throw new Error("no roll wanted"); });
  assert.deepEqual(look, { variation: 0, angle: (270 * Math.PI) / 180, scale: [1, 1, 1] });
  // Unknown type: the same.
  assert.deepEqual(rollLook(null, { ...plain, randomVariation: true, randomScale: "symmetric" }, () => 0.5).scale, [1, 1, 1]);
});

test("a chosen variation wins over random, and stays inside the type's", () => {
  assert.equal(rollLook(tree, { ...plain, variation: 3, randomVariation: true }, () => 0.99).variation, 3);
  assert.equal(rollLook(tree, { ...plain, variation: 42 }).variation, 9);
  assert.equal(rollLook(tree, { ...plain, variation: -1 }).variation, 0);
  assert.equal(rollLook(tree, { ...plain, randomVariation: true }, () => 0.55).variation, 5);
  assert.equal(rollLook(tree, { ...plain, randomVariation: true }, () => 0.999999).variation, 9);
  assert.equal(rollLook({ ...tree, numVar: 1 }, { ...plain, randomVariation: true }, () => 0.9).variation, 0);
});

test("random rotation, but a fixed rotation always wins", () => {
  assert.ok(near(rollLook(tree, { ...plain, randomRotation: true }, () => 0.25).angle, Math.PI / 2));
  assert.ok(near(rollLook({ ...tree, fixedRot: 90 }, { ...plain, randomRotation: true }, () => 0.25).angle, Math.PI / 2));
  assert.ok(near(rollLook({ ...tree, fixedRot: 0 }, { ...plain, randomRotation: true }, () => 0.75).angle, 0));
});

test("random scale: symmetric, asymmetric, Z only, XY only, within the type's range", () => {
  const r = () => seq(0, 0.5, 1);
  assert.deepEqual(rollLook(tree, { ...plain, randomScale: "symmetric" }, r()).scale, [0.8, 0.8, 0.8]);
  const a = rollLook(tree, { ...plain, randomScale: "asymmetric" }, r()).scale;
  assert.ok(near(a[0], 0.8) && near(a[1], 1) && near(a[2], 1.2), String(a));
  const z = rollLook(tree, { ...plain, randomScale: "z" }, seq(1)).scale;
  assert.ok(z[0] === 1 && z[1] === 1 && near(z[2], 1.2), String(z));
  const xy = rollLook(tree, { ...plain, randomScale: "xy" }, r()).scale;
  assert.ok(near(xy[0], 0.8) && near(xy[1], 1) && xy[2] === 1, String(xy));
  // Not for types that may not be placed scaled, or have no range.
  assert.deepEqual(rollLook({ ...tree, randScale: false }, { ...plain, randomScale: "symmetric" }, () => 1).scale, [1, 1, 1]);
  assert.deepEqual(rollLook({ ...tree, maxScale: 0.8 }, { ...plain, randomScale: "asymmetric" }, () => 1).scale, [1, 1, 1]);
});

test("random levels are three little-endian bytes, any is ffffff", () => {
  assert.equal(levelBytes(1), "010000");
  assert.equal(levelBytes(10), "0a0000");
  assert.equal(levelBytes(-1), "ffffff");
  assert.equal(levelBytes(300), "2c0100");
});

test("a random object's fields are those its kind stores, nothing of another kind stays", () => {
  const e: Record<string, unknown> = { id: "uDNR", randomType: 2, randomUnits: [{ id: "hfoo", chance: 100 }], randomGroup: 1 };
  applyRandom(e, { what: "unit", by: "level", level: 3 });
  assert.deepEqual(e, { id: "uDNR", randomType: 0, randomLevel: "030000", randomClass: 0 });
  applyRandom(e, { what: "item", by: "level", level: -1, itemClass: 2 });
  assert.deepEqual(e, { id: "uDNR", randomType: 0, randomLevel: "ffffff", randomClass: 2 });
  applyRandom(e, { what: "building", by: "level", level: 5 });
  assert.equal(e.randomLevel, "ffffff");
  applyRandom(e, { what: "item", by: "group", group: 4, position: 1 });
  assert.deepEqual(e, { id: "uDNR", randomType: 1, randomGroup: 4, randomPosition: 1 });
});

const groups = [
  { number: 2, name: "Creeps", positions: [0, 1, 2], lines: [{ chance: 60, ids: ["nfoh", "ntav", "ratc"] }, { chance: 40, ids: ["nmoo", "0x00000000", "ckng"] }] },
  { number: 5, name: "Empty", positions: [0], lines: [] },
];

test("a random object's own table (randomType 2), and its choice read back from any layout", () => {
  const e: Record<string, unknown> = { id: "uDNR", randomType: 0, randomLevel: "030000", randomClass: 0 };
  assert.deepEqual(randomOf(e), { by: "level", level: 3, itemClass: 0 });
  applyRandom(e, { what: "unit", by: "table", units: [{ id: "nfsp", chance: 60 }, { id: "nfsh", chance: 40 }] });
  assert.deepEqual(e, { id: "uDNR", randomType: 2, randomUnits: [{ id: "nfsp", chance: 60 }, { id: "nfsh", chance: 40 }] });
  assert.deepEqual(randomOf(e), { by: "table", units: [{ id: "nfsp", chance: 60 }, { id: "nfsh", chance: 40 }] });
  assert.deepEqual(randomOf({ randomType: 1, randomGroup: 2, randomPosition: 1 }), { by: "group", group: 2, position: 1 });
  assert.equal(randomOf({ randomType: 7 }), null);
  // Levels: little-endian, ffffff any; what isn't three bytes of hex is any too (a hand-edited file).
  assert.deepEqual(["010000", "ffffff", "140000", "0001", "zz0000", 5].map(levelOf), [1, -1, 20, -1, -1, -1]);
  assert.equal(levelOf(levelBytes(17)), 17);
  assert.deepEqual(["uDNR", "bDNR", "iDNR", "hfoo"].map(randomWhatOf), ["unit", "building", "item", undefined]);
  assert.equal(randomName({ what: "unit", by: "table", units: [{ id: "nfsp", chance: 100 }] }), "Random Unit (own table of 1)");
});

test("names say what is placed", () => {
  assert.equal(randomName({ what: "unit", by: "level", level: 2 }), "Random Level 2 Neutral Hostile Unit");
  assert.equal(randomName({ what: "unit", by: "level", level: -1 }), "Random Any Neutral Hostile Unit");
  assert.equal(randomName({ what: "building", by: "level", level: -1 }), "Random Neutral Passive Building");
  assert.equal(randomName({ what: "item", by: "level", level: 3, itemClass: 1 }), "Random Level 3 Permanent Item");
  assert.equal(randomName({ what: "item", by: "level", level: 3, itemClass: 0 }), "Random Level 3 Item");
  assert.equal(randomName({ what: "unit", by: "group", group: 2, position: 0 }, groups), "Random Unit (group “Creeps”, position 1)");
  assert.equal(randomName({ what: "unit", by: "group", group: 9, position: 0 }, groups), "Random Unit (group 9, position 1)");
});

test("a group's positions by what they hold", () => {
  assert.deepEqual(positionsFor(groups[0], "unit"), [0]);
  assert.deepEqual(positionsFor(groups[0], "building"), [1]);
  assert.deepEqual(positionsFor(groups[0], "item"), [2]);
  assert.deepEqual(positionsFor({ number: 1, name: "", positions: [0, 0, 2] }, "unit"), [0, 1]);
});

test("Cycle Random Groups shows each line's object, wrapping, and leaves the rest alone", () => {
  const u = { id: "uDNR", randomType: 1, randomGroup: 2, randomPosition: 0 };
  assert.equal(cycledId(u, groups, 0), "nfoh");
  assert.equal(cycledId(u, groups, 1), "nmoo");
  assert.equal(cycledId(u, groups, 2), "nfoh");
  assert.equal(cycledId(u, groups, -1), "nmoo");
  assert.equal(cycledId({ ...u, id: "iDNR", randomPosition: 2 }, groups, 1), "ckng");
  // An empty slot, an unknown or empty group, other kinds of random objects and plain units show as they are.
  assert.equal(cycledId({ ...u, id: "bDNR", randomPosition: 1 }, groups, 1), undefined);
  assert.equal(cycledId({ ...u, randomGroup: 9 }, groups, 0), undefined);
  assert.equal(cycledId({ ...u, randomGroup: 5 }, groups, 0), undefined);
  assert.equal(cycledId({ ...u, randomType: 0 }, groups, 0), undefined);
  assert.equal(cycledId({ id: "hfoo", randomType: 1, randomGroup: 2 }, groups, 0), undefined);
});

test("scatter and stroke facing follow the same rule as single placement (placeAngle)", () => {
  const unit = { ...tree, kind: "w3u" };
  const r = seq(0.25);
  assert.ok(near(placeAngle(tree, true, r), Math.PI / 2), "doodad rotates randomly when on");
  assert.ok(near(placeAngle(unit, true, r), (270 * Math.PI) / 180), "unit keeps 270 even when on");
  assert.ok(near(placeAngle(tree, false, r), (270 * Math.PI) / 180), "doodad keeps 270 when off");
  assert.ok(near(placeAngle({ ...tree, fixedRot: 90 }, true, r), Math.PI / 2), "fixed rotation wins");
});

test("Auto Cycle Random Groups cycles after a random-group placement only, and only when on", () => {
  const group = { what: "unit", by: "group", group: 1, position: 0 } as const;
  const steps: number[] = [];
  assert.equal(autoCycleAfterPlace(group, true, (s) => steps.push(s)), true);
  assert.deepEqual(steps, [1]);
  assert.equal(autoCycleAfterPlace(group, false, (s) => steps.push(s)), false);
  assert.equal(autoCycleAfterPlace({ what: "unit", by: "level", level: -1 }, true, (s) => steps.push(s)), false);
  assert.equal(autoCycleAfterPlace(undefined, true, (s) => steps.push(s)), false);
  assert.deepEqual(steps, [1]);
});
