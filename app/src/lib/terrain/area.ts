// A part of the map a tool talks about: a region of the map by name, or a rectangle.

import type { W3Api } from "../../extensions/api";
import { readMapDoc } from "../formats/mapdoc";

export interface Area { left: number; bottom: number; right: number; top: number; name?: string }
interface AreaArgs { region?: unknown; left?: unknown; bottom?: unknown; right?: unknown; top?: unknown }

export const inArea = (x: number, y: number, a: Area) => x >= a.left && x <= a.right && y >= a.bottom && y <= a.top;

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
