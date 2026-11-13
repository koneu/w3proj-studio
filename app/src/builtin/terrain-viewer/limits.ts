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

/** Where Enforce Camera Bounds keeps an object from going, as a paste and the AI tools say it. */
export const OUTSIDE_BOUNDS = "outside the camera bounds (turn off Enforce Camera Bounds to allow it)";

/**
 * Where a unit ends up once `snap` (a building's grid snap) has moved it, if that is still inside the bounds;
 * null if the snap pushed it out. The bounds are checked on the spot as given before the snap, and a spot
 * near the edge can leave them by a few units when it is snapped.
 */
export async function snappedInside(b: Bounds | null, snap: (x: number, y: number) => Promise<readonly [number, number]>, x: number, y: number): Promise<[number, number] | null> {
  const [sx, sy] = await snap(x, y);
  return insideBounds(b, sx, sy) ? [sx, sy] : null;
}

/** Whether something fits where `snap` puts it: room is asked at the snapped spot, the one used. */
export async function fitsSnapped(snap: (x: number, y: number) => Promise<readonly [number, number]>, fits: (x: number, y: number) => Promise<boolean>, x: number, y: number): Promise<boolean> {
  const [sx, sy] = await snap(x, y);
  return fits(sx, sy);
}

/** The warning for an edit Enforce Camera Bounds refused: `what` is the subject and verb, e.g. "that is". */
export const refusedOutsideText = (what: string) => `Not done: ${what} ${OUTSIDE_BOUNDS}.`;

/** The warning for objects a move held at the camera bounds. */
export const stoppedAtBoundsText = (count: number) => `${count} object${count === 1 ? "" : "s"} stopped at the camera bounds (turn off Enforce Camera Bounds to go past them).`;

import { clampShift, type Bounds } from "./moveedit";
export type { Bounds };

/** The camera bounds of a map's w3i (left, bottom, right, top first), or null if it has none to trust. */
export function cameraRect(info: { cameraBounds?: readonly number[] } | null | undefined): Bounds | null {
  const b = info?.cameraBounds;
  if (!Array.isArray(b) || b.length < 4 || !b.slice(0, 4).every((n) => Number.isFinite(n))) return null;
  const [left, bottom, right, top] = b;
  return left < right && bottom < top ? { left, bottom, right, top } : null;
}

/** Whether a point is inside the bounds (their edge too); everything is, without bounds. */
export const insideBounds = (b: Bounds | null, x: number, y: number) => !b || (x >= b.left && x <= b.right && y >= b.bottom && y <= b.top);

/** The point, or the nearest one inside the bounds. */
export const clampPoint = (b: Bounds | null, x: number, y: number): [number, number] =>
  b ? [Math.min(b.right, Math.max(b.left, x)), Math.min(b.top, Math.max(b.bottom, y))] : [x, y];

/**
 * A nudge for a group, held to the bounds. `steps` is how many nudges long each entry moves (a building goes
 * twice as far, on its finer grid), so the group is cut back by the longest step first and each entry takes its
 * share: nothing ends up past its bound, whatever its step.
 */
export function scaledNudge(points: readonly (readonly [number, number])[], bounds: readonly Bounds[], steps: readonly number[], nudge: readonly [number, number]): [number, number][] {
  const longest = Math.max(1, ...steps);
  const [dx, dy] = clampShift(points, bounds, nudge[0] * longest, nudge[1] * longest);
  return steps.map((s) => [(dx * s) / longest, (dy * s) / longest]);
}

/** The bounds a moved object has to stay in: the map's own (the playable part, for a unit) and, when camera bounds
 *  are enforced (`camera` is not null), the camera bounds as well, so where both reach. One rule for `clampShift`
 *  in moveedit.ts, which cuts a group's shift to each entry's bounds. */
export function limitTo(own: Bounds, camera: Bounds | null): Bounds {
  if (!camera) return own;
  return { left: Math.max(own.left, camera.left), right: Math.min(own.right, camera.right), bottom: Math.max(own.bottom, camera.bottom), top: Math.min(own.top, camera.top) };
}

/** Why pasted objects weren't placed, each counted once by the first reason that holds. */
export interface PasteSkips {
  /** The map has no placement file for them. */
  noFile: number;
  offMap: number;
  /** Units and items past the playable part. */
  pastPlayable: number;
  /** Outside the camera bounds, with Enforce Camera Bounds on. */
  outsideBounds: number;
}

/** What a paste says about the objects it didn't place, each reason on its own; null when it placed them all. */
export function pasteSkipText(total: number, s: PasteSkips): string | null {
  const skipped = s.noFile + s.offMap + s.pastPlayable + s.outsideBounds;
  if (!skipped) return null;
  const reasons = [
    s.offMap ? `${s.offMap} would land off the map` : "",
    s.pastPlayable ? `${s.pastPlayable} ${s.pastPlayable === 1 ? "is a unit or item" : "are units or items"} past the playable part of the map, where they can't stand` : "",
    s.outsideBounds ? `${s.outsideBounds} would land ${OUTSIDE_BOUNDS}` : "",
    s.noFile ? `${s.noFile} ${s.noFile === 1 ? "has" : "have"} no placement file in this map` : "",
  ].filter(Boolean);
  return `${skipped} of ${total} pasted object${total === 1 ? "" : "s"} ${skipped === 1 ? "wasn't" : "weren't"} placed: ${reasons.join("; ")}.`;
}
