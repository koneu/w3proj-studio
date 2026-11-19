// A part of the map a tool talks about: a region of the map by name, or a rectangle.

import type { W3Api } from "../../extensions/api";
import { readMapDoc } from "../formats/mapdoc";
import type { Terrain } from "./w3e";

export interface Area { left: number; bottom: number; right: number; top: number; name?: string }
interface AreaArgs { region?: unknown; left?: unknown; bottom?: unknown; right?: unknown; top?: unknown }

export const inArea = (x: number, y: number, a: Area) => x >= a.left && x <= a.right && y >= a.bottom && y <= a.top;

/** The playable part of a map: what's inside its border of unplayable tiles. */
export function playableArea(info: { cameraComplements?: number[] }, t: { offsetX: number; offsetY: number; width: number; height: number }): Area {
  const [left, right, bottom, top] = info.cameraComplements ?? [0, 0, 0, 0];
  return {
    left: t.offsetX + left * 128, right: t.offsetX + (t.width - 1 - right) * 128,
    bottom: t.offsetY + bottom * 128, top: t.offsetY + (t.height - 1 - top) * 128,
  };
}

/** The terrain's grid as the border's rules read it. */
type EdgeGrid = Pick<Terrain, "width" | "height">;

/** Per axis (x, y), whether the border's shade reaches a further half cell into the playable map (its texels on the
 *  pathing cells' middles, dark beside a cell past the edge: the fade over the second half of the first playable cell
 *  and the first half of the next) or not (its texels on the cells' corners: the fade over the first playable cell).
 *  The World Editor's HD shade reaches in on all four sides, its SD shade on the west and east only (we-drive,
 *  2026-11-19, make-water-tilesets.mjs --dry L, game view, `--look` 128 inside each edge across the view at 1200: the
 *  fade's half 37 units inside on every side in HD; in SD 30.6 west, 39.0 east, 13.5 south, 22.4 north; Studio's
 *  corners gave 18 on every side). */
export interface BorderSpread { x: boolean; y: boolean }
export const BORDER_SPREAD: Readonly<Record<"sd" | "hd", BorderSpread>> = Object.freeze({ sd: { x: true, y: false }, hd: { x: true, y: true } });

/** The dark over the map's border: black at BORDER_ALPHA over each tile past the playable map (`edge`: 1 per tile,
 *  rows from the south; w3e.ts playableEdgeTiles, as the World Editor goes by the w3i). One RGBA texel per corner of the
 *  pathing cells (`4 * tiles + 1` along an axis, row 0 in the south), dark where any cell around it is past the
 *  playable map: drawn smoothly between the corners, the dark fades out over the first playable cell (we-drive, map
 *  03's west edge, 2026-11-12: from green 16 to 107 over 13 pixels, a cell's width there). Along an axis `spread`
 *  says (BORDER_SPREAD), one texel per cell's middle instead (`4 * tiles`), dark where the cell or one beside it is past:
 *  the same fade half a cell further in. borderShadeRect says where the texture lies. */
export function borderShade(t: EdgeGrid, edge: ArrayLike<number>, spread: BorderSpread = { x: false, y: false }): { rgba: Uint8Array; width: number; height: number } {
  const tilesX = Math.max(0, t.width - 1), tilesY = Math.max(0, t.height - 1);
  const width = tilesX * 4 + (spread.x ? 0 : 1), height = tilesY * 4 + (spread.y ? 0 : 1), rgba = new Uint8Array(width * height * 4);
  const past = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < tilesX * 4 && cy < tilesY * 4 && edge[(cy >> 2) * tilesX + (cx >> 2)] === 1;
  // The cells a texel looks at along an axis: the two either side of a corner (texel i: cells i - 1 and i), or a
  // middle's own and the two beside it (cells i - 1 to i + 1).
  const xTo = spread.x ? 1 : 0, yTo = spread.y ? 1 : 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let dark = false;
    for (let dy = -1; dy <= yTo && !dark; dy++) for (let dx = -1; dx <= xTo && !dark; dx++) dark = past(x + dx, y + dy);
    if (dark) rgba[(y * width + x) * 4 + 3] = BORDER_ALPHA;
  }
  return { rgba, width, height };
}

/** Where borderShade's texture lies in the world (x, y, width, height), so that its texels sit on the cells' corners
 *  (half a cell past the terrain's rim) or, along an axis `spread` says, on the cells' middles (the terrain itself). */
export function borderShadeRect(t: Pick<Terrain, "width" | "height" | "offsetX" | "offsetY">, spread: BorderSpread = { x: false, y: false }): [number, number, number, number] {
  const half = 16, w = Math.max(0, t.width - 1) * 128, h = Math.max(0, t.height - 1) * 128;
  return [t.offsetX - (spread.x ? 0 : half), t.offsetY - (spread.y ? 0 : half), w + (spread.x ? 0 : 2 * half), h + (spread.y ? 0 : 2 * half)];
}
/** How dark the border is: the World Editor's border ground keeps about 14.5 % of its colour (map 03, green 16 of 110
 *  just inside, we-drive 2026-11-12; Studio's 165 kept 35 %, green 39). */
export const BORDER_ALPHA = 218;

/** What HD keeps of a colour under the border's shade of alpha `a` (0 to 1), as a factor on its linear light: the World
 *  Editor's HD picture takes the shade's 1 - a as an sRGB value to linear light and multiplies by it, dec(1 - a), so
 *  at BORDER_ALPHA 0.0185 where SD keeps 0.145 of the sRGB value (we-drive 2026-11-19, ws-A and ws-L of
 *  make-water-tilesets.mjs --shore, from above: Lordaeron's land 133.2, 92.6, 26.3 kept 14.5, 7.0, 1.0 past the edge,
 *  this gives 13.7, 6.6, 0.6; Ashenvale's 31.1, 34.7, 44.7 kept 1.0, 1.0, 1.8, this 0.8, 1.0, 1.5; SD keeps 0.145 of the
 *  sRGB value on both, Studio's plain blend). The dark ground's sRGB toe makes it darker than the share on dark ground.
 *  renderer.ts BORDER_HD_FS and the models' edge shade (lib/model/renderer.ts) do the same in their shaders. */
export function hdBorderKeep(a: number): number {
  const s = Math.min(1, Math.max(0, 1 - a));
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Per corner (row 0 in the south), 1 where the classic water is black: the tile north-east of it (the one whose lower
 *  left corner it is; on the last row and column the tile beside it) lies past the playable map (`edge`, as
 *  borderShade's). Drawn smoothly between the corners, as the World Editor's SD water: it fades over the last border
 *  tile on the west and south sides and over the last playable tile on the east and north (we-drive, 2026-11-13, a copy
 *  of the empty map with lakes across each edge, from above: half its colour 77 and 69 pixels outside the west and
 *  south edges, 80 and 70 inside the east and north, a tile about 130 pixels). HD water goes by the pixel instead
 *  (renderer.ts HD_WATER_EDGE). */
export function darkWaterCorners(t: EdgeGrid, edge: ArrayLike<number>): Uint8Array {
  const tilesX = Math.max(0, t.width - 1), tilesY = Math.max(0, t.height - 1);
  const out = new Uint8Array(t.width * t.height);
  if (!tilesX || !tilesY) return out;
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    if (edge[Math.min(y, tilesY - 1) * tilesX + Math.min(x, tilesX - 1)]) out[y * t.width + x] = 1;
  }
  return out;
}

/** Says when an area reaches past the playable part; null when it doesn't. */
export function beyondPlayable(area: Area, playable: Area): string | null {
  const sides = [area.left < playable.left && "west", area.right > playable.right && "east", area.bottom < playable.bottom && "south", area.top > playable.top && "north"].filter(Boolean);
  return sides.length ? `This area runs past the playable map to the ${sides.join(" and ")}. Units and items can't stand there, and nobody walks there; trees and doodads can, as the map's backdrop.` : null;
}

/** Whether a placed object may stand here regardless of what the ground says, since the border
 *  counts as blocked in the pathing map: trees and doodads past the playable map, within the whole
 *  map. Ladder maps keep up to a fifth of their doodads out there, and no units. */
export function isBackdrop(kind: string, x: number, y: number, playable: Area | null, whole: Area) {
  return (kind === "w3d" || kind === "w3b") && !!playable && !inArea(x, y, playable) && inArea(x, y, whole);
}

/** A place to keep free: an area, or a line of points with a width. */
export type KeepClear = Area | { points: [number, number][]; width: number };

/** Shortest distance from a point to a line of points. */
export function distanceToLine(x: number, y: number, points: readonly [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[Math.min(i + 1, points.length - 1)];
    const dx = bx - ax, dy = by - ay, span = dx * dx + dy * dy;
    const k = span ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / span)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + k * dx), y - (ay + k * dy)));
  }
  return best;
}

export const isKeptClear = (x: number, y: number, keep: readonly KeepClear[]) =>
  keep.some((k) => ("points" in k ? distanceToLine(x, y, k.points) <= k.width / 2 : inArea(x, y, k)));

/** Null when `args` name no area. */
export function parseArea(args: AreaArgs, regions: readonly Area[]): Area | null {
  if (typeof args.region === "string") {
    const wanted = args.region.toLowerCase();
    const r = regions.find((x) => x.name?.toLowerCase() === wanted);
    if (!r) throw new Error(`There's no region "${args.region}". list_regions gives them.`);
    return { left: r.left, bottom: r.bottom, right: r.right, top: r.top, name: r.name };
  }
  const box = [args.left, args.bottom, args.right, args.top];
  if (box.every((n) => n === undefined)) return null;
  if (!box.every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("An area needs a region, or all of left, bottom, right and top.");
  const [left, bottom, right, top] = box as number[];
  if (left >= right || bottom >= top) throw new Error("left must be below right, and bottom below top.");
  return { left, bottom, right, top };
}

/** The area `args` name, reading the map's regions if it's one of them. */
export async function readArea(w3: W3Api, args: AreaArgs): Promise<Area | null> {
  if (typeof args.region !== "string") return parseArea(args, []);
  return parseArea(args, (await readMapDoc<{ regions: (Area & { name: string })[] }>(w3, "map/war3map.w3r.json"))?.regions ?? []);
}
