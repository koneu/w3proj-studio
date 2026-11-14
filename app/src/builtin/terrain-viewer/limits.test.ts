import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPoint, insetBy, pasteSkipText, scaledNudge, strictlyInside, waterLimitHits } from "./limits";
import { unitHalf } from "../../lib/terrain/resize";
import { clampShift, refuseShift } from "./moveedit";
import type { Bounds } from "./moveedit";
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

const box = { left: 0, bottom: 0, right: 100, top: 50 };

test("a point is clamped into the bounds; without bounds it stays", () => {
  assert.deepEqual(clampPoint(box, 150, -20), [100, 0]);
  assert.deepEqual(clampPoint(box, 30, 20), [30, 20]);
  assert.deepEqual(clampPoint(null, 150, -20), [150, -20]);
});

const map = { left: -50, bottom: -50, right: 200, top: 100 };

test("a moved unit keeps what it takes up inside the playable part: the World Editor's nudges and drags", () => {
  // we-drive 2026-11-13, a 64x64 map with the playable part's right edge at 3328: a footman (collision 31) nudged
  // 8 a step stopped at 3296, a farm (4x4 cells, half 64) at 3264; a drag stopped them short of the edge too.
  const playable = { left: -3328, bottom: -3584, right: 3328, top: 3072 };
  const footman = insetBy(playable, unitHalf(null, 31)), farm = insetBy(playable, unitHalf([4, 4], 72));
  assert.equal(footman.right, 3297);
  assert.ok(3296 <= footman.right && 3304 > footman.right, "the footman's last step fits, the next doesn't");
  assert.equal(farm.right, 3264, "the farm's footprint, not its collision size 72");
  assert.deepEqual(insetBy(playable, unitHalf(null, null)), playable, "an item or unknown type: its centre alone");
  assert.deepEqual(clampShift([[3200, 512]], [footman], 500, 0), [97, 0]);
  assert.deepEqual(clampShift([[3136, -1024]], [farm], 500, 0), [128, 0]);
  // Too big for the area: its middle, never bounds turned inside out.
  assert.deepEqual(insetBy({ left: 0, bottom: 0, right: 100, top: 1000 }, [80, 80]), { left: 50, right: 50, bottom: 80, top: 920 });
});

test("a drag motion past the limit is refused: the object stays where the last motion that fitted put it", () => {
  const b = { left: 0, bottom: 0, right: 100, top: 100 };
  assert.deepEqual(refuseShift([[60, 50]], [b], 30, 0), [30, 0]);
  assert.deepEqual(refuseShift([[60, 50]], [b], 70, 0, [30, 0]), [30, 0], "70 would end at 130");
  assert.deepEqual(refuseShift([[60, 50]], [b], 70, 20, [30, 10]), [30, 20], "per axis");
});

test("a group keeps its shape and stops at the map's edge, whatever the camera bounds", () => {
  const group: [number, number][] = [[10, 10], [60, 30]];
  const bounds = group.map(() => insetBy(map, [0, 0]));
  assert.deepEqual(clampShift(group, bounds, 500, 0), [140, 0], "the map's edge at 200 stops the one at 60");
  assert.deepEqual(clampShift(group, bounds, -80, -80), [-60, -60], "the one at 10, 10 stops at -50, -50");
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

test("a nudge is held to the bounds with its steps: a step past the limit is refused, the object stays", () => {
  const bounds = { left: 0, bottom: 0, right: 100, top: 100 };
  // Both 40 from the right edge, nudged 32: a plain object fits (ends 8 short of it), a building would be 24 past it:
  // the group's step is refused, as the World Editor refuses a step past the limit.
  assert.deepEqual(scaledNudge([[60, 50], [60, 50]], [bounds, bounds], [1, 2], [32, 0]), [[0, 0], [0, 0]]);
  assert.deepEqual(scaledNudge([[60, 50]], [bounds], [1], [32, 0]), [[32, 0]], "a step that fits is taken");
  // Not held back: the full steps.
  // The group moves by its longest step, all by the same shift (the editor: a pathless doodad with a tree goes 64).
  assert.deepEqual(scaledNudge([[10, 50], [10, 50]], [bounds, bounds], [1, 2], [32, 0]), [[64, 0], [64, 0]]);
  assert.deepEqual(scaledNudge([[10, 50]], [bounds], [2], [0, -32]), [[0, 0]], "50 above the bottom edge, 64 asked: refused, not cut to 50");
  assert.deepEqual(scaledNudge([[10, 50]], [bounds], [2], [32, -32]), [[0, 0]], "a diagonal with one axis refused is refused whole (KP_9 at the edge)");
  assert.deepEqual(scaledNudge([[10, 10]], [bounds], [2], [32, 32]), [[64, 64]], "a diagonal that fits is taken");
  assert.deepEqual(scaledNudge([[60, 50], [10, 50]], [bounds, bounds], [1, 2], [32, 0]), [[0, 0], [0, 0]], "one member past the edge holds the group");
});

test("nudged to the edge a footman stops at 3296 and a doodad strictly inside the map (we-compare edge-last-step)", () => {
  const playable = { left: -3328, bottom: -3584, right: 3328, top: 3072 };
  const footman = [insetBy(playable, unitHalf(null, 31))];
  const farm = [insetBy(playable, unitHalf([4, 4], 72))];
  const doodad = [strictlyInside({ left: -4096, bottom: -4096, right: 4096, top: 4096 })];
  const run = (x: number, bounds: Bounds[], step: number, nudge: number) => {
    for (let i = 0; i < 100; i++) x += scaledNudge([[x, 0]], bounds, [step], [nudge, 0])[0][0];
    return x;
  };
  assert.equal(run(3200, footman, 1, 8), 3296, "not the limit 3297");
  assert.equal(run(3136, farm, 2, 8), 3264);
  assert.equal(run(3584, doodad, 8, 8), 4032, "a tree on 64-steps: the next one is the edge");
  assert.equal(run(3584, doodad, 1, 8), 4088, "a doodad on 8-steps");
  assert.equal(run(-3584, doodad, 1, -8), -4088);
});

test("a drag's step is judged where a gridded doodad lands, not where the pointer is (edge-group-drag)", () => {
  const strict = strictlyInside({ left: -4096, bottom: -4096, right: 4096, top: 4096 });
  const grid = (_i: number, x: number, y: number): [number, number] => [Math.round(x / 64) * 64, Math.round(y / 64) * 64];
  // The pointer is 4090, inside by itself, but the grid point is the edge 4096: refused, the last shift that fitted stays.
  assert.deepEqual(refuseShift([[3584, 0]], [strict], 506, 0, [440, 0]), [506, 0], "without the grid it fits");
  assert.deepEqual(refuseShift([[3584, 0]], [strict], 506, 0, [440, 0], grid), [440, 0]);
  assert.deepEqual(refuseShift([[3584, 0]], [strict], 440, 0, [0, 0], grid), [440, 0], "4024 snaps to 4032, inside");
  // Per axis, and a pointer that doesn't snap (a pathless doodad) is as before.
  assert.deepEqual(refuseShift([[3584, 0]], [strict], 506, 30, [0, 0], grid), [0, 30]);
  assert.deepEqual(refuseShift([[3584, 0]], [strict], 506, 0, [440, 0], (_i, x, y) => [x, y]), [506, 0]);
  // One member of a group that would land on the edge holds the whole group's axis.
  assert.deepEqual(refuseShift([[3584, 0], [3000, 0]], [strict, strict], 506, 0, [0, 0], (i, x, y) => (i === 0 ? grid(i, x, y) : [x, y])), [0, 0]);
});

test("a paste's word on what it didn't place names each reason that holds, and no other", () => {
  const none = { noFile: 0, offMap: 0, pastPlayable: 0 };
  assert.equal(pasteSkipText(3, none), null);
  const all = pasteSkipText(10, { noFile: 1, offMap: 2, pastPlayable: 3 })!;
  assert.match(all, /^6 of 10 pasted objects weren't placed: 2 would land off the map; 3 are units or items past the playable part/);
  assert.match(all, /; 1 has no placement file in this map\.$/);
  assert.match(pasteSkipText(1, { ...none, pastPlayable: 1 })!, /^1 of 1 pasted object wasn't placed: 1 is a unit or item past the playable part/);
});
