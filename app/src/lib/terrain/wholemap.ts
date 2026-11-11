// Edits of the whole map's ground from the World Editor's Advanced menu: Reset Height Field and Adjust Cliff Levels.
// Each reports the corners it changes to a log first, so the caller makes one undo step of them.

import type { CornerLog } from "./cliffs";
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

/** The most levels the World Editor's Adjust Cliff Levels dialog takes upwards (we-drive, 2026-11-11). */
export const MAX_RAISE = 10;

/** How far Adjust Cliff Levels shifts this map without squeezing it: down to level 0 for its lowest corner, up to
 *  MAX_RAISE or TOP_LEVEL for its highest, whichever comes first. Further down still works: the corners stop at 0. */
export function cliffShiftRange(t: Terrain): { min: number; max: number } {
  let low = Infinity, high = -Infinity;
  for (const c of t.corners) {
    low = Math.min(low, c.layer);
    high = Math.max(high, c.layer);
  }
  if (!t.corners.length) return { min: 0, max: 0 };
  return { min: 0 - low || 0, max: Math.max(0, Math.min(MAX_RAISE, TOP_LEVEL - high)) };
}

/** Adjust Cliff Levels: every corner's cliff level `by` up (or down), and nothing else. As the World Editor does it
 *  (we-drive, 2026-11-11, map 03 by +1: only the layer nibble of each corner changed, 0xF4 to 0xF5; height words,
 *  water words and flags byte for byte as they were, and -1 afterwards gave the original file back; 4v4_SnowareBay by
 *  +1 the same): the ground over its level stays, so it rises 128 per level, and the water stays where it is.
 *  Downwards the corners stop at level 0, so a deep shift squeezes the low ones together (map 03 by -6: all at 0).
 *  Upwards the shift goes as far as cliffShiftRange's max (a bigger one is cut to it, as the dialog caps it at +10).
 *  Returns how many corners changed, or why nothing could be done. */
export function adjustCliffLevels(t: Terrain, by: number, log: CornerLog): number | string {
  if (!Number.isInteger(by)) return "The adjustment is a whole number of cliff levels.";
  if (by === 0 || !t.corners.length) return 0;
  const shift = Math.min(by, cliffShiftRange(t).max);
  let n = 0;
  t.corners.forEach((c, i) => {
    const layer = Math.max(0, c.layer + shift);
    if (layer === c.layer) return;
    log.touch(t, i);
    setLayer(c, layer);
    n++;
  });
  return n;
}
