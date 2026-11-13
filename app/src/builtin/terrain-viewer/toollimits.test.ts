// The AI tools' hold to Enforce Camera Bounds and Enforce Water Height Limits (toollimits.ts), read from settings as
// the tools read them: each switch unset (its World Editor default), on and off.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OUTSIDE_BOUNDS, insideBounds, snappedInside, fitsSnapped, pasteSkipText, refusedOutsideText, stoppedAtBoundsText } from "./limits";
import { toolBounds, toolWaterRefusal } from "./toollimits";
import { WATER_LEVEL_MAX, WATER_LEVEL_MIN } from "../../lib/terrain/w3e";

/** An app whose settings hold `values`; anything else is its fallback (unset). */
const host = (values: Record<string, unknown> = {}) => ({ settings: { get: <T,>(key: string, fallback?: T) => (key in values ? values[key] : fallback) as T } });
const info = { cameraBounds: [-1000, -800, 1000, 800, -1000, 800, 1000, -800] };

test("camera bounds hold a tool's objects while Enforce Camera Bounds is on, the default", () => {
  const box = { left: -1000, bottom: -800, right: 1000, top: 800 };
  assert.deepEqual(toolBounds(host(), info), box);
  assert.deepEqual(toolBounds(host({ "terrain.enforceCameraBounds": true }), info), box);
  assert.ok(!insideBounds(toolBounds(host(), info), 1200, 0));
  assert.ok(insideBounds(toolBounds(host(), info), 1000, 800), "the edge is inside");
});

test("with Enforce Camera Bounds off, or no bounds to go by, a tool is held to nothing", () => {
  assert.equal(toolBounds(host({ "terrain.enforceCameraBounds": false }), info), null);
  assert.ok(insideBounds(toolBounds(host({ "terrain.enforceCameraBounds": false }), info), 5000, 5000));
  assert.equal(toolBounds(host(), null), null);
  assert.equal(toolBounds(host(), {}), null);
});

test("the refusal says how to allow it, in the paste's words", () => {
  assert.match(OUTSIDE_BOUNDS, /turn off Enforce Camera Bounds to allow it/);
  assert.ok(pasteSkipText(1, { noFile: 0, offMap: 0, pastPlayable: 0, outsideBounds: 1 })!.includes(OUTSIDE_BOUNDS));
});

const wet = (level: number) => ({ hasWater: true, rawWater: level });
const before = { corners: [wet(0x2000), wet(0x2000), wet(0x2000)] };
const after = { corners: [wet(WATER_LEVEL_MIN), wet(0x2100), wet(WATER_LEVEL_MAX)] };

test("with Enforce Water Height Limits on, a ground edit that pushes water to the limit is refused", () => {
  const on = host({ "terrain.enforceWaterLimits": true });
  assert.equal(toolWaterRefusal(on, before, after, [0, 1, 2]), "Not done: the water at 2 corners would go past the game's lowest or highest water height. Turn off Enforce Water Height Limits to have it cut off there.");
  assert.match(toolWaterRefusal(on, before, after, [2])!, /at 1 corner would/);
  // Only the corners the edit touched count, and water within the limits is fine.
  assert.equal(toolWaterRefusal(on, before, after, [1]), null);
  assert.equal(toolWaterRefusal(on, before, before, [0, 1, 2]), null);
});

test("with Enforce Water Height Limits off the edit goes through; unset it is on, as in the World Editor", () => {
  assert.equal(toolWaterRefusal(host({ "terrain.enforceWaterLimits": false }), before, after, [0, 1, 2]), null);
  assert.match(toolWaterRefusal(host(), before, after, [0, 1, 2])!, /at 2 corners would/);
});

test("the editor's camera-bounds warnings are built from OUTSIDE_BOUNDS", () => {
  assert.equal(refusedOutsideText("that is"), `Not done: that is ${OUTSIDE_BOUNDS}.`);
  assert.match(stoppedAtBoundsText(1), /^1 object stopped at the camera bounds/);
  assert.match(stoppedAtBoundsText(3), /^3 objects stopped/);
  assert.match(stoppedAtBoundsText(2), /turn off Enforce Camera Bounds/);
});

test("a building near the bound that its grid snap pushes outside is refused", async () => {
  const box = { left: -1000, bottom: -800, right: 1000, top: 800 };
  const snap = async (x: number, y: number): Promise<[number, number]> => [Math.ceil(x / 64) * 64, y];
  assert.ok(insideBounds(box, 990, 0), "the spot as given is inside");
  assert.equal(await snappedInside(box, snap, 990, 0), null, "snapped to 1024 it is outside");
  assert.deepEqual(await snappedInside(box, snap, 900, 0), [960, 0]);
  assert.deepEqual(await snappedInside(null, snap, 990, 0), [1024, 0], "no bounds, no refusal");
});

test("room is asked at the snapped spot, not the one given", async () => {
  const snap = async (x: number, y: number): Promise<[number, number]> => [Math.round(x / 64) * 64, y];
  const asked: number[] = [];
  const taken = async (x: number) => { asked.push(x); return x !== 128; };
  assert.equal(await fitsSnapped(snap, taken, 120, 0), false, "120 snaps to 128, which is taken");
  assert.deepEqual(asked, [128]);
  assert.equal(await fitsSnapped(snap, taken, 70, 0), true, "70 snaps to 64");
});
