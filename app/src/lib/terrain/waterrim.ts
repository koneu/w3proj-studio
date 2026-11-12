// What the World Editor's Shallow and Deep brushes do around the corners they turn into water: the ground
// within two corners (a diamond, not a square) of them is made flat at their height, so the cliff that
// forms round the water has a flat top. Seen on Ashenvale (12a_RoC_Orc04Interlude_v0_control.w3m), one click
// on corner 50,24: the 12 other corners within |dx|+|dy| <= 2 all got that corner's stored height (8664); the
// corners themselves keep theirs, and the 8 around the middle one get their cliff type from the ground
// (matchCliffTypes does that). Only brush size 1 (one corner) was seen; for more corners this is taken to
// hold for each: a corner takes the height of the nearest wet one.

import { groundHeight, setGroundHeight, type Terrain } from "./w3e";

/** Levels the dry ground on the same cliff layer within two corners of `wet` (corner indices that are about to
 *  become water) to the height of the nearest of them. `skip` are corners to leave (the brush's own). Call it
 *  before the layers change. `touch` is told of each corner before it changes. The changed corners. */
export function flattenWaterRim(t: Terrain, wet: readonly number[], skip: ReadonlySet<number>, touch: (i: number) => void): number[] {
  const best = new Map<number, { d: number; from: number }>();
  for (const w of wet) {
    const x = w % t.width, y = Math.floor(w / t.width);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.abs(dx) + Math.abs(dy), nx = x + dx, ny = y + dy;
        if (d > 2 || nx < 0 || ny < 0 || nx >= t.width || ny >= t.height) continue;
        const i = ny * t.width + nx;
        if (skip.has(i)) continue;
        const known = best.get(i);
        if (!known || d < known.d) best.set(i, { d, from: w });
      }
    }
  }
  const changed: number[] = [];
  for (const [i, { from }] of best) {
    const c = t.corners[i], s = t.corners[from];
    if (c.layer !== s.layer || c.hasWater || c.rawHeight === s.rawHeight) continue;
    touch(i);
    setGroundHeight(c, groundHeight(s));
    changed.push(i);
  }
  return changed;
}
