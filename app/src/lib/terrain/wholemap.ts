// Edits of the whole map's ground from the World Editor's Advanced menu: Reset Height Field (flat, or Random) and
// Adjust Cliff Levels.
// Each reports the corners it changes to a log first, so the caller makes one undo step of them.

import type { CornerLog } from "./cliffs";
import type { CornerArea } from "./fragment";
import { setGroundHeight, setLayer, type Terrain } from "./w3e";

/** The stored ground height of flat ground: 0 over its cliff level. */
const FLAT = 0x2000;
/** The highest cliff level Adjust Cliff Levels goes to: the World Editor shifts a map by at most as much as takes its
 *  highest corner to 14 (we-drive, 2026-11-09, map 03 with levels 2 and 4: +9 gave 11 and 13, +10 and +12 both
 *  12 and 14). */
export const TOP_LEVEL = 14;

/** Reset Height Field: every corner's ground back to flat over its cliff level. Cliff levels, ramps, water, textures and
 *  the rest stay, as the World Editor leaves them (we-drive, 2026-11-09, map 03: its lake's bed and river dips went to
 *  0, nothing else in the w3e changed). Returns how many corners changed. */
export function resetHeightField(t: Terrain, log: CornerLog): number {
  let n = 0;
  t.corners.forEach((c, i) => {
    if (c.rawHeight === FLAT) return;
    log.touch(t, i);
    setGroundHeight(c, 0);
    n++;
  });
  return n;
}

/** Reset Height Field's Random option (the World Editor's dialog: Random, Skip water areas, Variation, Smoothing). */
export interface RandomHeights {
  /** 0–RANDOM_MAX_VARIATION: each corner moves by a whole number of RANDOM_STEP, at most half of this either way. */
  variation: number;
  /** 0–RANDOM_MAX_SMOOTHING passes of the smoothing over the whole map. */
  smoothing: number;
  /** Corners with water get no noise (the smoothing still goes over them). */
  skipWater: boolean;
}

/** The dialog's settings when it opens: Variation at its top, Smoothing in its middle, Skip water areas on. */
export const RANDOM_DEFAULTS: Readonly<RandomHeights> = Object.freeze({ variation: 20, smoothing: 4, skipWater: true });
export const RANDOM_MAX_VARIATION = 20;
export const RANDOM_MAX_SMOOTHING = 8;
/** One step of the noise in stored height units: 25.6, i.e. 6.4 of height, 1/20 of a cliff level. */
const RANDOM_STEP = 25.6;
/** One smoothing pass: the corner keeps this much of itself and takes the rest from its neighbours' weighted mean. */
const KEEP = 0.8;
/** The neighbours' weights in a 3x3 window (rows y, columns x): 2 beside, 1 diagonal, the centre none. */
const WINDOW = [[1, 2, 1], [2, 0, 2], [1, 2, 1]];

/** Reset Height Field with Random, as the World Editor does it (we-drive, 2026-11-13, evidence in
 *  target/evidence/height-random of the main checkout). It doesn't flatten: it works on the stored ground words
 *  (rawHeight) as they are, relief included, and leaves cliff levels, ramps, water and everything else.
 *  1. Noise: each corner (with skipWater not those with water) gets floor(k × 25.6) added, k a whole number drawn
 *     evenly from -ceil(v/2) to floor(v/2) for variation v. Measured: v 20 gave the 21 values -256…256 (k -10…10,
 *     about 1/21 each over 4225 corners, no correlation between neighbours), v 0 nothing; the half-way slider -5…4.
 *  2. Smoothing: that many passes over every corner (water ones too) at once, each pass floored to whole words:
 *     new = floor(0.8 × h + 0.2 × Σ w·n / Σ w) over the 3x3 window WINDOW cut to the map. At the map's border the
 *     editor takes the weights from the cut window's own corner, so on the first column and row (index 0) they sit
 *     one off: there the corner itself weighs 2 and its inward neighbour 0. This reproduced every word of 12 saves
 *     exactly (smoothing 1–8 on a map of spikes, a gradient, a cliff block and a lake; three passes over random
 *     heights; spikes on the border).
 *  The editor's draw is unseeded (two sessions' noise correlated 0.02); `random` stands in for it here.
 *  Returns how many corners changed, or why nothing was done. */
export function randomizeHeightField(t: Terrain, opts: RandomHeights, log: CornerLog, random: () => number = Math.random): number | string {
  const { variation: v, smoothing } = opts;
  if (!Number.isInteger(v) || v < 0 || v > RANDOM_MAX_VARIATION) return `The variation is a whole number from 0 to ${RANDOM_MAX_VARIATION}.`;
  if (!Number.isInteger(smoothing) || smoothing < 0 || smoothing > RANDOM_MAX_SMOOTHING) return `The smoothing is a whole number from 0 to ${RANDOM_MAX_SMOOTHING}.`;
  const { width: w, height: hgt, corners } = t;
  if (!corners.length || corners.length !== w * hgt) return 0;
  let h = Float64Array.from(corners, (c) => c.rawHeight);
  if (v > 0) {
    const low = Math.ceil(v / 2);
    corners.forEach((c, i) => {
      if (opts.skipWater && c.hasWater) return;
      const k = Math.min(v, Math.floor(random() * (v + 1))) - low;
      h[i] += Math.floor(k * RANDOM_STEP);
    });
  }
  for (let pass = 0; pass < smoothing; pass++) {
    const next = new Float64Array(h.length);
    for (let y = 0; y < hgt; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(hgt - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        let sum = 0, weight = 0;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const k = WINDOW[yy - y0][xx - x0];
            sum += k * h[yy * w + xx];
            weight += k;
          }
        }
        const i = y * w + x;
        next[i] = Math.floor(weight ? KEEP * h[i] + (1 - KEEP) * sum / weight : h[i]);
      }
    }
    h = next;
  }
  let n = 0;
  corners.forEach((c, i) => {
    const raw = Math.max(-0x8000, Math.min(0x7fff, h[i]));
    if (raw === c.rawHeight) return;
    log.touch(t, i);
    setGroundHeight(c, (raw - FLAT) / 4);
    n++;
  });
  return n;
}

/** The most levels the World Editor's Adjust Cliff Levels dialog takes upwards (we-drive, 2026-11-11). */
export const MAX_RAISE = 10;

/** The corners of a block (inclusive corner numbers, cut to the map), or all of them without one. */
function cornersOf(t: Terrain, area?: CornerArea): number[] {
  if (!area) return t.corners.map((_, i) => i);
  const out: number[] = [];
  const x0 = Math.max(0, area.x0), y0 = Math.max(0, area.y0), x1 = Math.min(t.width - 1, area.x1), y1 = Math.min(t.height - 1, area.y1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * t.width + x);
  return out;
}

/** How far Adjust Cliff Levels shifts this map (or the block `area` of it) without squeezing it: down to level 0 for
 *  its lowest corner, up to MAX_RAISE or TOP_LEVEL for its highest, whichever comes first. Further down still works:
 *  the corners stop at 0. */
export function cliffShiftRange(t: Terrain, area?: CornerArea): { min: number; max: number } {
  let low = Infinity, high = -Infinity;
  const corners = cornersOf(t, area);
  for (const i of corners) {
    low = Math.min(low, t.corners[i].layer);
    high = Math.max(high, t.corners[i].layer);
  }
  if (!corners.length) return { min: 0, max: 0 };
  return { min: 0 - low || 0, max: Math.max(0, Math.min(MAX_RAISE, TOP_LEVEL - high)) };
}

/** One cliff level in the stored water word: 128 world units at four steps each. */
const WATER_PER_LEVEL = 512;
/** The stored water level's 14 bits; the two above them (the map edge bit) aren't part of it. */
const WATER_BITS = 0x3fff;

/** Adjust Cliff Levels: every corner's cliff level `by` up (or down), its water word with it, and nothing else. As the
 *  World Editor does it (we-drive, 2026-11-13, target/evidence/cliff-adjust-water in the main checkout; every corner of
 *  nine saves: map 03 by +1, +2, -1, -5 and +12, cliff.w3m by +1, a made-up map of water words 0x0000-0x3fff, wet and
 *  dry, on levels 0-12, by +1, -3 and +2):
 *  - the layer nibble moves, the ground over its level stays, so the ground rises 128 per level;
 *  - the water word's low 14 bits move 512 (128 of height) per level the corner itself moved, wet or dry corner alike,
 *    so the water keeps its depth; its top two bits (the map edge bit) stay;
 *  - downwards the corners stop at level 0, so a deep shift squeezes the low ones together, and a corner's water moves
 *    only as far as its own level did (map 03 by -5: level 5 went to 0 with its water 2560 down, level 3 to 0 with 1536);
 *  - upwards the shift goes as far as cliffShiftRange's max (a bigger one is cut to it, as the dialog caps it at +10).
 *  The editor's water word wraps round its 14 bits (0x3e80 +1 gave 0x0080, 0x0000 -3 gave 0x3a00), even with Enforce
 *  Water Height Limits on. That would throw a lake from the top of the range to the bottom, so a shift that wraps a
 *  corner with water is refused here, with nothing changed; a dry corner's word wraps as in the editor.
 *  (Runs on 2026-11-11 reported the water words kept on map 03 and 4v4_SnowareBay; the saves of 2026-11-13 of both,
 *  and map 03's of 2026-11-09, show them moving. The editor's w3e of cliff.w3m and SnowareBay by +1 is what this
 *  writes, byte for byte.)
 *  `area`: only that block of corners (the Area panel's Level +1/-1). The editor has no such thing: its Adjust Cliff
 *  Levels shifts the whole map with a terrain selection as without one (we-drive 2026-11-13, cliff.w3m: the same file
 *  both ways), so the block follows the same rule, ramps left as they are, and a cliff appears at its edge.
 *  Returns how many corners changed, or why nothing could be done. */
export function adjustCliffLevels(t: Terrain, by: number, log: CornerLog, area?: CornerArea): number | string {
  if (!Number.isInteger(by)) return "The adjustment is a whole number of cliff levels.";
  const corners = cornersOf(t, area);
  if (by === 0 || !corners.length) return 0;
  const shift = Math.min(by, cliffShiftRange(t, area).max);
  const moves: [number, number][] = [];
  let wrapped = 0;
  for (const i of corners) {
    const c = t.corners[i];
    const layer = Math.max(0, c.layer + shift);
    if (layer === c.layer) continue;
    const level = (c.rawWater & WATER_BITS) + (layer - c.layer) * WATER_PER_LEVEL;
    if (c.hasWater && (level < 0 || level > WATER_BITS)) wrapped++;
    moves.push([i, layer]);
  }
  if (wrapped) {
    return `Not done: the water at ${wrapped} corner${wrapped === 1 ? "" : "s"} would go past the highest or lowest water height a map can store (the World Editor would wrap it round to the other end).`;
  }
  for (const [i, layer] of moves) {
    const c = t.corners[i];
    log.touch(t, i);
    const was = c.rawWater & WATER_BITS;
    const level = (was + (layer - c.layer) * WATER_PER_LEVEL) & WATER_BITS;
    c.rawWater = (c.rawWater & ~WATER_BITS & 0xffff) | level;
    c.water += (level - was) / 4;
    setLayer(c, layer);
  }
  return moves.length;
}
