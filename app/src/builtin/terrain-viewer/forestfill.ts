// fill_forest: forest over everything that isn't kept free, with ways left between the kept places. An AI that
// scatters trees over open ground gets tree islands (clumps armies walk round on every side); filling what isn't
// base, road, clearing or shop gives walls with ways through them, as ladder maps have.
//
// The kept places are the reserved areas (reserve_area). Between them ways of a given width stay free: the shortest
// walks on the ground as it is, along the edges of the smallest tree that joins every kept place (so each is
// reached, without a way from each to each).

import { distanceToLine } from "../../lib/terrain/area";
import { checkPath, type Grid } from "./pathcheck";

type Point = [number, number];
export interface Anchor { name: string; at: Point }
export interface ForestWay { from: string; to: string; length: number; points: Point[] }

export interface ForestPlan {
  /** Where trees go: `spacing` apart, on the grid of that spacing. */
  spots: { x: number; y: number }[];
  /** The ways left free between the kept places. */
  ways: ForestWay[];
  /** Kept places no way on foot joins to the others (water or cliffs between): nothing is left free toward them. */
  unreached: string[];
}

/** The edges of the smallest tree joining the anchors, by straight distance (Prim's). */
export function joinEdges(anchors: readonly Anchor[]): [number, number][] {
  if (anchors.length < 2) return [];
  const d = (a: number, b: number) => Math.hypot(anchors[a].at[0] - anchors[b].at[0], anchors[a].at[1] - anchors[b].at[1]);
  const inTree = new Set([0]), edges: [number, number][] = [];
  while (inTree.size < anchors.length) {
    let best: [number, number] | null = null, bestLength = Infinity;
    for (const a of inTree) for (let b = 0; b < anchors.length; b++) {
      if (inTree.has(b)) continue;
      const length = d(a, b);
      if (length < bestLength) { bestLength = length; best = [a, b]; }
    }
    edges.push(best!);
    inTree.add(best![1]);
  }
  return edges;
}

/**
 * Where the forest goes. `kept(x, y)`: a place that stays free whatever else (reserved areas, what the caller adds);
 * `inside(x, y)`: where trees may stand at all (the playable map); `ways`: how wide the ways between the anchors stay
 * (0: none are left); `spacing`: a tree's footprint. With `twin`, a spot is planted only when its twin (the map
 * turned half round) is free too, and the ways' twins stay free: both halves come out alike. A spot whose twin lies
 * outside `inside` is planted (the playable map's border is wider in the north than the south).
 */
export function forestPlan(g: Grid, o: {
  anchors: readonly Anchor[]; kept: (x: number, y: number) => boolean; inside: (x: number, y: number) => boolean;
  ways: number; spacing: number; twin?: (x: number, y: number) => Point;
}): ForestPlan {
  const out: ForestPlan = { spots: [], ways: [], unreached: [] };
  const reached = new Set<number>();
  if (o.ways > 0) for (const [a, b] of joinEdges(o.anchors)) {
    const from = o.anchors[a], to = o.anchors[b];
    // An anchor on blocked ground (a mine, a building) stands in its own way: from the nearest free place then.
    const free = (p: Point): Point => checkPath(g, p, p, 32, 2).nearestFree ?? p;
    const report = checkPath(g, free(from.at), free(to.at), 32, 400);
    if (!report.route) continue;
    reached.add(a).add(b);
    out.ways.push({ from: from.name, to: to.name, length: Math.round(report.length ?? 0), points: report.route });
  }
  if (o.ways > 0 && o.anchors.length > 1) out.unreached = o.anchors.filter((_, i) => !reached.has(i)).map((a) => a.name);
  const onWay = (x: number, y: number) => out.ways.some((w) => distanceToLine(x, y, w.points) <= o.ways / 2 + o.spacing / 2);
  const free = (x: number, y: number) => o.kept(x, y) || onWay(x, y);
  const blocked = (x: number, y: number) => {
    const cx = Math.floor((x - g.offsetX) / 32), cy = Math.floor((y - g.offsetY) / 32);
    return cx < 0 || cy < 0 || cx >= g.width || cy >= g.height || g.blocked[cy * g.width + cx] === 1;
  };
  const s = o.spacing, right = g.offsetX + g.width * 32, top = g.offsetY + g.height * 32;
  for (let y = Math.ceil(g.offsetY / s) * s + s / 2; y < top; y += s) {
    for (let x = Math.ceil(g.offsetX / s) * s + s / 2; x < right; x += s) {
      if (!o.inside(x, y) || blocked(x, y) || free(x, y)) continue;
      // A twin past the playable map (its border isn't the same on every side) is no ground to keep alike: planted.
      if (o.twin) { const [tx, ty] = o.twin(x, y); if (o.inside(tx, ty) && (blocked(tx, ty) || free(tx, ty))) continue; }
      out.spots.push({ x, y });
    }
  }
  return out;
}
