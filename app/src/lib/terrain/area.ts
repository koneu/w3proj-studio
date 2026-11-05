// A part of the map a tool talks about: a region of the map by name, or a rectangle.

import type { W3Api } from "../../extensions/api";
import { readMapDoc } from "../formats/mapdoc";

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

/** Says when an area reaches past the playable part; null when it doesn't. */
export function beyondPlayable(area: Area, playable: Area): string | null {
  const sides = [area.left < playable.left && "west", area.right > playable.right && "east", area.bottom < playable.bottom && "south", area.top > playable.top && "north"].filter(Boolean);
  return sides.length ? `This area runs past the playable map to the ${sides.join(" and ")}: nothing can stand there.` : null;
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
