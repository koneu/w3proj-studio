import assert from "node:assert/strict";
import { test } from "node:test";
import { doodadNudgeSteps, fixAsOpened, placedNudgeSteps, doodadPose, doodadScale, doodadTurn, RESTING_Z_TOLERANCE, restAsOpened, settleDoodad, snapAsOpened, unitAnglesAsOpened, type DoodadRuleSource, type OpenRuleSource, type RuledEntry } from "./doodadedit";
import type { PathSize } from "./doodadgrid";
import type { Placed } from "./objects";
import type { ScaleRule } from "./doodadrules";

// The barrel (2×2 texture, 1.1 to 1.5), a crate (4×4), a log (12×6, not square), a type without a texture, and one
// whose texture isn't read yet.
const SIZES: Record<string, PathSize | null> = { LTbr: { width: 2, height: 2 }, LTcr: { width: 4, height: 4 }, AOlg: { width: 12, height: 6 }, LPwh: null };
const RULES: Record<string, ScaleRule> = { LTbr: { kind: "w3b", min: 1.1, max: 1.5 }, AOlg: { kind: "w3d", min: 0.8, max: 1.2 } };
const rules = (snap = true, fix = true): DoodadRuleSource => ({ snap, fix, size: (id) => SIZES[id], scaleRule: (id) => RULES[id] ?? null });
const deg = (d: number) => (d * Math.PI) / 180;
const ground = (x: number, y: number) => x / 100 + y / 1000;

test("doodadPose: a dragged barrel jumps from grid point to grid point; off, it stays where it is asked", () => {
  // 20 to the right of 32 stays at 32 (the World Editor: an 8 pixel drag didn't move it), 46 goes to 96.
  assert.deepEqual(doodadPose(rules(), "LTbr", 52, 32, deg(270)), { x: 32, y: 32, angle: deg(270) });
  assert.deepEqual(doodadPose(rules(), "LTbr", 78, 32, deg(270)), { x: 96, y: 32, angle: deg(270) });
  assert.deepEqual(doodadPose(rules(false), "LTbr", 78, 32, deg(270)), { x: 78, y: 32, angle: deg(270) });
  // A crate's grid is 64n; the square keeps its angle.
  assert.deepEqual(doodadPose(rules(), "LTcr", 30, 100, deg(10)), { x: 0, y: 128, angle: deg(10) });
  // The log turns to the nearest quarter; turned so, its 12 cells lie along x (64n) and its 6 along y (64n + 32).
  const log = doodadPose(rules(), "AOlg", 1000, 10, deg(80));
  assert.equal(log.angle, Math.fround(Math.PI / 2));
  assert.deepEqual([log.x, log.y], [1024, 32]);
  // No texture, or not read yet: as asked.
  assert.deepEqual(doodadPose(rules(), "LPwh", 7, 9, 1), { x: 7, y: 9, angle: 1 });
  assert.deepEqual(doodadPose(rules(), "ZZzz", 7, 9, 1), { x: 7, y: 9, angle: 1 });
});

test("doodadScale: within the type's range at once (the World Editor: 1.2 + 10 × 0.05 − 3 × 0.05 is 1.35); off, as asked", () => {
  assert.deepEqual(doodadScale(rules(), "LTbr", [1.7, 1.7, 1.7]), [1.5, 1.5, 1.5]);
  // A destructable's x for all three, a doodad's each axis.
  assert.deepEqual(doodadScale(rules(), "LTbr", [1.3, 2, 0.5]), [1.3, 1.3, 1.3]);
  assert.deepEqual(doodadScale(rules(), "AOlg", [2, 1, 0.1]), [1.2, 1, 0.8]);
  assert.deepEqual(doodadScale(rules(), "AOlg", [0, 1, 1], () => 0.5), [1, 1, 1]);
  assert.deepEqual(doodadScale(rules(true, false), "LTbr", [1.7, 1.7, 1.7]), [1.7, 1.7, 1.7]);
  assert.deepEqual(doodadScale(rules(), "LTcr", [3, 3, 3]), [3, 3, 3]);
});

test("settleDoodad: place and scale each only when asked, the ground under a moved doodad, a height of its own kept", () => {
  const barrel = (): RuledEntry => ({ id: "LTbr", position: [78, 32, 5], angle: deg(270), scale: [1.7, 1.7, 1.7], flags: 2 });
  const a = barrel();
  assert.equal(settleDoodad(a, rules(), ground, { scale: true }), true);
  assert.deepEqual(a.position, [78, 32, 5]);
  assert.deepEqual(a.scale, [1.5, 1.5, 1.5]);
  const b = barrel();
  assert.equal(settleDoodad(b, rules(), ground, { place: true }), true);
  assert.deepEqual(b.position, [96, 32, ground(96, 32)]);
  assert.deepEqual(b.scale, [1.7, 1.7, 1.7]);
  const fixed = { ...barrel(), flags: 6 };
  settleDoodad(fixed, rules(), ground, { place: true, scale: true });
  assert.deepEqual(fixed.position, [96, 32, 5]);
  // Settled once, it stays: a redo puts back what the rules already gave.
  assert.equal(settleDoodad(fixed, rules(), ground, { place: true, scale: true }), false);
  // Both switches off: nothing changes.
  const off = barrel();
  assert.equal(settleDoodad(off, rules(false, false), ground, { place: true, scale: true }), false);
  assert.deepEqual(off, barrel());
});

test("doodadTurn: the log turns a whole quarter per key (the World Editor: 0° to 270° in three), the barrel by the step", () => {
  let angle = 0;
  for (let i = 0; i < 3; i++) angle = doodadPose(rules(), "AOlg", 1056, 0, doodadTurn(rules(), "AOlg", angle, deg(5))).angle;
  assert.equal(Math.round((angle * 180) / Math.PI), 270);
  assert.equal(doodadTurn(rules(), "AOlg", 0, deg(-5)), -Math.PI / 2);
  assert.equal(doodadTurn(rules(), "LTbr", deg(270), deg(5)), deg(270) + deg(5));
  assert.equal(doodadTurn(rules(), "LPwh", 1, deg(5)), 1 + deg(5));
  // A square picture of more than one colour turns a quarter too (the World Editor: a 4x4 ring 270° to 0° in one press,
  // a 2x2 diagonal 270° to 90° in two), a one-colour one by the step (275°).
  const mixed = { ...rules(), size: (id: string) => (id === "ring" ? { width: 4, height: 4, mixed: true } : id === "full" ? { width: 4, height: 4 } : SIZES[id]) };
  assert.equal(doodadTurn(mixed, "ring", deg(270), deg(5)), deg(270) + Math.PI / 2);
  assert.equal(doodadPose(mixed, "ring", -768, 0, doodadTurn(mixed, "ring", deg(270), deg(5))).angle, 0);
  assert.equal(doodadTurn(mixed, "full", deg(270), deg(5)), deg(275));
  // Snapping off: the log turns by the step too.
  assert.equal(doodadTurn(rules(false), "AOlg", 0, deg(5)), deg(5));
});

test("doodadNudgeSteps: a doodad on a grid nudges a grid step (eight nudges of 8), so it doesn't round back", () => {
  assert.equal(doodadNudgeSteps(rules(), "LTbr"), 8);
  assert.equal(doodadNudgeSteps(rules(), "LPwh"), 1);
  assert.equal(doodadNudgeSteps(rules(false), "LTbr"), 1);
  // A nudge of 8 on the barrel's grid would round back to where it was; 64 doesn't.
  assert.equal(doodadPose(rules(), "LTbr", 32 + 8 * doodadNudgeSteps(rules(), "LTbr"), 32, deg(270)).x, 96);
  assert.equal(doodadPose(rules(), "LTbr", 96 - 8, 32, deg(270)).x, 96);
});

test("snapAsOpened and fixAsOpened: a list as stored gets the open's places, scales, flags and life, and a second pass changes nothing", () => {
  // The kinds: the barrel and the crate are destructables, the log and the hay cart doodads.
  const KINDS: Record<string, string> = { LTbr: "w3b", LTcr: "w3b", AOlg: "w3d", LOch: "w3d" };
  const src: OpenRuleSource = {
    sizeOf: (id) => SIZES[id] ?? null, fixedRot: () => null, scaleRule: (id) => RULES[id] ?? null,
    outside: (x) => x < 0, kindOf: (id) => KINDS[id], ground,
  };
  type Entry = Placed & { flags: number; life: number };
  const entry = (id: string, x: number, y: number, flags = 2, life = 255): Entry => ({ id, variation: 0, position: [x, y, 5], angle: deg(270), scale: [1, 1, 1], flags, life });
  // A barrel stored at 40, 40; a crate at -500 (outside); one with a height of its own (flag 4); a hay cart that was
  // a barrel before a replace (a destructable's life of 100).
  const list = [entry("LTbr", 40, 40), entry("LTcr", -500, 100), entry("LTbr", 40, 40, 6), entry("LOch", 32, 0, 2, 100)];
  const moved: Placed[] = [];
  assert.equal(snapAsOpened(list, src, (e) => moved.push(e)), 3);
  assert.deepEqual(list[0].position, [32, 32, ground(32, 32)]);
  assert.deepEqual(list[1].position, [-512, 128, ground(-512, 128)]);
  // Flag 4 keeps its height.
  assert.deepEqual(list[2].position, [32, 32, 5]);
  assert.deepEqual(moved, list.slice(0, 3));
  assert.equal(fixAsOpened(list, src), 4);
  assert.deepEqual(list[0].scale.map(Math.fround), [1.1, 1.1, 1.1].map(Math.fround));
  assert.deepEqual([list[0].flags, list[0].life], [2, 100]);
  assert.deepEqual([list[1].flags, list[1].life], [3, 100]);
  assert.deepEqual([list[3].flags, list[3].life], [2, 255]);
  // What an AI tool writes is what the editor holds after reading it again: the same rules change nothing then.
  const once = structuredClone(list);
  assert.equal(snapAsOpened(list, src), 0);
  assert.equal(fixAsOpened(list, src), 0);
  assert.deepEqual(list, once);
});

// we-compare doodad-water-z-open (tests/we-compare/doodad-water-z.json, 2026-11-16): opened and saved, the World Editor
// works out the height of every doodad and destructable without flag 4 again (all stored at 37.5: lily pads on the
// water, ZPsh and LTlt on the ground, the fixed lily pads kept), with the life and scale rules of fixAsOpened.
test("fixAsOpened: each doodad without a height of its own goes to its resting height, flag 4 keeps its own, and a second pass changes nothing", () => {
  const KINDS: Record<string, string> = { LTlt: "w3b", LPfp: "w3d", ZPsh: "w3d" };
  // A pond at x < 0 (water level -89.6 over the ground -128) where only lily pads float.
  const floor = (x: number) => (x < 0 ? -128 : 0);
  const restingZ = (id: string, x: number) => (id === "LPfp" && x < 0 ? -89.6 : floor(x));
  const src: OpenRuleSource = {
    sizeOf: () => null, fixedRot: () => null, scaleRule: () => null, outside: null, kindOf: (id) => KINDS[id], ground: (x) => floor(x), restingZ,
  };
  type Entry = Placed & { flags: number; life: number };
  const entry = (id: string, x: number, z: number, flags = 2, life = 255): Entry => ({ id, variation: 0, position: [x, 0, z], angle: 0, scale: [1, 1, 1], flags, life });
  const list = [
    entry("LPfp", -100, 37.5), entry("ZPsh", -100, 37.5), entry("LTlt", 100, 37.5, 2, 100), entry("LPfp", -100, 50, 6),
    // Within the tolerance: a map the World Editor saved keeps its bytes.
    entry("ZPsh", 100, 0.004), entry("LPfp", 100, 0),
  ];
  assert.equal(fixAsOpened(list, src), 3);
  assert.deepEqual(list.map((e) => e.position[2]), [-89.6, -128, 0, 50, 0.004, 0]);
  assert.ok(RESTING_Z_TOLERANCE >= 0.004 && RESTING_Z_TOLERANCE < 1);
  const once = structuredClone(list);
  assert.equal(fixAsOpened(list, src), 0);
  assert.deepEqual(list, once);
  // Without the types' data (restingZ absent) heights stay; restAsOpened alone says which it changed.
  const kept = [entry("LPfp", -100, 37.5), entry("ZPsh", -100, 37.5, 6)];
  assert.equal(fixAsOpened(kept, { ...src, restingZ: undefined }), 0);
  assert.deepEqual(kept.map((e) => e.position[2]), [37.5, 37.5]);
  assert.deepEqual(restAsOpened(kept, src), [kept[0]]);
  // A count of entries, not of rules: a life and a height changed on one doodad count once.
  assert.equal(fixAsOpened([entry("ZPsh", 100, 37.5, 2, 100)], src), 1);
  // A place that isn't a number is left alone.
  const odd = [entry("ZPsh", Number.NaN, 37.5)];
  assert.equal(restAsOpened(odd, src).length, 0);
});

test("snapAsOpened: a doodad moved to its grid lands at its resting height (a lily pad on the water), not on the bed", () => {
  const src: OpenRuleSource = {
    sizeOf: (id) => SIZES[id] ?? null, fixedRot: () => null, scaleRule: () => null,
    outside: null, kindOf: () => "w3d", ground: () => -128, restingZ: () => -89.6,
  };
  const pad = () => ({ id: "LTbr", variation: 0, position: [40, 40, 0], angle: deg(270), scale: [1, 1, 1], flags: 2 } as Placed);
  const list = [pad()];
  assert.equal(snapAsOpened(list, src), 1);
  assert.deepEqual(list[0].position, [32, 32, -89.6]);
  assert.equal(snapAsOpened(list, src), 0, "a second pass changes nothing");
  // Without the types' data, as before: on the ground.
  const plain = [pad()];
  snapAsOpened(plain, { ...src, restingZ: undefined });
  assert.deepEqual(plain[0].position, [32, 32, -128]);
});

// we-compare neutral-facing and neutral-facing-neg (tests/we-compare/neutral-facing.json, 2026-11-15): gold mines,
// taverns, goblin merchants, barracks and footmen saved by the World Editor after it opened the map; the same for all.
test("unitAnglesAsOpened: the World Editor's facings of war3mapUnits.doo after an open (measured)", () => {
  // [stored, saved by the editor]
  const cases: [number, number][] = [
    [0, 0], [0.5, 0.5], [1.5707964, 1.5707964], [4.712389, 4.712389], [5.5, 5.5], [2, 0.034906585], [3, 0.05235988],
    [-90, 4.712389], [-2.072515, 4.2106705], [-2, 6.248279], [-1, 2.3561945], [-0.5, 5.7831855], [1, 0.017453292],
    [6.5, 0.21681452], [7, 0.12217305], [360, 6.2831855], [400, 0.69813156],
  ];
  const list = cases.map(([a]): Placed => ({ id: "ngol", variation: 0, position: [0, 0, 0], angle: Math.fround(a), scale: [1, 1, 1] }));
  const changed = unitAnglesAsOpened(list);
  const wrong = cases.map(([a, want], i) => [a, want, list[i].angle]).filter(([, want, got]) => Math.fround(got) !== Math.fround(want));
  assert.deepEqual(wrong, []);
  assert.equal(changed, cases.filter(([a, want]) => Math.fround(a) !== Math.fround(want)).length);
  // A facing already in range keeps the file's own number (the JSON's double), and a second pass changes nothing.
  const kept: Placed[] = [{ id: "hfoo", variation: 0, position: [0, 0, 0], angle: (3 * Math.PI) / 2, scale: [1, 1, 1] }];
  assert.equal(unitAnglesAsOpened(kept), 0);
  assert.equal(kept[0].angle, (3 * Math.PI) / 2);
  assert.equal(unitAnglesAsOpened(list), 0);
  // A broken angle stays as it is.
  const broken: Placed[] = [{ id: "hfoo", variation: 0, position: [0, 0, 0], angle: NaN, scale: [1, 1, 1] }];
  assert.equal(unitAnglesAsOpened(broken), 0);
});

test("placedNudgeSteps: buildings and start locations nudge 64, units 8, doodads by their grid", () => {
  // Verification round 3 (2026-11-13): three presses moved a start location 192 in the World Editor.
  assert.equal(3 * 8 * placedNudgeSteps("sloc", false, null), 192);
  assert.equal(placedNudgeSteps("hbar", true, null), 8);
  assert.equal(placedNudgeSteps("hfoo", false, null), 1);
  assert.equal(placedNudgeSteps("LTbr", false, 8), 8);
  assert.equal(placedNudgeSteps("LPwh", false, 1), 1);
});
