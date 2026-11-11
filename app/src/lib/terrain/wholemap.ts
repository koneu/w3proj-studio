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

/** How far Adjust Cliff Levels can shift this map: down to level 0 for its lowest corner, up to TOP_LEVEL for its
 *  highest. */
export function cliffShiftRange(t: Terrain): { min: number; max: number } {
  let low = Infinity, high = -Infinity;
  for (const c of t.corners) {
    low = Math.min(low, c.layer);
    high = Math.max(high, c.layer);
  }
  if (!t.corners.length) return { min: 0, max: 0 };
  return { min: 0 - low || 0, max: Math.max(0, TOP_LEVEL - high) };
}

/** Adjust Cliff Levels: every corner `by` cliff levels up (or down), 128 per level, ramps kept. The water stays where
 *  it is: no corner's stored water level or water flag changes, so the depth follows from the new ground (we-drive,
 *  2026-11-11, 4v4_SnowareBay by +1: all 25921 corners a level and 128 higher, every water word and flag as it was;
 *  an earlier note, 2026-11-09 on map 03, had the water words 512 higher). Refused, with nothing changed, when a corner
 *  would leave the levels the map can have (cliffShiftRange): the World Editor squeezes the corners against level 0
 *  instead (map 03 by -3: level 4 went to 1, the lake's 2 to 0), which loses the shape. Returns how many corners
 *  changed, or why it was refused. */
export function adjustCliffLevels(t: Terrain, by: number, log: CornerLog): number | string {
  if (!Number.isInteger(by)) return "The adjustment is a whole number of cliff levels.";
  if (by === 0 || !t.corners.length) return 0;
  const range = cliffShiftRange(t);
  if (by < range.min || by > range.max) {
    return `Not done: this map's cliff levels can move from ${range.min} to +${range.max} (its corners have to stay between level 0 and ${TOP_LEVEL}).`;
  }
  t.corners.forEach((c, i) => {
    log.touch(t, i);
    setLayer(c, c.layer + by);
  });
  return t.corners.length;
}
