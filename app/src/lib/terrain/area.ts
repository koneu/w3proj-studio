// A part of the map a tool talks about: a region of the map by name, or a rectangle.

import type { W3Api } from "../../extensions/api";
import { readMapDoc } from "../formats/mapdoc";
import { mapEdgeTiles, type Terrain } from "./w3e";

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
type EdgeGrid = Pick<Terrain, "width" | "height" | "corners">;

/** The dark over the map's border: black at BORDER_ALPHA over each tile the terrain marks as past the playable map
 *  (mapEdgeTiles), not by the w3i's border, as the World Editor goes by the marks. One RGBA texel per corner of the
 *  pathing cells (`4 * tiles + 1` a side, row 0 in the south), dark where any cell around it is past the playable map:
 *  drawn smoothly between the corners, the dark fades out over the first playable cell, as the editor's (we-drive, map
 *  03's west edge, 2026-11-12: from green 16 to 107 over 13 pixels, a cell's width there, just inside the edge). */
export function borderShade(t: EdgeGrid): { rgba: Uint8Array; width: number; height: number } {
  const tilesX = Math.max(0, t.width - 1), tilesY = Math.max(0, t.height - 1), edge = mapEdgeTiles(t);
  const width = tilesX * 4 + 1, height = tilesY * 4 + 1, rgba = new Uint8Array(width * height * 4);
  const past = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < tilesX * 4 && cy < tilesY * 4 && edge[(cy >> 2) * tilesX + (cx >> 2)] === 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (past(x - 1, y - 1) || past(x, y - 1) || past(x - 1, y) || past(x, y)) rgba[(y * width + x) * 4 + 3] = BORDER_ALPHA;
  }
  return { rgba, width, height };
}
/** How dark the border is: the World Editor's border ground keeps about 14.5 % of its colour (map 03, green 16 of 110
 *  just inside, we-drive 2026-11-12; Studio's 165 kept 35 %, green 39). */
export const BORDER_ALPHA = 218;

/** Per corner (row 0 in the south), 1 where the water is black: every tile it belongs to lies past the playable map
 *  (mapEdgeTiles). The World Editor draws the border's water black and fades it in over the last border tile, its
 *  corners on the playable edge lit (we-drive, HillsbradCreek's west edge, 2026-11-12: a deep lake in the border,
 *  0, 0, 0 there, rising to the lake's colour over about one tile right up to the playable edge). */
export function darkWaterCorners(t: EdgeGrid): Uint8Array {
  const tilesX = Math.max(0, t.width - 1), tilesY = Math.max(0, t.height - 1), edge = mapEdgeTiles(t);
  const out = new Uint8Array(t.width * t.height);
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    let any = false, lit = false;
    for (const [tx, ty] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) {
      if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) continue;
      any = true;
      if (!edge[ty * tilesX + tx]) lit = true;
    }
    if (any && !lit) out[y * t.width + x] = 1;
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
