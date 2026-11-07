import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPoint, cameraRect, insideBounds, limitTo, scaledNudge, waterLimitHits } from "./limits";
import { clampShift } from "./moveedit";
import { WATER_LEVEL_MAX, WATER_LEVEL_MIN, waterLevelAt } from "../../lib/terrain/w3e";

const wet = (level: number) => ({ hasWater: true, rawWater: level });
const dry = { hasWater: false, rawWater: 0 };

test("the stored water level is the 14 bits waterLevelAt cuts off at", () => {
  assert.equal(waterLevelAt(1e9), WATER_LEVEL_MAX);
  assert.equal(waterLevelAt(-1e9), WATER_LEVEL_MIN);
  assert.equal(WATER_LEVEL_MAX, 0x3fff);
});

test("water that reaches a limit is a hit, water that was there is not", () => {
  const before = [wet(0x2000), wet(0x2000), dry, wet(WATER_LEVEL_MAX), wet(0x2000), wet(WATER_LEVEL_MAX)];
  const after = [wet(WATER_LEVEL_MAX), wet(WATER_LEVEL_MIN), wet(WATER_LEVEL_MAX), wet(WATER_LEVEL_MAX), wet(0x2100), wet(WATER_LEVEL_MIN)];
  assert.deepEqual(waterLimitHits(before, after), [0, 1, 2, 5]);
});

test("the unknown high bits of the word don't hide a limit, and dry corners aren't water", () => {
  assert.deepEqual(waterLimitHits([wet(0x2000)], [wet(0x4000 | WATER_LEVEL_MAX)]), [0]);
  assert.deepEqual(waterLimitHits([wet(0x2000)], [{ hasWater: false, rawWater: WATER_LEVEL_MAX }]), []);
});

test("camera bounds are the first four numbers of the w3i, if they make a box", () => {
  assert.deepEqual(cameraRect({ cameraBounds: [-100, -50, 300, 200, -100, 200, 300, -50] }), { left: -100, bottom: -50, right: 300, top: 200 });
  for (const bad of [undefined, {}, { cameraBounds: [] }, { cameraBounds: [1, 2, 3] }, { cameraBounds: [5, 0, 1, 10] }, { cameraBounds: [0, 5, 10, 1] }, { cameraBounds: [5, 0, 5, 10] }, { cameraBounds: [0, 5, 10, 5] }, { cameraBounds: [0, 0, NaN, 5] }]) {
    assert.equal(cameraRect(bad as never), null, JSON.stringify(bad));
  }
});

const box = { left: 0, bottom: 0, right: 100, top: 50 };

test("a point is inside up to the edge; without bounds everything is", () => {
  assert.ok(insideBounds(box, 0, 50) && insideBounds(box, 100, 0) && insideBounds(box, 50, 25));
  assert.ok(!insideBounds(box, -0.1, 10) && !insideBounds(box, 10, 50.1) && !insideBounds(box, 101, 10));
  assert.ok(insideBounds(null, 1e9, -1e9));
  assert.deepEqual(clampPoint(box, 150, -20), [100, 0]);
  assert.deepEqual(clampPoint(box, 30, 20), [30, 20]);
  assert.deepEqual(clampPoint(null, 150, -20), [150, -20]);
});

const map = { left: -50, bottom: -50, right: 200, top: 100 };

test("the bounds an object keeps to are the map's cut by the camera bounds, if those are enforced", () => {
  assert.deepEqual(limitTo(map, null), map);
  assert.deepEqual(limitTo(map, box), { left: 0, bottom: 0, right: 100, top: 50 });
  assert.deepEqual(limitTo(map, { left: -500, bottom: -500, right: 500, top: 500 }), map, "camera bounds past the map change nothing");
  assert.deepEqual(limitTo({ left: 10, bottom: 10, right: 60, top: 40 }, box), { left: 10, bottom: 10, right: 60, top: 40 }, "a playable part inside them stays");
});

test("one clampShift holds a group to both: the camera bounds when enforced, the map when not", () => {
  const group: [number, number][] = [[10, 10], [60, 30]];
  const bounds = (camera: typeof box | null) => group.map(() => limitTo(map, camera));
  assert.deepEqual(clampShift(group, bounds(box), 80, 0), [40, 0], "60 + 40 reaches the camera bound");
  assert.deepEqual(clampShift(group, bounds(null), 80, 0), [80, 0], "without them the map's edge is 200");
  assert.deepEqual(clampShift(group, bounds(null), 500, 0), [140, 0], "and then the map stops it");
  assert.deepEqual(clampShift(group, bounds(box), -80, -80), [-10, -10]);
  // A unit already past the camera bounds but inside the map doesn't hold the others back.
  const out: [number, number][] = [[150, 10], [20, 10]];
  assert.deepEqual(clampShift(out, out.map(() => limitTo(map, box)), -30, 0), [-20, 0], "the one inside stops at the left bound");
});

test("water at the lowest stored level is a hit, one step above it is not", () => {
  // Level 0 is the surface at -2137.6; the ground can go lower than that.
  const at = (z: number) => ({ hasWater: true, rawWater: waterLevelAt(z) });
  assert.equal(waterLevelAt(-2137.6), WATER_LEVEL_MIN);
  assert.deepEqual(waterLimitHits([at(-100)], [at(-2137.6)]), [0]);
  assert.deepEqual(waterLimitHits([at(-100)], [at(-5000)]), [0], "ground far below the limit is cut off at it");
  assert.deepEqual(waterLimitHits([at(-100)], [at(-2137)]), [], "a quarter unit above is stored as it is");
  assert.deepEqual(waterLimitHits([at(-5000)], [at(-5000)]), [], "water that was at the limit already isn't a new hit");
});

test("a nudge is held to the bounds with its steps: a building, which goes twice as far, stops at the edge too", () => {
  const bounds = { left: 0, bottom: 0, right: 100, top: 100 };
  // Both 40 from the right edge, nudged 32: a plain object ends 8 short of it, a building would be 24 past it.
  const moves = scaledNudge([[60, 50], [60, 50]], [bounds, bounds], [1, 2], [32, 0]);
  assert.ok(60 + moves[1][0] <= 100 && 60 + moves[0][0] <= 100, "neither passes the edge");
  assert.equal(60 + moves[1][0], 100, "the building goes as far as the edge allows");
  assert.equal(moves[0][0] * 2, moves[1][0], "and each keeps its share of the step");
  // Not held back: the full steps.
  assert.deepEqual(scaledNudge([[10, 50], [10, 50]], [bounds, bounds], [1, 2], [32, 0]), [[32, 0], [64, 0]]);
  assert.deepEqual(scaledNudge([[10, 50]], [bounds], [2], [0, -32]), [[0, -50]], "down to the bottom edge, 50 away, where 64 were asked");
});
