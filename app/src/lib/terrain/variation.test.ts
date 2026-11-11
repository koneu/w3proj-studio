import assert from "node:assert/strict";
import { test } from "node:test";
import { CornerUndo, type CornerLog } from "./cliffs";
import { resetVariations } from "./variation";
import { parseW3e, randomVariation, setGroundHeight, setWaterLevel, writeW3e, type Corner, type Terrain } from "./w3e";

/** The World Editor's weights as fitted to its files (w3e.ts VARIATION_WEIGHTS; spelled out here so the test pins them). */
const VARIATION_WEIGHTS = [85, 10, 4, 1, 85, 10, 4, 1, 85, 10, 4, 1, 85, 10, 4, 1, 85, 85];

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

const total = VARIATION_WEIGHTS.reduce((a, b) => a + b, 0);
/** A random number that makes randomVariation give `v`: the middle of its share. */
const rollFor = (v: number) => (VARIATION_WEIGHTS.slice(0, v).reduce((a, b) => a + b, 0) + VARIATION_WEIGHTS[v] / 2) / total;
/** A random source that gives these numbers in turn. */
const sequence = (values: number[]) => { let i = 0; return () => values[i++ % values.length]; };
/** A seeded random source (mulberry32), for a spread over many rolls. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

// What the rolls give each corner; corners 0, 1, 3 and 5 hold that already.
const ROLLED = [0, 5, 4, 16, 12, 9, 17, 1];

type Reset = (t: Terrain, log: CornerLog, random: () => number) => number;

/** Everything the reset promises, run against whichever reset is given. */
function check(reset: Reset) {
  const before = make(), t = make(), log = new CornerUndo();
  const n = reset(t, log, sequence(ROLLED.map(rollFor)));
  const step = log.step(t);
  const after = structuredClone(t.corners);
  const rest = (c: Corner) => { const { variation: _v, ...others } = c; return others; };
  assert.deepEqual(t.corners.map((c) => c.variation), ROLLED, "every ground variation is rolled again");
  assert.deepEqual(t.corners.map(rest), before.corners.map(rest), "nothing but the ground variation changes");
  assert.equal(n, 4, "the corners that rolled what they had are not counted");
  assert.equal(step.corners.length, 4);
  step.undo();
  assert.deepEqual(t.corners, before.corners, "undo restores the old corners");
  step.redo();
  assert.deepEqual(t.corners, after, "redo restores the new corners");
  // The packed byte holds both variations: the file keeps the cliff one.
  const back = parseW3e(writeW3e(t));
  assert.deepEqual(back.corners.map((c) => [c.variation, c.cliffVariation]), t.corners.map((c) => [c.variation, c.cliffVariation]));
  assert.deepEqual(back.corners.map(rest), t.corners.map(rest), "every other field survives the file");
}

test("every ground variation is rolled again; cliff variation, ramps, heights and flags stay; undo and redo are exact; the file keeps it all", () => {
  check(resetVariations);
});

test("corners that roll what they hold change nothing", () => {
  const t = make();
  const log = new CornerUndo();
  assert.equal(resetVariations(t, log, sequence(t.corners.map((c) => rollFor(Math.min(c.variation, 17))))), 1, "only the 31 becomes 17");
  assert.equal(log.step(t).corners.length, 1);
});

/** The World Editor's spread as measured (we-drive, 2026-11-11, 9262 corners): share of each variation in percent. */
const MEASURED: Record<number, number> = { 0: 15.2, 1: 1.8, 2: 0.7, 3: 0.2, 4: 15.2, 8: 14.8, 12: 15.3, 16: 14.8, 17: 14.2 };

/** A reset over a big map gives the measured spread, within a point. */
function checkSpread(reset: Reset) {
  const t: Terrain = { ...make(), width: 200, height: 200, corners: Array.from({ length: 40000 }, () => ({ ...make().corners[0] })) };
  reset(t, new CornerUndo(), seeded(7));
  const share = (v: number) => (100 * t.corners.filter((c) => c.variation === v).length) / t.corners.length;
  for (const [v, pct] of Object.entries(MEASURED)) assert.ok(Math.abs(share(Number(v)) - pct) < 1, `variation ${v}: ${share(Number(v)).toFixed(1)} %, the World Editor ${pct} %`);
  assert.equal(t.corners.filter((c) => c.variation > 17).length, 0, "nothing past 17");
}

test("Reset Texture Variations has the World Editor's spread: about 15 % each for 0, 4, 8, 12, 16 and 17, a little for the rest", () => {
  checkSpread(resetVariations);
});

test("randomVariation itself has that spread, for painted and new ground", () => {
  const random = seeded(11), counts = Array(32).fill(0);
  for (let i = 0; i < 40000; i++) counts[randomVariation(random)]++;
  for (const [v, pct] of Object.entries(MEASURED)) assert.ok(Math.abs((100 * counts[Number(v)]) / 40000 - pct) < 1, `variation ${v}`);
  assert.equal(randomVariation(() => 0), 0);
  assert.equal(randomVariation(() => 0.999999), 17);
});

test("controls: the same checks reject a reset that is wrong in any of these ways", () => {
  const plain16: Reset = (t, log) => { let n = 0; t.corners.forEach((c, i) => { if (c.variation === 16) return; log.touch(t, i); c.variation = 16; n++; }); return n; };
  /** The spread Studio had: 60 % 16, 25 % 17, 15 % one of 0–15. */
  const oldSpread: Reset = (t, log, random) => {
    let n = 0;
    t.corners.forEach((c, i) => {
      const r = random(), v = r < 0.6 ? 16 : r < 0.85 ? 17 : Math.floor(random() * 16);
      if (v === c.variation) return;
      log.touch(t, i); c.variation = v; n++;
    });
    return n;
  };
  const wrong: Record<string, Reset> = {
    "also zeroes the cliff variation": (t, log, r) => { const n = resetVariations(t, log, r); t.corners.forEach((c) => { c.cliffVariation = 0; }); return n; },
    "sets the variation without telling the log": (t, _log, r) => resetVariations(t, { touch: () => {} }, r),
    "also clears the ramps": (t, log, r) => { const n = resetVariations(t, log, r); t.corners.forEach((c, i) => { log.touch(t, i); c.ramp = false; }); return n; },
    "leaves the last corner": (t, log, r) => resetVariations({ ...t, corners: t.corners.slice(0, -2) }, log, r),
    "writes the plain 16 everywhere": plain16,
  };
  check(resetVariations); // the real one passes
  for (const [what, reset] of Object.entries(wrong)) {
    assert.throws(() => check(reset), assert.AssertionError, `a reset that ${what} should fail the checks`);
  }
  checkSpread(resetVariations);
  assert.throws(() => checkSpread(plain16), assert.AssertionError, "the plain 16 everywhere isn't the spread");
  assert.throws(() => checkSpread(oldSpread), assert.AssertionError, "Studio's old spread isn't the World Editor's");
});
