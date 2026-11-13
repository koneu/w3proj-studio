import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { CornerUndo } from "./cliffs";
import { adjustCliffLevels, cliffShiftRange, RANDOM_DEFAULTS, randomizeHeightField, resetHeightField, TOP_LEVEL } from "./wholemap";
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

// ---- Reset Height Field's Random (we-drive, 2026-11-13; target/evidence/height-random in the main checkout) ----

/** A file of tests/fixtures/height-random: a 65x65 test map's w3e as made for the World Editor (relief: spikes, a
 *  gradient, a cliff block one level up and a lake; noise: random heights) and as it saved it after Reset Height Field
 *  with Random at variation 0 (r3, r8: smoothing 3 and 8 on relief; n1: smoothing 1 on noise). */
function fixture(name: string): Terrain {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "height-random", name);
    if (existsSync(p)) return parseW3e(new Uint8Array(readFileSync(p)));
    if (dirname(dir) === dir) throw new Error(`tests/fixtures/height-random/${name} not found`);
  }
}

/** A seeded random source (mulberry32): a failure replays from its seed. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

/** The empty 65x65 map the World Editor's runs started from (empty_map_on_newest_world_editor.w3m): flat, level 2. */
const flat65 = (): Terrain => {
  const t = fixture("noise.w3e");
  for (const c of t.corners) setGroundHeight(c, 0);
  return t;
};

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v: number[]) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
/** The correlation of each corner's change with its right-hand neighbour's (lag 1 along x). */
const lag1 = (t: Terrain, d: number[]) => {
  const a: number[] = [], b: number[] = [];
  for (let y = 0; y < t.height; y++) for (let x = 0; x + 1 < t.width; x++) { a.push(d[y * t.width + x]); b.push(d[y * t.width + x + 1]); }
  const ma = mean(a), mb = mean(b);
  let c = 0, va = 0, vb = 0;
  a.forEach((p, i) => { c += (p - ma) * (b[i] - mb); va += (p - ma) ** 2; vb += (b[i] - mb) ** 2; });
  return c / Math.sqrt(va * vb);
};
const changes = (before: Terrain, after: Terrain) => after.corners.map((c, i) => c.rawHeight - before.corners[i].rawHeight);

test("Random's noise: the 21 steps of 25.6 the World Editor gives, evenly, per corner, and none at variation 0", () => {
  // Smoothing 0 on the flat map, variation 20 (the slider's top): every change the World Editor wrote was one of
  // these 21 values, each on about 1/21 of the 4225 corners (s0, b1, v4: 155.5 sd, neighbours uncorrelated).
  const WE_VALUES = [-256, -231, -205, -180, -154, -128, -103, -77, -52, -26, 0, 25, 51, 76, 102, 128, 153, 179, 204, 230, 256];
  const before = flat65(), t = flat65();
  randomizeHeightField(t, { variation: 20, smoothing: 0, skipWater: true }, new CornerUndo(), seeded(7));
  const d = changes(before, t);
  const counts = new Map<number, number>();
  for (const v of d) counts.set(v, (counts.get(v) ?? 0) + 1);
  assert.deepEqual([...counts.keys()].sort((a, b) => a - b), WE_VALUES);
  for (const [v, n] of counts) assert.ok(Math.abs(n - 4225 / 21) < 60, `${v} on ${n} corners, not about ${Math.round(4225 / 21)}`);
  assert.ok(Math.abs(sd(d) - 155.5) < 155.5 * 0.05, `sd ${sd(d).toFixed(1)}, the World Editor's 155.5`);
  assert.ok(Math.abs(lag1(t, d)) < 0.05, `neighbours correlate ${lag1(t, d).toFixed(3)}, the World Editor's 0.01`);
  // The slider half-way (v2): -5…4, one step more down than up.
  const t9 = flat65();
  randomizeHeightField(t9, { variation: 9, smoothing: 0, skipWater: true }, new CornerUndo(), seeded(8));
  assert.deepEqual([...new Set(changes(before, t9))].sort((a, b) => a - b), [-128, -103, -77, -52, -26, 0, 25, 51, 76, 102]);
  // A quarter (v1): -2…2. At 0 (v0) nothing changes.
  const t4 = flat65();
  randomizeHeightField(t4, { variation: 4, smoothing: 0, skipWater: true }, new CornerUndo(), seeded(9));
  assert.deepEqual([...new Set(changes(before, t4))].sort((a, b) => a - b), [-52, -26, 0, 25, 51]);
  const t0 = flat65(), log = new CornerUndo();
  assert.equal(randomizeHeightField(t0, { variation: 0, smoothing: 0, skipWater: true }, log, seeded(1)), 0);
  assert.equal(log.step(t0).corners.length, 0, "nothing logged");
});

test("Random's smoothing gives the World Editor's spread and neighbour correlation at each of its 9 settings", () => {
  // The flat map, variation 20, one World Editor session per smoothing setting (s0…s8; s4 is b0): the changes' sd
  // and lag-1 correlation along x. A 65x65 sample: allow 8 % on the sd and 0.07 on the correlation.
  const WE = [[155.5, 0.013], [125.2, 0.071], [103.2, 0.206], [86.0, 0.253], [73.1, 0.379], [64.3, 0.484], [57.8, 0.571], [49.8, 0.603], [48.1, 0.685]];
  WE.forEach(([weSd, weLag], smoothing) => {
    const before = flat65(), t = flat65();
    randomizeHeightField(t, { variation: 20, smoothing, skipWater: true }, new CornerUndo(), seeded(100 + smoothing));
    const d = changes(before, t);
    assert.ok(Math.abs(sd(d) - weSd) < weSd * 0.08, `smoothing ${smoothing}: sd ${sd(d).toFixed(1)}, the World Editor's ${weSd}`);
    assert.ok(Math.abs(lag1(t, d) - weLag) < 0.07, `smoothing ${smoothing}: lag 1 ${lag1(t, d).toFixed(3)}, the World Editor's ${weLag}`);
    assert.ok(Math.abs(mean(d)) < 8, `smoothing ${smoothing}: mean ${mean(d).toFixed(1)}`);
  });
});

test("Random's smoothing gives the World Editor's saved words exactly: relief, cliffs, a lake and the border", () => {
  // Variation 0: no draw, so the World Editor's files are the answer word for word.
  for (const [from, to, smoothing] of [["relief.w3e", "r3.w3e", 3], ["relief.w3e", "r8.w3e", 8], ["noise.w3e", "n1.w3e", 1]] as const) {
    const t = fixture(from), we = fixture(to), was = fixture(from);
    const n = randomizeHeightField(t, { variation: 0, smoothing, skipWater: true }, new CornerUndo(), () => assert.fail("no draw at variation 0"));
    const wrong = t.corners.flatMap((c, i) => c.rawHeight === we.corners[i].rawHeight ? [] : [`${i % t.width},${Math.floor(i / t.width)}: ${c.rawHeight} not ${we.corners[i].rawHeight}`]);
    assert.deepEqual(wrong.slice(0, 8), [], `${from} smoothing ${smoothing}: ${wrong.length} corners differ`);
    assert.equal(n, we.corners.filter((c, i) => c.rawHeight !== was.corners[i].rawHeight).length);
    // Everything but the ground words as it was: layers, water, flags (the World Editor's file says the same).
    t.corners.forEach((c, i) => {
      const { rawHeight: _a, height: _b, ...rest } = c;
      const { rawHeight: _c, height: _d, ...before } = was.corners[i];
      assert.deepEqual(rest, before, `${from}: corner ${i}`);
    });
  }
});

test("Random keeps relief, skips water with Skip water areas, and is one undo step", () => {
  // Skip water areas (rw1, rw0): with it no water corner got noise (0 of 285), without it 274 of 285 did.
  const before = fixture("relief.w3e");
  const water = before.corners.flatMap((c, i) => c.hasWater ? [i] : []);
  assert.ok(water.length > 200);
  const skip = fixture("relief.w3e");
  randomizeHeightField(skip, { variation: 20, smoothing: 0, skipWater: true }, new CornerUndo(), seeded(3));
  assert.ok(water.every((i) => skip.corners[i].rawHeight === before.corners[i].rawHeight), "water corners stay with Skip water areas");
  const noSkip = fixture("relief.w3e");
  randomizeHeightField(noSkip, { variation: 20, smoothing: 0, skipWater: false }, new CornerUndo(), seeded(3));
  assert.ok(water.filter((i) => noSkip.corners[i].rawHeight !== before.corners[i].rawHeight).length > water.length * 0.85, "and get noise without it");
  // It adds to the relief rather than flattening: the spike at 10,50 and the gradient are still there after the defaults.
  const t = fixture("relief.w3e"), undo = new CornerUndo();
  const n = randomizeHeightField(t, { ...RANDOM_DEFAULTS }, undo, seeded(4));
  assert.ok(typeof n === "number" && n > 4000, `${n} corners changed`);
  assert.ok(t.corners[50 * 65 + 10].rawHeight - 0x2000 > 200, "the spike stands out still");
  assert.ok(t.corners[56 * 65 + 32].rawHeight - t.corners[8 * 65 + 32].rawHeight > 500, "the gradient rises still");
  assert.equal(t.corners.filter((c, i) => c.layer !== before.corners[i].layer || c.rawWater !== before.corners[i].rawWater || c.hasWater !== before.corners[i].hasWater).length, 0);
  const step = undo.step(t);
  assert.equal(step.corners.length, n);
  step.undo();
  assert.deepEqual(t.corners, before.corners, "one step undoes it");
  // Settings out of range are refused with nothing changed.
  const r = fixture("relief.w3e");
  for (const bad of [{ variation: 21, smoothing: 0 }, { variation: 2.5, smoothing: 0 }, { variation: 1, smoothing: 9 }, { variation: 1, smoothing: -1 }]) {
    assert.equal(typeof randomizeHeightField(r, { ...bad, skipWater: true }, new CornerUndo()), "string");
  }
  assert.deepEqual(r.corners, before.corners);
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

test("Adjust Cliff Levels stops corners at level 0 and cuts a raise at +10 or the top, as the World Editor does", () => {
  // Levels 2 and 4: down to -2 without squeezing, up to +10, the dialog's most (TOP_LEVEL - 4 is as much).
  assert.deepEqual(cliffShiftRange(make()), { min: -2, max: Math.min(10, TOP_LEVEL - 4) });
  // map 03 by -3 (we-drive, 2026-11-09): level 4 went to 1, the lake's 2 to 0.
  let t = make(), before = make(), undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, -3, undo), 8);
  t.corners.forEach((c, i) => {
    assert.equal(c.layer, Math.max(0, before.corners[i].layer - 3), `corner ${i}`);
    assert.equal(c.rawHeight, before.corners[i].rawHeight);
    assert.equal(c.rawWater, before.corners[i].rawWater);
  });
  undo.step(t).undo();
  assert.deepEqual(t.corners, before.corners, "one step undoes the squeeze");
  // Far down: all at 0. Once there, nothing more changes.
  assert.equal(adjustCliffLevels(t, -20, new CornerUndo()), 8);
  assert.ok(t.corners.every((c) => c.layer === 0));
  undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, -1, undo), 0, "nothing left to lower");
  assert.equal(undo.step(t).corners.length, 0, "and nothing logged");
  // Up: +12 is +10, as the dialog caps it (map 03, levels 2 and 4: +10 and +12 both gave 12 and 14).
  t = make();
  assert.equal(adjustCliffLevels(t, 12, new CornerUndo()), 8);
  assert.deepEqual([...new Set(t.corners.map((c) => c.layer))].sort((a, b) => a - b), [12, 14]);
  assert.equal(adjustCliffLevels(t, 1, new CornerUndo()), 0, "the top corner is at the top: nothing moves");
  assert.equal(typeof adjustCliffLevels(t, 1.5, new CornerUndo()), "string", "half a level isn't one");
  assert.equal(typeof adjustCliffLevels(t, Number.NaN, new CornerUndo()), "string");
  assert.equal(adjustCliffLevels(t, 0, new CornerUndo()), 0, "nothing to do");
});

/** The w3e of a real map, through the release CLI; null when the map or the CLI isn't there. */
function realW3e(name: string): Uint8Array | null {
  // The test runs bundled elsewhere (scripts/test.mjs), so the checkout is found from where it was started.
  const git = (arg: string) => { const r = spawnSync("git", ["rev-parse", arg], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
  const repo = git("--show-toplevel"), common = git("--git-common-dir");
  if (!repo) return null;
  const main = common ? dirname(resolve(common)) : repo;
  const exe = `w3proj${process.platform === "win32" ? ".exe" : ""}`;
  const bin = [process.env.W3PROJ_BIN, join(repo, "target", "release", exe), join(main, "target", "release", exe)].find((p) => p && existsSync(p));
  const map = join(process.env.W3PROJ_CORPUS ?? join(main, "smoketest_maps"), name);
  if (!bin || !existsSync(map)) return null;
  const r = spawnSync(bin, ["cat", map, "war3map.w3e"], { maxBuffer: 1 << 26 });
  return r.status === 0 ? new Uint8Array(r.stdout) : null;
}

test("Adjust Cliff Levels on real maps: +1 changes only each corner's layer nibble, -1 then gives the file back", (ctx) => {
  const maps = ["cliff.w3m", "4v4_SnowareBay_w3c_260125_1357_5658.w3x", "6_w3c_251104_0950_TwistedMeadows_v1.9.w3x"];
  let tried = 0;
  for (const name of maps) {
    const original = realW3e(name);
    if (!original) continue;
    tried++;
    const t = parseW3e(original);
    const per = t.version === 12 ? 8 : 7, head = original.length - t.trailer.length - t.corners.length * per;
    assert.ok(cliffShiftRange(t).max >= 1, `${name} has room to go up`);
    assert.equal(adjustCliffLevels(t, 1, new CornerUndo()), t.corners.length, name);
    const up = writeW3e(t);
    assert.equal(up.length, original.length, name);
    for (let p = 0; p < original.length; p++) {
      const k = p - head;
      const layerByte = k >= 0 && p < head + t.corners.length * per && k % per === per - 1;
      if (!layerByte) { if (up[p] !== original[p]) assert.fail(`${name}: byte ${p} changed (${original[p]} to ${up[p]})`); continue; }
      if ((up[p] & 0xf0) !== (original[p] & 0xf0) || (up[p] & 0xf) !== (original[p] & 0xf) + 1) assert.fail(`${name}: corner ${k / per | 0}'s byte ${original[p]} became ${up[p]}`);
    }
    const back = parseW3e(up);
    assert.equal(adjustCliffLevels(back, -1, new CornerUndo()), back.corners.length);
    assert.deepEqual(writeW3e(back), original, `${name}: -1 after +1 gives the original file`);
  }
  if (!tried) ctx.skip("no real map or release CLI (smoketest_maps, target/release/w3proj)");
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
