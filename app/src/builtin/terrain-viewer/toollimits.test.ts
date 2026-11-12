// The AI tools' hold to Enforce Camera Bounds and Enforce Water Height Limits (toollimits.ts), read from settings as
// the tools read them: each switch unset (its World Editor default), on and off.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OUTSIDE_BOUNDS, insideBounds, pasteSkipText } from "./limits";
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

test("with Enforce Water Height Limits off, the default, the edit goes through", () => {
  assert.equal(toolWaterRefusal(host(), before, after, [0, 1, 2]), null);
  assert.equal(toolWaterRefusal(host({ "terrain.enforceWaterLimits": false }), before, after, [0, 1, 2]), null);
});
