import assert from "node:assert/strict";
import { test } from "node:test";
import { EYE_CLEARANCE, eyeOf, FREE_PITCH, flyStep, lookAround, panReach, type LookView } from "./freelook";

const flat = () => 0;
const view: LookView = { target: [0, 0, 0], yaw: -Math.PI / 2, pitch: 0.9, distance: 1000 };
const same = (a: readonly number[], b: readonly number[], what: string) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${what} ${i}: ${v} / ${b[i]}`));

test("lookAround turns round the eye, which stays, also to look up from under the old target's side", () => {
  const up = lookAround(view, 0.5, -1.6);
  same(eyeOf({ ...view, ...up }), eyeOf(view), "eye");
  assert.ok(up.pitch < 0, "looks up");
  assert.ok(up.target[2] > eyeOf(view)[2], "the point looked at is above the eye");
});

test("lookAround stops just short of straight up and straight down", () => {
  assert.equal(lookAround(view, 0, -10).pitch, -FREE_PITCH);
  assert.equal(lookAround(view, 0, 10).pitch, FREE_PITCH);
});

test("flyStep moves the eye along where it looks, in shorter steps near the ground, and never under it", () => {
  let v = { ...view };
  const heights: number[] = [eyeOf(v)[2]];
  for (let i = 0; i < 60; i++) { v = { ...v, target: flyStep(v, true, flat) }; heights.push(eyeOf(v)[2]); }
  assert.ok(heights.every((h) => h >= EYE_CLEARANCE - 1e-6), "stays over the ground");
  assert.ok(Math.abs(heights.at(-1)! - EYE_CLEARANCE) < 1e-6, "gets close to the floor");
  assert.ok(heights[0] - heights[1] > heights[6] - heights[7], "shorter steps lower down");
  // Back out again: the eye rises.
  assert.ok(eyeOf({ ...v, target: flyStep(v, false, flat) })[2] > EYE_CLEARANCE);
});

test("flyStep keeps the eye over raised ground it comes to", () => {
  const hill = (_x: number, y: number) => (y > -100 ? 500 : 0);
  let v: LookView = { target: [0, 0, 100], yaw: -Math.PI / 2, pitch: 0, distance: 1000 };
  for (let i = 0; i < 30; i++) v = { ...v, target: flyStep(v, true, hill) };
  const e = eyeOf(v);
  assert.ok(e[2] >= hill(e[0], e[1]) + EYE_CLEARANCE - 1e-6);
});

test("panReach follows the eye's height within its limits", () => {
  assert.equal(panReach({ ...view, distance: 100 }, flat), 200);
  assert.equal(panReach({ ...view, distance: 10000 }, flat), 2000);
});
