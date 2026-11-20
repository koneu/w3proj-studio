// The two limits the terrain viewer can hold edits to, with no editor state: how high or low water
// can lie, and where objects may stand (the camera bounds). The viewer passes what it has; the tests
// pass made-up values.

import { GROUND_HEIGHT_MAX, GROUND_HEIGHT_MIN, WATER_LEVEL_MAX, WATER_LEVEL_MIN, WATER_OFFSET, waterLevelWanted } from "../../lib/terrain/w3e";

/** The water word of a corner: the flag and the stored level (low 14 bits). */
export interface WaterWord {
  hasWater: boolean; rawWater: number;
  /** The corner's height: where its water was meant to lie (the level is the height as quarter units). Without it,
   *  a stored level at either end counts as at the limit; with it, only a level that went past the end does. */
  height?: number;
}

const levelOf = (c: WaterWord) => c.rawWater & 0x3fff;

/**
 * Enforce Water Height Limits: which corners an edit pushed against the limit of the stored level. The
 * word holds 14 bits, so a surface that would lie higher or lower is cut off at the limit and the water
 * no longer follows the shape that was meant. `before` and `after` are the same corners, in order;
 * a corner counts if it has water at the limit now, and didn't before. Returns their positions.
 */
export function waterLimitHits(before: readonly WaterWord[], after: readonly WaterWord[]): number[] {
  // Ground exactly at -2048 is stored as level 0 and fits: only water that would pass the end is cut off there.
  // The height is the one before the edit when known: a water brush lowers the corner's cliff level, which the water
  // level was not taken from.
  const atLimit = (c: WaterWord, was?: WaterWord) => {
    if (!c.hasWater) return false;
    const lv = levelOf(c), height = was?.height ?? c.height;
    if (height === undefined) return lv <= WATER_LEVEL_MIN || lv >= WATER_LEVEL_MAX;
    const wanted = waterLevelWanted(height - WATER_OFFSET);
    return (lv <= WATER_LEVEL_MIN && wanted < WATER_LEVEL_MIN) || (lv >= WATER_LEVEL_MAX && wanted > WATER_LEVEL_MAX);
  };
  const hits: number[] = [];
  for (let i = 0; i < after.length; i++) if (atLimit(after[i], before[i]) && !(before[i] && atLimit(before[i]) && levelOf(before[i]) === levelOf(after[i]))) hits.push(i);
  return hits;
}

/** What Enforce Water Height Limits says when it refuses an edit, in the terrain editor and the AI tools alike. */
export const waterLimitText = (corners: number) =>
  `Not done: the water at ${corners} corner${corners === 1 ? "" : "s"} would go past the game's lowest or highest water height. Turn off Enforce Water Height Limits to have it cut off there.`;

/** What an AI tool says when it refuses a ground edit that would take corners past the stored ground word (w3e.ts
 *  groundFits): the brushes stop there as the World Editor's do; a tool's asked shape would be cut off, so it isn't made. */
export const groundLimitText = (corners: number) =>
  `Not done: the ground at ${corners} corner${corners === 1 ? "" : "s"} would go past the lowest or highest ground height a map can store (${GROUND_HEIGHT_MIN} to ${GROUND_HEIGHT_MAX}, without the cliff level).`;

/** Whether something fits where `snap` puts it: room is asked at the snapped spot, the one used. */
export async function fitsSnapped(snap: (x: number, y: number) => Promise<readonly [number, number]>, fits: (x: number, y: number) => Promise<boolean>, x: number, y: number): Promise<boolean> {
  const [sx, sy] = await snap(x, y);
  return fits(sx, sy);
}

import type { Bounds } from "./moveedit";
export type { Bounds };

/** The point, or the nearest one inside the bounds. */
export const clampPoint = (b: Bounds | null, x: number, y: number): [number, number] =>
  b ? [Math.min(b.right, Math.max(b.left, x)), Math.min(b.top, Math.max(b.bottom, y))] : [x, y];

/**
 * A nudge for a group, held to the bounds: a step that would land outside a member's bounds is refused, not cut
 * back (`steps`: how many nudges long each entry's own step is; the group moves by the longest one, all by the same
 * shift, and what stands on a grid snaps to it afterwards: a pathless doodad with a tree goes 64, not 8, we-compare
 * edge-group-nudge). Unlike `clampShift` / `refuseShift` (which let an object already outside move along the edge),
 * a nudge requires every destination to lie inside its bounds: observed in the World Editor on
 * `building-turn-hall.w3m` (2026-11-20; town hall at 3136, -1024 with playable right edge 3328 -> bound 3072): KP_8
 * (north, landing at 3136, -960) was refused and stayed at 3136, -1024, while KP_4 (west, landing at 3072, -1024)
 * moved it 64 inside. A diagonal step with either axis outside is refused whole (KP_9 at the east edge moves nothing,
 * we-compare edge-single-diagonal).
 */
export function scaledNudge(points: readonly (readonly [number, number])[], bounds: readonly Bounds[], steps: readonly number[], nudge: readonly [number, number]): [number, number][] {
  const longest = Math.max(1, ...steps);
  const asked: [number, number] = [nudge[0] * longest, nudge[1] * longest];
  const fits = points.every(([x, y], i) => {
    const b = bounds[i], nx = x + asked[0], ny = y + asked[1];
    return nx >= b.left && nx <= b.right && ny >= b.bottom && ny <= b.top;
  });
  return steps.map(() => (fits ? asked : [0, 0]));
}

/** Where a dragged or nudged object's centre may go so that what it takes up (`half`, across and up: a unit's
 *  collision size or half a building's footprint, resize.ts unitHalf) stays inside `own` (the playable part, for a
 *  unit). The camera bounds don't come in: the World Editor's drags and nudges go past them with Enforce Camera
 *  Bounds on (we-drive 2026-11-13, see docs/testing/doodads-and-units.md). An object too big for `own` gets its middle. One rule for
 *  `clampShift` in moveedit.ts, which cuts a group's shift to each entry's bounds. */
export function insetBy(own: Bounds, half: readonly [number, number]): Bounds {
  const [hx, hy] = half.map((h) => (Number.isFinite(h) && h > 0 ? h : 0));
  const across = hx * 2 <= own.right - own.left ? [own.left + hx, own.right - hx] : [(own.left + own.right) / 2, (own.left + own.right) / 2];
  const up = hy * 2 <= own.top - own.bottom ? [own.bottom + hy, own.top - hy] : [(own.bottom + own.top) / 2, (own.bottom + own.top) / 2];
  return { left: across[0], right: across[1], bottom: up[0], top: up[1] };
}

/** Why pasted objects weren't placed, each counted once by the first reason that holds. */
export interface PasteSkips {
  /** The map has no placement file for them. */
  noFile: number;
  offMap: number;
  /** Units and items past the playable part. */
  pastPlayable: number;
}

/** What a paste says about the objects it didn't place, each reason on its own; null when it placed them all. */
export function pasteSkipText(total: number, s: PasteSkips): string | null {
  const skipped = s.noFile + s.offMap + s.pastPlayable;
  if (!skipped) return null;
  const reasons = [
    s.offMap ? `${s.offMap} would land off the map` : "",
    s.pastPlayable ? `${s.pastPlayable} ${s.pastPlayable === 1 ? "is a unit or item" : "are units or items"} past the playable part of the map, where they can't stand` : "",
    s.noFile ? `${s.noFile} ${s.noFile === 1 ? "has" : "have"} no placement file in this map` : "",
  ].filter(Boolean);
  return `${skipped} of ${total} pasted object${total === 1 ? "" : "s"} ${skipped === 1 ? "wasn't" : "weren't"} placed: ${reasons.join("; ")}.`;
}

/** The bounds with their edge left out: the World Editor keeps a doodad's centre strictly inside the map (4088 of 4096
 *  on 8-steps), so a step onto the edge is refused as one past it. */
export function strictlyInside(b: Bounds, eps = 1 / 1024): Bounds {
  return { left: b.left + eps, right: b.right - eps, bottom: b.bottom + eps, top: b.top - eps };
}
