import assert from "node:assert/strict";
import { test } from "node:test";
import { doodadNudgeSteps, placedNudgeSteps, doodadPose, doodadScale, doodadTurn, settleDoodad, type DoodadRuleSource, type RuledEntry } from "./doodadedit";
import type { PathSize } from "./doodadgrid";
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

test("placedNudgeSteps: buildings and start locations nudge 64, units 8, doodads by their grid", () => {
  // Verification round 3 (2026-11-13): three presses moved a start location 192 in the World Editor.
  assert.equal(3 * 8 * placedNudgeSteps("sloc", false, null), 192);
  assert.equal(placedNudgeSteps("hbar", true, null), 8);
  assert.equal(placedNudgeSteps("hfoo", false, null), 1);
  assert.equal(placedNudgeSteps("LTbr", false, 8), 8);
  assert.equal(placedNudgeSteps("LPwh", false, 1), 1);
});
