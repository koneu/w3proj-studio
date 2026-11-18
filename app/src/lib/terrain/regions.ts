// Regions (war3map.w3r): the values the Regions tab and the AI tools give one, checked before anything changes. A
// value past what the file's field holds is refused with a message, never clamped, wrapped or overflowed (decision
// 2026-11-15; TESTING.md "Refused values").

import { float32Text, storableFloat32 } from "../formats/float32";

/** A region's rectangle (world units; 32-bit floats in the file). */
export interface RegionBox { left: number; bottom: number; right: number; top: number }
export type RegionEdge = keyof RegionBox;
export const REGION_EDGES: readonly RegionEdge[] = ["left", "bottom", "right", "top"];

/** The largest region number war3map.w3r holds (a u32). */
export const MAX_REGION_INDEX = 0xffffffff;

const LABEL: Record<RegionEdge, string> = { left: "Left", bottom: "Bottom", right: "Right", top: "Top" };

/** The rectangle a region must lie in: the map's, border included (world units). */
export interface RegionArea { left: number; bottom: number; right: number; top: number }

/**
 * Why `box` can't be a region's rectangle, or null: each edge a 32-bit float, left below right and bottom below top,
 * and, when the map's rectangle `within` is known, the box inside it (edges included). The World Editor never makes a
 * region outside the map (we-drive 2026-11-16, branch cam-region-limits, the empty 64x64 map, ±4096): a drag that
 * starts outside makes none; one that runs out stops at the last point inside, east 3968 and 4000, west -3744, south
 * -3872, north 3392; the border outside the playable part is fine (a region at x -3936). It has no typed edges, so
 * Studio refuses what it can't make rather than clamping it.
 */
export function regionBoxProblem(box: Record<RegionEdge, unknown>, within?: RegionArea | null): string | null {
  for (const k of REGION_EDGES) if (!storableFloat32(box[k])) return float32Text(LABEL[k]);
  const b = box as RegionBox;
  if (b.left >= b.right || b.bottom >= b.top) return "left must be below right and bottom below top.";
  if (within && (b.left < within.left || b.right > within.right || b.bottom < within.bottom || b.top > within.top)) {
    return `a region must lie inside the map (x ${within.left} to ${within.right}, y ${within.bottom} to ${within.top}).`;
  }
  return null;
}

/**
 * The shift (dx, dy) a drag moves the regions `boxes` by, held so they stay inside the map's rectangle `within`: the
 * World Editor stops a region dragged past the map's edge with its edge on the map's (we-drive 2026-11-18, branch
 * we-compare-4, flat.w3x: 3296..3552 dragged 850 east, the pointer off the map, ended 3840..4096, twice; the size
 * kept). A region already past the edge (from the file) isn't pushed further out, and can be moved back in.
 */
export function shiftInside(boxes: readonly RegionBox[], dx: number, dy: number, within?: RegionArea | null): [number, number] {
  if (!within || !boxes.length) return [dx, dy];
  // Within [lo, hi], widened to take in 0 (no move) when the boxes are past an edge already.
  const hold = (d: number, lo: number, hi: number) => Math.min(Math.max(d, Math.min(lo, 0)), Math.max(hi, 0));
  const lo = (k: "left" | "bottom") => Math.min(...boxes.map((b) => b[k]));
  const hi = (k: "right" | "top") => Math.max(...boxes.map((b) => b[k]));
  return [hold(dx, within.left - lo("left"), within.right - hi("right")), hold(dy, within.bottom - lo("bottom"), within.top - hi("top"))];
}

/** An edge typed for region `r` (`typed`: the field's text): the change, null when it is the value `r` has, or why it
 *  is refused (nothing changes then). `within`: the map's rectangle (regionBoxProblem). */
export function typedRegionEdge(r: RegionBox, key: RegionEdge, typed: string, within?: RegionArea | null): { change: Partial<RegionBox> } | { refused: string } | null {
  const v = typed.trim() === "" ? NaN : Number(typed);
  if (!storableFloat32(v)) return { refused: float32Text(LABEL[key]) };
  const problem = regionBoxProblem({ left: r.left, bottom: r.bottom, right: r.right, top: r.top, [key]: v }, within);
  if (problem) return { refused: `${LABEL[key]}: ${problem}` };
  return v === r[key] ? null : { change: { [key]: v } };
}

/** The number a new region gets: one past the highest, or why there is none (the highest is the largest the file holds;
 *  it isn't wrapped to 0). */
export function nextRegionIndex(regions: readonly { index: number }[]): number | { refused: string } {
  const next = 1 + Math.max(-1, ...regions.map((r) => r.index));
  return Number.isInteger(next) && next <= MAX_REGION_INDEX ? next : { refused: `region numbers go up to ${MAX_REGION_INDEX}, and a region has the last one.` };
}
