// The AI tools' hold to Enforce Water Height Limits (toollimits.ts), read from settings as
// the tools read them: the switch unset (its World Editor default), on and off.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fitsSnapped } from "./limits";
import { toolWaterRefusal } from "./toollimits";
import { WATER_LEVEL_MAX, WATER_LEVEL_MIN } from "../../lib/terrain/w3e";

/** An app whose settings hold `values`; anything else is its fallback (unset). */
const host = (values: Record<string, unknown> = {}) => ({ settings: { get: <T,>(key: string, fallback?: T) => (key in values ? values[key] : fallback) as T } });

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

test("room is asked at the snapped spot, not the one given", async () => {
  const snap = async (x: number, y: number): Promise<[number, number]> => [Math.round(x / 64) * 64, y];
  const asked: number[] = [];
  const taken = async (x: number) => { asked.push(x); return x !== 128; };
  assert.equal(await fitsSnapped(snap, taken, 120, 0), false, "120 snaps to 128, which is taken");
  assert.deepEqual(asked, [128]);
  assert.equal(await fitsSnapped(snap, taken, 70, 0), true, "70 snaps to 64");
});
