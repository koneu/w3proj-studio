import assert from "node:assert/strict";
import { test } from "node:test";
import { CornerUndo, type CornerLog } from "./cliffs";
import { PLAIN_VARIATION, resetVariations } from "./variation";
import { parseW3e, setGroundHeight, setWaterLevel, writeW3e, type Corner, type Terrain } from "./w3e";

const make = (): Terrain => ({
  version: 12, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Ldrt", "Lgrs"], cliffTiles: ["CLdi", "CLgr"],
  width: 4, height: 2, offsetX: -256, offsetY: -256, trailer: new Uint8Array(0),
  corners: Array.from({ length: 8 }, (_, i) => {
    const c: Corner = {
      height: 0, water: -89.6, texture: i % 2, variation: [0, 5, 17, 16, 31, 9, 1, 16][i], cliffVariation: i % 8, cliffTexture: i % 2,
      layer: 2 + (i % 3), ramp: i % 2 === 0, blight: i === 1, hasWater: i === 3, boundary: i === 2,
      rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
    };
    setGroundHeight(c, i * 10 - 20);
    if (c.hasWater) setWaterLevel(c, 0x2100);
    return c;
  }),
});

type Reset = (t: Terrain, log: CornerLog) => number;

/** Everything the reset promises, run against whichever reset is given. */
function check(reset: Reset) {
  const before = make(), t = make(), log = new CornerUndo();
  const n = reset(t, log);
  const step = log.step(t);
  const after = structuredClone(t.corners);
  const rest = (c: Corner) => { const { variation: _v, ...others } = c; return others; };
  assert.deepEqual(t.corners.map((c) => c.variation), Array(8).fill(PLAIN_VARIATION), "every ground variation is plain");
  assert.deepEqual(t.corners.map(rest), before.corners.map(rest), "nothing but the ground variation changes");
  assert.equal(n, 6, "the corners already plain are not counted");
  assert.equal(step.corners.length, 6);
  step.undo();
  assert.deepEqual(t.corners, before.corners, "undo restores the old corners");
  step.redo();
  assert.deepEqual(t.corners, after, "redo restores the new corners");
  // The packed byte holds both variations: the file keeps the cliff one.
  const back = parseW3e(writeW3e(t));
  assert.deepEqual(back.corners.map((c) => [c.variation, c.cliffVariation]), t.corners.map((c) => [c.variation, c.cliffVariation]));
  assert.deepEqual(back.corners.map(rest), t.corners.map(rest), "every other field survives the file");
}

test("every ground variation becomes the plain one; cliff variation, ramps, heights and flags stay; undo and redo are exact; the file keeps it all", () => {
  check(resetVariations);
});

test("a map that is plain already has nothing to reset", () => {
  const t = make();
  t.corners.forEach((c) => { c.variation = PLAIN_VARIATION; });
  const log = new CornerUndo();
  assert.equal(resetVariations(t, log), 0);
  assert.equal(log.step(t).corners.length, 0);
});

test("controls: the same checks reject a reset that is wrong in any of these ways", () => {
  const wrong: Record<string, Reset> = {
    "also zeroes the cliff variation": (t, log) => { const n = resetVariations(t, log); t.corners.forEach((c) => { c.cliffVariation = 0; }); return n; },
    "sets the variation without telling the log": (t) => { let n = 0; t.corners.forEach((c) => { if (c.variation !== PLAIN_VARIATION) n++; c.variation = PLAIN_VARIATION; }); return n; },
    "ORs the plain bit in": (t, log) => { let n = 0; t.corners.forEach((c, i) => { log.touch(t, i); if (c.variation !== PLAIN_VARIATION) n++; c.variation |= 16; }); return n; },
    "also clears the ramps": (t, log) => { const n = resetVariations(t, log); t.corners.forEach((c, i) => { log.touch(t, i); c.ramp = false; }); return n; },
    "leaves the last corner": (t, log) => resetVariations({ ...t, corners: t.corners.slice(0, -2) }, log),
  };
  check(resetVariations); // the real one passes
  for (const [what, reset] of Object.entries(wrong)) {
    assert.throws(() => check(reset), assert.AssertionError, `a reset that ${what} should fail the checks`);
  }
});
