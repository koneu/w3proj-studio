import assert from "node:assert/strict";
import { test } from "node:test";
import { CornerUndo } from "./cliffs";
import { adjustCliffLevels, cliffShiftRange, resetHeightField, TOP_LEVEL } from "./wholemap";
import { parseW3e, setGroundHeight, setWaterLevel, writeW3e, type Corner, type Terrain } from "./w3e";

/** A strip like map 03's: land on level 4, a lake on level 2 with a dipped bed and water, a river dip on the land, a
 *  ramp corner, and one corner with the map edge bit in its water word. */
const make = (): Terrain => ({
  version: 12, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Ldrt", "Lgrs"], cliffTiles: ["CLdi", "CLgr"],
  width: 4, height: 2, offsetX: -256, offsetY: -256, trailer: new Uint8Array([1, 2, 3]),
  corners: Array.from({ length: 8 }, (_, i) => {
    const lake = i === 2 || i === 3 || i === 6;
    const c: Corner = {
      height: 0, water: -89.6, texture: i % 2, variation: i, cliffVariation: i % 8, cliffTexture: i % 2,
      layer: lake ? 2 : 4, ramp: i === 5, blight: false, hasWater: lake || i === 1, boundary: false,
      rawHeight: 0x2000, rawWater: i === 7 ? 0x6000 : 0x2000, texExtra: 0,
    };
    setGroundHeight(c, lake ? -110 : i === 1 ? -46 : 0);
    if (lake) setWaterLevel(c, 0x2400);
    if (i === 1) setWaterLevel(c, 0x2546);
    return c;
  }),
});

test("Reset Height Field flattens every corner over its cliff level and leaves the rest", () => {
  const before = make(), t = make(), undo = new CornerUndo();
  const n = resetHeightField(t, undo);
  assert.equal(n, 4, "the lake's three corners and the river's");
  t.corners.forEach((c, i) => {
    assert.equal(c.rawHeight, 0x2000);
    assert.equal(c.height, (c.layer - 2) * 128, "flat over its level");
    const { rawHeight: _r, height: _h, ...rest } = c;
    const { rawHeight: _r2, height: _h2, ...was } = before.corners[i];
    assert.deepEqual(rest, was, `corner ${i}: only the ground height changes`);
  });
  const step = undo.step(t);
  assert.equal(step.corners.length, 4, "only the changed corners are in the step");
  step.undo();
  assert.deepEqual(t.corners, before.corners);
  step.redo();
  assert.equal(t.corners[2].rawHeight, 0x2000);
  assert.equal(resetHeightField(t, new CornerUndo()), 0, "flat already: nothing to do");
});

test("Adjust Cliff Levels moves every corner by the levels and leaves the water where it is, as the World Editor does", () => {
  const before = make(), t = make(), undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, 1, undo), 8);
  t.corners.forEach((c, i) => {
    const b = before.corners[i];
    assert.equal(c.layer, b.layer + 1);
    assert.equal(c.rawHeight, b.rawHeight, "the ground over its level stays");
    assert.equal(c.height, b.height + 128);
    // we-drive, 4v4_SnowareBay by +1 (2026-11-11): every water word and water flag as it was.
    assert.equal(c.rawWater, b.rawWater, "the stored water level stays, high bits and all");
    assert.equal(c.water, b.water, "the surface stays");
    assert.equal(c.hasWater, b.hasWater);
    assert.equal(c.ramp, b.ramp);
  });
  // What it writes reads back the same.
  const again = parseW3e(writeW3e(t));
  assert.deepEqual(again.corners.map((c) => [c.layer, c.rawWater, c.water]), t.corners.map((c) => [c.layer, c.rawWater, c.water]));
  const step = undo.step(t);
  step.undo();
  assert.deepEqual(t.corners, before.corners, "one step undoes it all");
});

test("Adjust Cliff Levels refuses what would take a corner past level 0 or the top, and changes nothing", () => {
  const t = make();
  // Levels 2 and 4: down to -2, up to TOP_LEVEL - 4.
  assert.deepEqual(cliffShiftRange(t), { min: -2, max: TOP_LEVEL - 4 });
  for (const by of [-3, TOP_LEVEL - 3, 100]) {
    const was = structuredClone(t.corners), undo = new CornerUndo();
    const r = adjustCliffLevels(t, by, undo);
    assert.equal(typeof r, "string", `by ${by}`);
    assert.match(String(r), /-2 to \+10/);
    assert.deepEqual(t.corners, was, `by ${by}: nothing changed`);
    assert.equal(undo.step(t).corners.length, 0, "and nothing logged");
  }
  assert.equal(typeof adjustCliffLevels(t, 1.5, new CornerUndo()), "string", "half a level isn't one");
  assert.equal(typeof adjustCliffLevels(t, Number.NaN, new CornerUndo()), "string");
  assert.equal(adjustCliffLevels(t, 0, new CornerUndo()), 0, "nothing to do");
  assert.equal(adjustCliffLevels(t, -2, new CornerUndo()), 8, "to the bottom exactly");
  assert.equal(Math.min(...t.corners.map((c) => c.layer)), 0);
  assert.equal(adjustCliffLevels(t, TOP_LEVEL - 2, new CornerUndo()), 8, "to the top exactly");
  assert.equal(Math.max(...t.corners.map((c) => c.layer)), TOP_LEVEL);
});

test("the water words don't limit the shift, as they don't move", () => {
  const t = make();
  setWaterLevel(t.corners[2], 0x3fff - 300);
  assert.equal(cliffShiftRange(t).max, TOP_LEVEL - 4);
  assert.equal(adjustCliffLevels(t, 1, new CornerUndo()), 8);
  assert.equal(t.corners[2].rawWater & 0x3fff, 0x3fff - 300, "a water word near the top of its 14 bits stays");
  setWaterLevel(t.corners[2], 400);
  assert.equal(cliffShiftRange(t).min, -3, "nor near the bottom");
});
