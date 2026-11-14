// The two limits the terrain viewer can hold edits to, with no editor state: how high or low water
// can lie, and where objects may stand (the camera bounds). The viewer passes what it has; the tests
// pass made-up values.

import { WATER_LEVEL_MAX, WATER_LEVEL_MIN } from "../../lib/terrain/w3e";

/** The water word of a corner: the flag and the stored level (low 14 bits). */
export interface WaterWord { hasWater: boolean; rawWater: number }

const levelOf = (c: WaterWord) => c.rawWater & 0x3fff;

/**
 * Enforce Water Height Limits: which corners an edit pushed against the limit of the stored level. The
 * word holds 14 bits, so a surface that would lie higher or lower is cut off at the limit and the water
 * no longer follows the shape that was meant. `before` and `after` are the same corners, in order;
 * a corner counts if it has water at the limit now, and didn't before. Returns their positions.
 */
export function waterLimitHits(before: readonly WaterWord[], after: readonly WaterWord[]): number[] {
  const atLimit = (c: WaterWord) => c.hasWater && (levelOf(c) <= WATER_LEVEL_MIN || levelOf(c) >= WATER_LEVEL_MAX);
  const hits: number[] = [];
  for (let i = 0; i < after.length; i++) if (atLimit(after[i]) && !(before[i] && atLimit(before[i]) && levelOf(before[i]) === levelOf(after[i]))) hits.push(i);
  return hits;
}

/** What Enforce Water Height Limits says when it refuses an edit, in the terrain editor and the AI tools alike. */
export const waterLimitText = (corners: number) =>
  `Not done: the water at ${corners} corner${corners === 1 ? "" : "s"} would go past the game's lowest or highest water height. Turn off Enforce Water Height Limits to have it cut off there.`;

/** Whether something fits where `snap` puts it: room is asked at the snapped spot, the one used. */
export async function fitsSnapped(snap: (x: number, y: number) => Promise<readonly [number, number]>, fits: (x: number, y: number) => Promise<boolean>, x: number, y: number): Promise<boolean> {
  const [sx, sy] = await snap(x, y);
  return fits(sx, sy);
}

import { refuseShift, type Bounds } from "./moveedit";
export type { Bounds };

/** The point, or the nearest one inside the bounds. */
export const clampPoint = (b: Bounds | null, x: number, y: number): [number, number] =>
  b ? [Math.min(b.right, Math.max(b.left, x)), Math.min(b.top, Math.max(b.bottom, y))] : [x, y];

/**
 * A nudge for a group, held to the bounds: a step that would pass one is refused (refuseShift), not cut back.
 * `steps` is how many nudges long each entry's own step is (a building goes twice as far, on its finer grid); the
 * group moves by the longest one, all by the same shift, and what stands on a grid snaps to it afterwards (a pathless
 * doodad with a tree goes 64, not 8: we-compare edge-group-nudge, the editor's probes with the pointer on either).
 * A diagonal step with one axis refused is refused whole: at the east edge KP_9 moves nothing (the free axis doesn't
 * move, we-compare edge-single-diagonal).
 */
export function scaledNudge(points: readonly (readonly [number, number])[], bounds: readonly Bounds[], steps: readonly number[], nudge: readonly [number, number]): [number, number][] {
  const longest = Math.max(1, ...steps);
  const asked: [number, number] = [nudge[0] * longest, nudge[1] * longest];
  let [dx, dy] = refuseShift(points, bounds, asked[0], asked[1]);
  if (asked[0] !== 0 && asked[1] !== 0 && (dx === 0 || dy === 0)) { dx = 0; dy = 0; }
  return steps.map(() => [dx, dy]);
}

/** Where a dragged or nudged object's centre may go so that what it takes up (`half`, across and up: a unit's
 *  collision size or half a building's footprint, resize.ts unitHalf) stays inside `own` (the playable part, for a
 *  unit). The camera bounds don't come in: the World Editor's drags and nudges go past them with Enforce Camera
 *  Bounds on (we-drive 2026-11-13, see TESTING.md). An object too big for `own` gets its middle. One rule for
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
