// Finds places for what a melee map needs, so an AI chooses among places that work instead of
// inventing coordinates. Limits are the ladder maps', as in meleecheck.ts.

import { CAMP_SHELTER } from "./meleecheck";
import { ringAround } from "./meleeshape";
import { clearance, widthOf, type Grid } from "./pathcheck";

type Point = readonly [number, number];
export type SpotKind = "camp" | "expansion";

export interface SpotFacts {
  grid: Grid;
  /** Widest way from a start, per cell (widestFrom). */
  widest: Uint16Array;
  starts: readonly Point[];
  mines: readonly Point[];
  camps: readonly Point[];
  /** Ways players walk. */
  routes: readonly (readonly Point[])[];
  /** Pathing cells something can't be built on. */
  noBuild?(x: number, y: number): boolean;
  /** The cliff level at a place: a natural shares its base's. */
  levelAt?(x: number, y: number): number;
  /** Where the map's middle is, for rotated twins. */
  whole: { left: number; bottom: number; right: number; top: number };
}

const near = (from: Point, list: readonly Point[]) => list.reduce((best, p) => Math.min(best, Math.hypot(from[0] - p[0], from[1] - p[1])), Infinity);
function toPath(p: Point, path: readonly Point[]) {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1], dx = bx - ax, dy = by - ay, span = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / span));
    best = Math.min(best, Math.hypot(p[0] - ax - k * dx, p[1] - ay - k * dy));
  }
  return best;
}

/** Limits by kind: distance from starts, from routes, camps and mines, room, and way in. */
const LIMITS = {
  camp: { start: [1900, 9000], route: 800, camp: 1100, mine: 900, room: 5, way: 256 },
  expansion: { start: [3800, 5800], route: 0, camp: 700, mine: 2500, room: 8, way: 352 },
} as const;

/** Ranked places, best first, each far enough from the others to take one each. */
export interface Spot { at: [number, number]; score: number; fromStart: number; fromRoute?: number; sheltered: number; wayIn: number; twin?: [number, number] }
export interface Spots {
  kind: SpotKind;
  spots: Spot[];
  /** Camps: open places, when pockets are too few; each marked, so none is taken for a pocket. */
  openPlaces?: (Spot & { exposed: true })[];
  /** Camps: what to do when there are fewer pockets than asked for. */
  note?: string;
  considered: number;
  /** Camps: how many of the places considered are pockets. */
  pockets?: number;
}

export function findSpots(kind: SpotKind, f: SpotFacts, count: number, mirror: boolean): Spots {
  const g = f.grid, c = clearance(g), l = LIMITS[kind], w = g.width, h = g.height;
  const cellOf = (x: number, y: number) => {
    const cx = Math.floor((x - g.offsetX) / 32), cy = Math.floor((y - g.offsetY) / 32);
    return cx < 0 || cy < 0 || cx >= w || cy >= h ? -1 : cy * w + cx;
  };
  /** How much of the ring around a place is walled off: 1 is a dead end. */
  const shelter = (x: number, y: number) => ringAround(g, x, y).closed;
  const check = (x: number, y: number) => {
    const i = cellOf(x, y);
    if (i < 0 || c[i] < l.room) return null;
    const way = widthOf(f.widest[i]);
    if (way < l.way) return null;
    const fromStart = near([x, y], f.starts);
    if (fromStart < l.start[0] || fromStart > l.start[1]) return null;
    if (near([x, y], f.mines) < l.mine || near([x, y], f.camps) < l.camp) return null;
    const fromRoute = f.routes.reduce((best, r) => Math.min(best, toPath([x, y], r)), Infinity);
    if (fromRoute < l.route) return null;
    if (kind === "expansion" && f.noBuild) for (const [dx, dy] of [[0, 0], [160, 0], [-160, 0], [0, 160], [0, -160]]) if (f.noBuild(x + dx, y + dy)) return null;
    return { way, fromStart, fromRoute, sheltered: shelter(x, y) };
  };
  /** Forward and to the side of the nearest start, on its level, as ladder maps have naturals. */
  const natural = (x: number, y: number) => {
    if (f.starts.length !== 2) return 0;
    const home = f.starts.reduce((a, b) => (Math.hypot(a[0] - x, a[1] - y) < Math.hypot(b[0] - x, b[1] - y) ? a : b));
    const enemy = f.starts[0] === home ? f.starts[1] : f.starts[0];
    const a = Math.atan2(enemy[1] - home[1], enemy[0] - home[0]), b = Math.atan2(y - home[1], x - home[0]);
    const turn = Math.abs((((b - a) * 180) / Math.PI + 540) % 360 - 180);
    const same = !f.levelAt || f.levelAt(x, y) === f.levelAt(home[0], home[1]);
    return (same ? 300 : -300) - Math.abs(turn - 40) * 4;
  };
  const found: { at: [number, number]; score: number; fromStart: number; fromRoute?: number; sheltered: number; wayIn: number; twin?: [number, number] }[] = [];
  for (let y = g.offsetY + 64; y < g.offsetY + h * 32; y += 128) {
    for (let x = g.offsetX + 64; x < g.offsetX + w * 32; x += 128) {
      const here = check(x, y);
      if (!here) continue;
      const twin: [number, number] | undefined = mirror ? [f.whole.left + f.whole.right - x, f.whole.bottom + f.whole.top - y] : undefined;
      if (twin && !check(twin[0], twin[1])) continue;
      const score = kind === "camp" ? here.sheltered * 1000 + Math.min(here.fromRoute, 1800) / 3 : Math.min(here.way, 700) - Math.abs(here.fromStart - 5000) / 4 + natural(x, y);
      found.push({ at: [x, y], score: Math.round(score), fromStart: Math.round(here.fromStart), ...(Number.isFinite(here.fromRoute) ? { fromRoute: Math.round(here.fromRoute) } : {}), sheltered: Math.round(here.sheltered * 100) / 100, wayIn: here.way, ...(twin ? { twin } : {}) });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const gap = kind === "camp" ? l.camp : 1500;
  const pick = (from: typeof found, most: number) => {
    const picked: typeof found = [];
    for (const s of from) {
      if (picked.length >= most) break;
      const taken = picked.flatMap((p) => [p.at, ...(p.twin ? [p.twin] : [])]);
      if (near(s.at, taken) >= gap && (!s.twin || near(s.twin, taken) >= gap)) picked.push(s);
    }
    return picked;
  };
  if (kind !== "camp") return { kind, spots: pick(found, count), considered: found.length };
  // A camp wants a pocket: a place less walled in than the ladder maps' camps isn't offered as one. What there is of
  // open places is shown apart and marked, so it isn't taken for a find.
  const pockets = found.filter((s) => s.sheltered >= CAMP_SHELTER);
  const spots = pick(pockets, count);
  const open = spots.length < count ? pick(found.filter((s) => s.sheltered < CAMP_SHELTER), Math.min(3, count - spots.length)).map((s) => ({ ...s, exposed: true as const })) : [];
  const note = spots.length >= count ? undefined
    : spots.length === 0 ? `No real pockets yet: nowhere that fits is walled in as ladder camps are (${Math.round(CAMP_SHELTER * 100)}% of the ring round them or more). Build some first (make_pocket puts a horseshoe of trees round a place; set_cliff_level and fill_rows make walls), then ask again.${open.length ? " The open places listed are the least bad of what there is, not good ones." : ""}`
    : `Only ${spots.length} pocket${spots.length === 1 ? "" : "s"} found for ${count} asked: build more (make_pocket, set_cliff_level, fill_rows) rather than take open ground.`;
  return { kind, spots, ...(open.length ? { openPlaces: open } : {}), ...(note ? { note } : {}), considered: found.length, pockets: pockets.length };
}
