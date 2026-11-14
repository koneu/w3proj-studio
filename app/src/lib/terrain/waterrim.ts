// What the World Editor's Shallow and Deep brushes do around the corners they turn into water.
//
// The brushes (waterBasin), measured with we-compare (tests/we-compare/water-brush-slope.json, water-brush-more.json,
// 2026-11-13; inputs tests/fixtures/we-specs/slope*.w3x: ground rising 6 world units a corner along x): one click,
// centred on corner C (the nearest), brush size s, so the water corners are those within s - 1 of C:
// - the ground of every corner within s + 1 of C (a disc: sizes 1, 2, 3, 5, 8 changed exactly those, 8 to 234
//   corners), the water corners too and on any cliff level, becomes C's ground height;
// - in the square of half side s + 1 round C, a dry corner next to (one of the 8 round) a water corner goes to C's
//   level if it was lower and stays if higher; the others go to C's level. With a cliff edge two corners from C,
//   higher side: the lower corners came up, lower side: the higher corners far from the water came down;
// - a corner that came up next to the water takes 140 stored units (35 world units) more ground than C (C at 48
//   and at 96 stored, Shallow and Deep).
// What is still not the World Editor's: Deep Water reaching over a one-level edge from below left one water corner
// dry and its higher neighbour up (it seems to refuse a 3-level cliff; not done here), and already wet corners and
// the square brush weren't measured (left alone; the square brush's reach taken as a square).
//
// flattenWaterRim is the AI tools' (set_water over an area of any shape): the ground on the same cliff layer within
// two corners of new water levelled to the nearest water corner's height. Seen for one corner on Ashenvale
// (12a_RoC_Orc04Interlude_v0_control.w3m, corner 50,24: the 12 others within |dx|+|dy| <= 2 got its height), where
// it agrees with waterBasin.

import { groundHeight, setGroundHeight, setLayer, type Terrain } from "./w3e";

/** How much higher than the clicked corner (world units; 140 stored) a corner raised to its level next to the water
 *  is put. */
export const SHORE_LIFT = 35;

/** The World Editor's water brush round one stamp, before the brush's own corners become water: `centre` is the
 *  corner the brush is centred on, `brush` its corners (those about to become water), `size` the brush size,
 *  `square` its shape, `level` the cliff level the stroke started on (the water one or two below it). `touch` is told
 *  of each corner before it changes. The changed corners. */
export function waterBasin(t: Terrain, centre: number, brush: ReadonlySet<number>, size: number, square: boolean, level: number,
  touch: (i: number) => void): number[] {
  const W = t.width, H = t.height, cx = centre % W, cy = Math.floor(centre / W);
  const ground = groundHeight(t.corners[centre]), reach = Math.max(1, Math.round(size)) + 1;
  const byWater = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && brush.has(ny * W + nx)) return true;
    }
    return false;
  };
  const changed: number[] = [];
  for (let y = Math.max(0, cy - reach); y <= Math.min(H - 1, cy + reach); y++) {
    for (let x = Math.max(0, cx - reach); x <= Math.min(W - 1, cx + reach); x++) {
      const i = y * W + x, c = t.corners[i], own = brush.has(i);
      if (c.hasWater && !own) continue;
      const dx = x - cx, dy = y - cy;
      const flat = square || dx * dx + dy * dy <= reach * reach;
      const shore = !own && byWater(x, y);
      const to = own ? c.layer : shore ? Math.max(c.layer, level) : level;
      const h = flat ? (to > c.layer && shore ? ground + SHORE_LIFT : ground) : groundHeight(c);
      if (to === c.layer && h === groundHeight(c)) continue;
      touch(i);
      setLayer(c, to);
      setGroundHeight(c, h);
      changed.push(i);
    }
  }
  return changed;
}

/** The lowest ground the World Editor's water brushes leave under Enforce Water Height Limits, in world units with the
 *  cliff level counted in (Corner.height): a stored height of 0 on level 2. */
export const GROUND_FLOOR = -2048;
/** How far the ring round a lifted corner reaches, per world unit of lift (measured: 3.46411 to 3.46417). */
const LIFT_REACH = 3.46414;

/** What the World Editor's Shallow and Deep brushes do with Enforce Water Height Limits on, after the brush's corners
 *  (`brush`) have gone to the water's cliff level: every one of them lower than GROUND_FLOOR comes up to it, and the
 *  corners round it are lifted on a cosine ring. Measured with we-drive (2026-11-14, branch water-low-header-we: flat
 *  ground at 15 heights from -1795 to -2048 world units, sizes 1, 3 and 5, Deep and Shallow, and three uneven grounds;
 *  tests/we-compare/water-limit-low.json): the brush corners are taken column by column from the west, each column from
 *  the south; a corner D world units under the floor is set on it, and every other corner at a distance d (world
 *  units) under R / 2 from it, R = 3.46414 * D, gets D * cos²(π d / 2R) more ground (a stored height floored, after
 *  each corner), but only when that is at least its own height above the floor (its cliff level counted in). Sizes 1
 *  and 3 came out exactly; size 5's stamps differ in up to 100 corners (some other order of the brush's corners). Not
 *  measured: the square brush, ground that isn't flat beyond a step of a few corners, and the switch off (not done
 *  then). `touch` is told of each corner before it changes. The changed corners. */
export function liftToFloor(t: Terrain, brush: readonly number[], touch: (i: number) => void): number[] {
  const W = t.width, H = t.height;
  const order = [...brush].sort((a, b) => (a % W) - (b % W) || a - b);
  const changed = new Set<number>();
  for (const p of order) {
    const c = t.corners[p];
    const D = GROUND_FLOOR - c.height;
    if (!(D > 0)) continue;
    touch(p);
    setGroundHeight(c, groundHeight(c) + D);
    changed.add(p);
    const R = LIFT_REACH * D, reach = Math.floor(R / 2 / 128);
    const px = p % W, py = Math.floor(p / W);
    for (let y = Math.max(0, py - reach); y <= Math.min(H - 1, py + reach); y++) {
      for (let x = Math.max(0, px - reach); x <= Math.min(W - 1, px + reach); x++) {
        const d = Math.hypot(x - px, y - py) * 128;
        if (d === 0 || d >= R / 2) continue;
        const i = y * W + x, q = t.corners[i];
        const add = D * Math.cos((Math.PI * d) / (2 * R)) ** 2;
        if (add < q.height - GROUND_FLOOR) continue;
        touch(i);
        q.rawHeight = Math.max(-0x8000, Math.min(0x7fff, Math.floor(q.rawHeight + add * 4)));
        setGroundHeight(q, groundHeight(q));
        changed.add(i);
      }
    }
  }
  return [...changed];
}

/** Levels the dry ground on the same cliff layer within two corners of `wet` (corner indices that are about to
 *  become water) to the height of the nearest of them. `skip` are corners to leave (the area's own). Call it
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
