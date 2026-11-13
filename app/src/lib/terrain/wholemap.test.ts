import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("Adjust Cliff Levels moves every corner and its water word by the levels, as the World Editor does", () => {
  const before = make(), t = make(), undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, 1, undo), 8);
  t.corners.forEach((c, i) => {
    const b = before.corners[i];
    assert.equal(c.layer, b.layer + 1);
    assert.equal(c.rawHeight, b.rawHeight, "the ground over its level stays");
    assert.equal(c.height, b.height + 128);
    // we-drive, map 03 by +1 (2026-11-13): every corner's water word 0x200 up, dry ones too (0x6000 to 0x6200, the
    // lake's 0x2400 to 0x2600, the river's 0x2546 to 0x2746), the water flags as they were.
    assert.equal(c.rawWater, b.rawWater + 0x200, "the stored water level one level up, the edge bit kept");
    assert.equal(c.water, b.water + 128, "the surface 128 up, as the ground");
    assert.equal(c.hasWater, b.hasWater);
    assert.equal(c.ramp, b.ramp);
  });
  assert.deepEqual(t.corners.map((c) => c.rawWater), [0x2200, 0x2746, 0x2600, 0x2600, 0x2200, 0x2200, 0x2600, 0x6200]);
  // What it writes reads back the same.
  const again = parseW3e(writeW3e(t));
  assert.deepEqual(again.corners.map((c) => [c.layer, c.rawWater, c.water]), t.corners.map((c) => [c.layer, c.rawWater, c.water]));
  const step = undo.step(t);
  step.undo();
  assert.deepEqual(t.corners, before.corners, "one step undoes it all");
  // +2 then -1: 0x400 up, then 0x200 down (map 03's saves of the same steps).
  assert.equal(adjustCliffLevels(t, 2, new CornerUndo()), 8);
  assert.equal(t.corners[2].rawWater, 0x2800);
  assert.equal(adjustCliffLevels(t, -1, new CornerUndo()), 8);
  assert.deepEqual(t.corners.map((c) => c.rawWater), [0x2200, 0x2746, 0x2600, 0x2600, 0x2200, 0x2200, 0x2600, 0x6200]);
});

/** One corner as the World Editor's saves had it: level, water word, water flag. */
const corner = (layer: number, rawWater: number, hasWater: boolean): Terrain => {
  const t = make();
  t.width = 1; t.height = 1;
  const c = { ...t.corners[0], layer, rawWater, hasWater, water: ((rawWater & 0x3fff) - 0x2000) / 4 - 89.6 };
  t.corners = [c];
  return t;
};

test("Adjust Cliff Levels moves each corner's water by the levels that corner moved, wrapping dry words as the World Editor does", () => {
  // we-drive 2026-11-13, a made-up map (water words 0x0000-0x3fff, wet and dry, levels 0-12) and map 03; each row is
  // one corner of a save: [level, water word, wet] by `by` gave [level, water word].
  const rows: [number, number, boolean, number, number, number][] = [
    [0, 0x0000, false, +1, 1, 0x0200],
    [6, 0x1000, true, +1, 7, 0x1200],
    [10, 0x2400, false, +1, 11, 0x2600],
    [2, 0x3e80, false, +1, 3, 0x0080], // round the top of the 14 bits
    [5, 0x7fff, false, +1, 6, 0x41ff], // and the edge bit kept
    [4, 0x0000, false, -3, 1, 0x3a00], // round the bottom
    [5, 0x6200, false, -5, 0, 0x5800], // map 03 by -5
    [3, 0x2600, true, -5, 0, 0x2000], // squeezed: 3 levels, so 0x600 only
    [2, 0x2180, true, -3, 0, 0x1d80],
    [0, 0x5800, false, +12, 10, 0x6c00], // map 03 by +12: cut to +10
  ];
  for (const [layer, w, wet, by, wantLayer, wantWord] of rows) {
    const t = corner(layer, w, wet);
    const r = adjustCliffLevels(t, by, new CornerUndo());
    const c = t.corners[0];
    assert.equal(r, 1, `level ${layer} word ${w.toString(16)} by ${by}`);
    assert.equal(c.layer, wantLayer);
    assert.equal(c.rawWater, wantWord, `level ${layer} word ${w.toString(16)} by ${by}: ${c.rawWater.toString(16)}`);
    assert.equal(c.hasWater, wet, "the water flag stays");
    assert.ok(Math.abs(c.water - (((wantWord & 0x3fff) - 0x2000) / 4 - 89.6)) < 1e-9, "the surface follows the word");
  }
});

test("Adjust Cliff Levels refuses a shift that would wrap a corner's water round its 14 bits (the World Editor wraps it)", () => {
  // The editor turned a wet 0x3fff on level 2 by +1 into 0x01ff: the lake from the top of the range to the bottom.
  for (const [w, by] of [[0x3fff, 1], [0x3e80, 1], [0x0180, -1], [0x0000, -1]] as const) {
    const t = corner(4, w, true), before = corner(4, w, true), undo = new CornerUndo();
    const r = adjustCliffLevels(t, by, undo);
    assert.equal(typeof r, "string", `wet ${w.toString(16)} by ${by}`);
    assert.match(r as string, /water at 1 corner /);
    assert.deepEqual(t.corners, before.corners, "nothing changed");
    assert.equal(undo.step(t).corners.length, 0, "and nothing logged");
  }
  // A corner squeezed at level 0 doesn't move, so its water can't wrap.
  assert.equal(adjustCliffLevels(corner(0, 0x0000, true), -1, new CornerUndo()), 0);
});

test("Adjust Cliff Levels stops corners at level 0 and cuts a raise at +10 or the top, as the World Editor does", () => {
  // Levels 2 and 4: down to -2 without squeezing, up to +10, the dialog's most (TOP_LEVEL - 4 is as much).
  assert.deepEqual(cliffShiftRange(make()), { min: -2, max: Math.min(10, TOP_LEVEL - 4) });
  // map 03 by -3 (we-drive, 2026-11-09): level 4 went to 1, the lake's 2 to 0.
  let t = make(), before = make(), undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, -3, undo), 8);
  t.corners.forEach((c, i) => {
    const layer = Math.max(0, before.corners[i].layer - 3);
    assert.equal(c.layer, layer, `corner ${i}`);
    assert.equal(c.rawHeight, before.corners[i].rawHeight);
    assert.equal(c.rawWater, before.corners[i].rawWater + (layer - before.corners[i].layer) * 0x200, `corner ${i}: the water as far as its level moved`);
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

/** Whether +1 changed exactly what the World Editor's +1 changes in the bytes of a w3e: each moved corner's layer
 *  nibble one up and its water word's low 14 bits 0x200 up (round them); `moved` says which corners. */
function checkPlusOne(name: string, original: Uint8Array, up: Uint8Array, t: Terrain, moved: (corner: number) => boolean) {
  const per = t.version === 12 ? 8 : 7, head = original.length - t.trailer.length - t.corners.length * per;
  assert.equal(up.length, original.length, name);
  const word = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
  for (let p = 0; p < original.length; p++) {
    const k = p - head;
    const corner = k >= 0 && p < head + t.corners.length * per ? (k / per) | 0 : -1;
    const at = k - corner * per;
    if (corner < 0 || !moved(corner) || (at !== per - 1 && at !== 2 && at !== 3)) {
      if (up[p] !== original[p]) assert.fail(`${name}: byte ${p} (corner ${corner}) changed (${original[p]} to ${up[p]})`);
    } else if (at === per - 1) {
      if ((up[p] & 0xf0) !== (original[p] & 0xf0) || (up[p] & 0xf) !== (original[p] & 0xf) + 1) assert.fail(`${name}: corner ${corner}'s layer byte ${original[p]} became ${up[p]}`);
    } else if (at === 2) {
      const was = word(original, p), now = word(up, p);
      if (now !== ((was & 0xc000) | ((was + 0x200) & 0x3fff))) assert.fail(`${name}: corner ${corner}'s water word ${was.toString(16)} became ${now.toString(16)}`);
    }
  }
}

/** SHA-256 of the war3map.w3e the World Editor saved after Adjust Cliff Levels +1 on these maps (we-drive 2026-11-13,
 *  target/evidence/cliff-adjust-water and area-level-we in the main checkout; its plain save of each is the map's own
 *  w3e byte for byte). */
const WE_PLUS_ONE: Record<string, string> = {
  "cliff.w3m": "bd1dc3b1fe4d640a131ea15c954172c416bbe64e6a15d7e15d7503a45be505c1",
  "4v4_SnowareBay_w3c_260125_1357_5658.w3x": "d61a82eaaa07026685e6e2fe3de96bae729864af275b83a11783b70247688507",
};

test("Adjust Cliff Levels on real maps: +1 gives the World Editor's file, changes only layers and water words, -1 gives it back", (ctx) => {
  const maps = ["cliff.w3m", "4v4_SnowareBay_w3c_260125_1357_5658.w3x", "6_w3c_251104_0950_TwistedMeadows_v1.9.w3x"];
  let tried = 0;
  for (const name of maps) {
    const original = realW3e(name);
    if (!original) continue;
    tried++;
    const t = parseW3e(original);
    assert.ok(cliffShiftRange(t).max >= 1, `${name} has room to go up`);
    assert.equal(adjustCliffLevels(t, 1, new CornerUndo()), t.corners.length, name);
    const up = writeW3e(t);
    checkPlusOne(name, original, up, t, () => true);
    if (WE_PLUS_ONE[name]) assert.equal(createHash("sha256").update(up).digest("hex"), WE_PLUS_ONE[name], `${name}: the World Editor's file`);
    const back = parseW3e(up);
    assert.equal(adjustCliffLevels(back, -1, new CornerUndo()), back.corners.length);
    assert.deepEqual(writeW3e(back), original, `${name}: -1 after +1 gives the original file`);
  }
  if (!tried) ctx.skip("no real map or release CLI (smoketest_maps, target/release/w3proj)");
});

test("the water words don't limit the shift of dry corners: theirs wrap round, as in the World Editor", () => {
  const t = make();
  t.corners[0].rawWater = 0x3fff - 300;
  assert.equal(cliffShiftRange(t).max, TOP_LEVEL - 4);
  assert.equal(adjustCliffLevels(t, 1, new CornerUndo()), 8);
  assert.equal(t.corners[0].rawWater, 0x3fff - 300 + 0x200 - 0x4000, "a dry word near the top of its 14 bits goes round");
  t.corners[0].rawWater = 400;
  assert.equal(cliffShiftRange(t).min, -3, "nor near the bottom");
  assert.equal(adjustCliffLevels(t, -3, new CornerUndo()), 8);
  assert.equal(t.corners[0].rawWater, 400 - 0x600 + 0x4000);
});

/** The Area panel's Level +1/-1: Adjust Cliff Levels on a block of corners (inclusive corner numbers). */
test("Adjust Cliff Levels on a block moves only its corners' layers and water: ramps and cliff types stay, the edge becomes a cliff", () => {
  // make()'s corners 1 (land, x 1) and 2 (lake, x 2) on the bottom row, and the ramp corner 5 above corner 1.
  const before = make(), t = make(), undo = new CornerUndo();
  const block = { x0: 1, y0: 0, x1: 2, y1: 1 };
  assert.equal(adjustCliffLevels(t, 1, undo, block), 4);
  t.corners.forEach((c, i) => {
    const b = before.corners[i], x = i % 4;
    const inside = x >= 1 && x <= 2;
    assert.equal(c.layer, b.layer + (inside ? 1 : 0), `corner ${i}'s level`);
    assert.equal(c.rawWater, b.rawWater + (inside ? 0x200 : 0), `corner ${i}'s water word`);
    assert.equal(c.water, b.water + (inside ? 128 : 0), `corner ${i}'s water`);
    const rest = (k: Corner) => ({ ...k, layer: 0, height: 0, rawWater: 0, water: 0 });
    assert.deepEqual(rest(c), rest(b), `corner ${i}: nothing but the level and the water changes`);
  });
  assert.equal(t.corners[5].ramp, true, "the ramp the block cuts through stays, as Adjust Cliff Levels keeps ramps");
  const step = undo.step(t);
  assert.equal(step.corners.length, 4, "one step of the block's corners");
  step.undo();
  assert.deepEqual(t.corners, before.corners, "and it undoes exactly");
  // A block past the map's side is cut to it.
  assert.equal(adjustCliffLevels(t, 1, new CornerUndo(), { x0: 3, y0: 1, x1: 9, y1: 9 }), 1);
  assert.equal(t.corners[7].layer, before.corners[7].layer + 1);
});

test("Adjust Cliff Levels on a block keeps it within levels 0 to 14", () => {
  const t = make();
  const land = { x0: 0, y0: 0, x1: 1, y1: 0 }, lake = { x0: 2, y0: 0, x1: 2, y1: 0 };
  assert.deepEqual(cliffShiftRange(t, land), { min: -4, max: Math.min(10, TOP_LEVEL - 4) });
  assert.deepEqual(cliffShiftRange(t, lake), { min: -2, max: 10 });
  for (let n = 0; n < 10; n++) adjustCliffLevels(t, 1, new CornerUndo(), land);
  assert.deepEqual([t.corners[0].layer, t.corners[1].layer], [TOP_LEVEL, TOP_LEVEL]);
  const undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, 1, undo, land), 0, "nothing goes past the top");
  assert.equal(undo.step(t).corners.length, 0, "and nothing is logged");
  assert.equal(adjustCliffLevels(t, -1, new CornerUndo(), lake), 1);
  assert.equal(adjustCliffLevels(t, -1, new CornerUndo(), lake), 1);
  assert.equal(adjustCliffLevels(t, -1, new CornerUndo(), lake), 0, "nor past the bottom");
  assert.equal(t.corners[2].layer, 0);
  assert.equal(t.corners[3].layer, 2, "the corner beside the block stays");
});

test("Level +1 then -1 on a block of a real map gives the file back, and +1 changes only the block's layers and water words", (ctx) => {
  const maps = ["cliff.w3m", "4v4_SnowareBay_w3c_260125_1357_5658.w3x", "6_w3c_251104_0950_TwistedMeadows_v1.9.w3x"];
  let tried = 0;
  for (const name of maps) {
    const original = realW3e(name);
    if (!original) continue;
    tried++;
    const t = parseW3e(original);
    // A block round the map's first ramp corner, its edge through the ramp, so that the old way (ramps cut through
    // taken away, cliff types matched) would show; else the middle of the map.
    const ramp = t.corners.findIndex((c) => c.ramp);
    const cx = ramp >= 0 ? ramp % t.width : t.width >> 1, cy = ramp >= 0 ? Math.floor(ramp / t.width) : t.height >> 1;
    const block = { x0: Math.max(0, cx - 6), y0: Math.max(0, cy - 6), x1: cx, y1: Math.min(t.height - 1, cy + 6) };
    const inside = (i: number) => { const x = i % t.width, y = Math.floor(i / t.width); return x >= block.x0 && x <= block.x1 && y >= block.y0 && y <= block.y1; };
    const count = (block.x1 - block.x0 + 1) * (block.y1 - block.y0 + 1);
    assert.ok(cliffShiftRange(t, block).max >= 1, `${name}: the block has room to go up`);
    const undo = new CornerUndo();
    assert.equal(adjustCliffLevels(t, 1, undo, block), count, name);
    assert.equal(undo.step(t).corners.length, count, `${name}: one step of the block's corners`);
    const up = writeW3e(t);
    checkPlusOne(name, original, up, t, inside);
    const back = parseW3e(up);
    assert.equal(adjustCliffLevels(back, -1, new CornerUndo(), block), count);
    assert.deepEqual(writeW3e(back), original, `${name}: -1 after +1 gives the original file`);
  }
  if (!tried) ctx.skip("no real map or release CLI (smoketest_maps, target/release/w3proj)");
});

test("Reset Height Field Random keeps the ground words inside the 16-bit range near the height limits", () => {
  const near = (raw: number) => {
    const t = make();
    t.corners.forEach((c) => { c.hasWater = false; c.rawHeight = raw; });
    return t;
  };
  const top = near(0x7ff0);
  randomizeHeightField(top, { variation: 20, smoothing: 0, skipWater: false }, new CornerUndo(), () => 0.999);
  assert.ok(top.corners.every((c) => c.rawHeight === 0x7fff), "top: noise of +256 clamps at 0x7fff");
  const bottom = near(-0x7ff0);
  randomizeHeightField(bottom, { variation: 20, smoothing: 3, skipWater: false }, new CornerUndo(), () => 0);
  assert.ok(bottom.corners.every((c) => c.rawHeight === -0x8000), "bottom: noise of -256 clamps at -0x8000, smoothing keeps it");
  // control: the same noise away from the limit is not clamped, so the clamp assertions above can fail
  const mid = near(0x2000);
  randomizeHeightField(mid, { variation: 20, smoothing: 0, skipWater: false }, new CornerUndo(), () => 0.999);
  assert.ok(mid.corners.every((c) => c.rawHeight === 0x2000 + 256));
});
