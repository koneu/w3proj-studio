// Can a unit get from here to there? Answers it on a grid of blocked cells, so a tool can test a
// layout without running the game. This is a good stand-in for the game's pathing, not the same.

import { distanceToLine, type Area } from "../../lib/terrain/area";

/** Pathing cells are this wide. */
const CELL = 32;

/** Clearance c leaves a way 2c - 1 cells wide, and a unit needs twice its collision size. Counted
 *  in whole cells that errs towards "too narrow": better to say so than to promise a way. */
const roomFor = (unitSize: number) => Math.max(1, Math.ceil(unitSize / CELL + 0.5));

export interface Grid { blocked: Uint8Array; width: number; height: number; offsetX: number; offsetY: number }

/** For every cell, how many cells away the nearest blocked one or the map's edge is. */
export function clearance(g: Pick<Grid, "blocked" | "width" | "height">): Uint16Array {
  const { blocked, width: w, height: h } = g, c = new Uint16Array(w * h);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : c[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      c[y * w + x] = blocked[y * w + x] ? 0 : 1 + Math.min(at(x - 1, y), at(x, y - 1), at(x - 1, y - 1), at(x + 1, y - 1));
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (c[i]) c[i] = Math.min(c[i], 1 + Math.min(at(x + 1, y), at(x, y + 1), at(x + 1, y + 1), at(x - 1, y + 1)));
    }
  }
  return c;
}

/** Breadth first over cells with at least `room` clearance; corners aren't cut. */
function search(c: Uint16Array, w: number, h: number, from: number, to: number, room: number) {
  const prev = new Int32Array(w * h).fill(-1);
  prev[from] = from;
  let queue = [from], closest = from;
  const left = (i: number) => Math.max(Math.abs(i % w - to % w), Math.abs(Math.floor(i / w) - Math.floor(to / w)));
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && c[y * w + x] >= room;
  while (queue.length) {
    const next: number[] = [];
    for (const i of queue) {
      if (i === to) return { prev, found: true, closest: to };
      if (left(i) < left(closest)) closest = i;
      const x = i % w, y = Math.floor(i / w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const o = (y + dy) * w + x + dx;
        if (!open(x + dx, y + dy) || prev[o] !== -1) continue;
        if (dx && dy && !(open(x + dx, y) && open(x, y + dy))) continue;
        prev[o] = i;
        next.push(o);
      }
    }
    queue = next;
  }
  return { prev, found: false, closest };
}

/** The closest open cell, looking outwards; null if there's none near. */
function nearestOpen(c: Uint16Array, w: number, h: number, cell: number): number | null {
  const x = cell % w, y = Math.floor(cell / w);
  for (let r = 1; r < 64; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h) continue;
        if (c[(y + dy) * w + x + dx]) return (y + dy) * w + x + dx;
      }
    }
  }
  return null;
}

/** Walkable ground a unit of this size can't reach from the map's biggest connected part: a sealed
 *  gate, a pasture cut in two. With `within`, only pockets touching that area. Smaller pockets than
 *  `smallest` cells are left out: the gaps between trees would drown out the rest. */
export function findPockets(g: Grid, unitSize: number, within: Area | null, smallest = 16) {
  const { width: w, height: h } = g, c = clearance(g), room = roomFor(unitSize);
  const label = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h);
  const parts: { cells: number; left: number; right: number; bottom: number; top: number; sample: number }[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || c[start] < room) continue;
    const id = parts.length, part = { cells: 0, left: w, right: 0, bottom: h, top: 0, sample: start };
    parts.push(part);
    let n = 0;
    stack[n++] = start;
    label[start] = id;
    while (n) {
      const i = stack[--n], x = i % w, y = Math.floor(i / w);
      part.cells++;
      part.left = Math.min(part.left, x); part.right = Math.max(part.right, x);
      part.bottom = Math.min(part.bottom, y); part.top = Math.max(part.top, y);
      for (const o of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (o >= 0 && label[o] === -1 && c[o] >= room) { label[o] = id; stack[n++] = o; }
      }
    }
  }
  const main = parts.reduce((best, p) => (p.cells > (best?.cells ?? 0) ? p : best), parts[0] as typeof parts[number] | undefined);
  const worldBox = (p: typeof parts[number]) => ({
    left: g.offsetX + p.left * CELL, right: g.offsetX + (p.right + 1) * CELL, bottom: g.offsetY + p.bottom * CELL, top: g.offsetY + (p.top + 1) * CELL,
  });
  const pockets = parts
    .filter((p) => p !== main && p.cells >= smallest)
    .filter((p) => { const b = worldBox(p); return !within || (b.left < within.right && b.right > within.left && b.bottom < within.top && b.top > within.bottom); })
    .sort((a, b) => b.cells - a.cells);
  return {
    unitSize, mainGround: main?.cells ?? 0,
    pockets: pockets.slice(0, 50).map((p) => ({ cells: p.cells, box: worldBox(p), somewhereInside: [g.offsetX + (p.sample % w + 0.5) * CELL, g.offsetY + (Math.floor(p.sample / w) + 0.5) * CELL] as [number, number] })),
    ...(pockets.length > 50 ? { morePockets: pockets.length - 50 } : {}),
  };
}

export interface RouteReport {
  walkable: boolean;
  unitSize: number;
  corridorWidth: number;
  length?: number;
  narrowest?: { width: number; at: [number, number] };
  /** Not walkable: the leg that failed, counted from 0, and how far it got. */
  failedLeg?: number;
  stuckAt?: [number, number];
  problem?: string;
  nearestFree?: [number, number];
}

/** Whether a unit can follow a line of points, staying within a corridor around it: a road test
 *  in one go, which fails if the only way round leaves the road. */
export function checkRoute(g: Grid, points: [number, number][], unitSize: number, corridorWidth: number): RouteReport {
  const { width: w, height: h } = g, base = { unitSize, corridorWidth };
  const cellOf = ([x, y]: [number, number]) => {
    const cx = Math.floor((x - g.offsetX) / CELL), cy = Math.floor((y - g.offsetY) / CELL);
    return cx < 0 || cy < 0 || cx >= w || cy >= h ? -1 : cy * w + cx;
  };
  const world = (i: number): [number, number] => [g.offsetX + (i % w + 0.5) * CELL, g.offsetY + (Math.floor(i / w) + 0.5) * CELL];
  const stops = points.map(cellOf);
  if (stops.includes(-1)) return { ...base, walkable: false, problem: `Point ${stops.indexOf(-1)} is outside the map.` };
  const c = clearance(g);
  const closed = stops.findIndex((i) => !c[i]);
  if (closed >= 0) {
    const free = nearestOpen(c, w, h, stops[closed]);
    return { ...base, walkable: false, failedLeg: Math.max(0, closed - 1), problem: `Point ${closed} is inside something that blocks.`, ...(free !== null ? { nearestFree: world(free) } : {}) };
  }
  // Measured against what's really there, not the corridor's own edge.
  const inside = new Uint16Array(w * h), half = corridorWidth / 2;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor((Math.min(...xs) - half - g.offsetX) / CELL)), x1 = Math.min(w - 1, Math.ceil((Math.max(...xs) + half - g.offsetX) / CELL));
  const y0 = Math.max(0, Math.floor((Math.min(...ys) - half - g.offsetY) / CELL)), y1 = Math.min(h - 1, Math.ceil((Math.max(...ys) + half - g.offsetY) / CELL));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x, [wx, wy] = world(i);
      if (c[i] && distanceToLine(wx, wy, points) <= half) inside[i] = c[i];
    }
  }
  const room = roomFor(unitSize), top = inside.reduce((a, b) => Math.max(a, b), 0);
  // The tightest place of the corridor itself, found along the widest way through each leg: that
  // doesn't depend on the unit, or on which side of the road a shortest way happens to hug.
  let length = 0, tightest = -1, widest = top;
  for (let leg = 0; leg + 1 < stops.length; leg++) {
    const from = stops[leg], to = stops[leg + 1], kept = [inside[from], inside[to]];
    inside[from] = inside[to] = 0xffff;
    const found = search(inside, w, h, from, to, room);
    if (!found.found) return { ...base, walkable: false, failedLeg: leg, stuckAt: world(found.closest), problem: "The unit can't get along here without leaving the corridor." };
    let low = room, high = top;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (search(inside, w, h, from, to, middle).found) low = middle; else high = middle - 1;
    }
    const wide = search(inside, w, h, from, to, low);
    inside[from] = kept[0]; inside[to] = kept[1];
    let last = to;
    for (let i = found.prev[to]; ; i = found.prev[i]) {
      length += Math.hypot(world(i)[0] - world(last)[0], world(i)[1] - world(last)[1]);
      last = i;
      if (i === from) break;
    }
    const way: number[] = [];
    for (let i = wide.prev[to]; i !== from; i = wide.prev[i]) way.push(i);
    const least = way.reduce((a, i) => Math.min(a, c[i]), Infinity), tight = way.filter((i) => c[i] === least);
    if (tight.length && least <= widest) { widest = least; tightest = tight[Math.floor(tight.length / 2)]; }
  }
  return { ...base, walkable: true, length: Math.round(length), ...(tightest >= 0 ? { narrowest: { width: (widest * 2 - 1) * CELL, at: world(tightest) } } : {}) };
}

/** The placed object closest to a point, within `reach`: what's probably making a place tight. */
export function nearestObject<T extends { position: readonly number[] }>(list: readonly T[], at: readonly number[], reach = 160): T | null {
  let best: T | null = null, gap = reach;
  for (const p of list) {
    const d = Math.hypot(p.position[0] - at[0], p.position[1] - at[1]);
    if (d <= gap) { best = p; gap = d; }
  }
  return best;
}

export interface PathReport {
  /** A unit of this collision size gets through. */
  walkable: boolean;
  /** World units. */
  unitSize: number;
  /** Set when `walkable`: the shortest way this unit fits through, and its tightest place. */
  length?: number;
  narrowest?: { width: number; at: [number, number] };
  /** How wide the widest way between the two is; bigger than `narrowest` if there's a wider detour. */
  widestWay?: number;
  /** Some points of the way. */
  route?: [number, number][];
  /** Why not. */
  problem?: string;
  /** A start or end on blocked ground: the nearest place to stand. */
  nearestFree?: [number, number];
  /** Not walkable: how far a unit gets towards the goal. */
  stuckAt?: [number, number];
  /** Not walkable: the largest collision size that would get through, 0 if none. */
  largestUnitThatFits?: number;
}

/** Whether a unit of `unitSize` (the game's collision size, a radius) can walk from one point to another. */
export function checkPath(g: Grid, start: [number, number], goal: [number, number], unitSize: number, points = 12): PathReport {
  const { width: w, height: h } = g;
  const cell = ([x, y]: [number, number]) => {
    const cx = Math.floor((x - g.offsetX) / CELL), cy = Math.floor((y - g.offsetY) / CELL);
    return cx < 0 || cy < 0 || cx >= w || cy >= h ? -1 : cy * w + cx;
  };
  const world = (i: number): [number, number] => [g.offsetX + (i % w + 0.5) * CELL, g.offsetY + (Math.floor(i / w) + 0.5) * CELL];
  const from = cell(start), to = cell(goal);
  if (from < 0 || to < 0) return { walkable: false, unitSize, problem: `${from < 0 ? "The start" : "The end"} is outside the map.` };
  const c = clearance(g);
  const needed = roomFor(unitSize);
  const blockedEnd = !c[from] ? from : !c[to] ? to : null;
  if (blockedEnd !== null) {
    const free = nearestOpen(c, w, h, blockedEnd);
    return { walkable: false, unitSize, problem: `${blockedEnd === from ? "The start" : "The end"} is inside something that blocks, or on ground that can't be walked: that says nothing about the way to it.`, ...(free !== null ? { nearestFree: world(free) } : {}) };
  }
  // Both ends count as wide enough: a unit can stand beside a tree, and the way to it isn't blocked.
  // A loop: a big map's cells are too many to pass as arguments.
  const ends = [from, to], saved = ends.map((i) => c[i]), top = c.reduce((a, b) => Math.max(a, b), 0);
  for (const i of ends) c[i] = top;
  let low = 0, high = top;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (search(c, w, h, from, to, middle).found) low = middle; else high = middle - 1;
  }
  const shortest = low >= needed ? search(c, w, h, from, to, needed) : null;
  ends.forEach((i, k) => { c[i] = saved[k]; });
  if (!shortest) {
    const stuck = search(c, w, h, from, to, needed);
    return { walkable: false, unitSize, problem: low ? "The way through is too narrow for this unit." : "There's no way through.", stuckAt: world(stuck.closest), largestUnitThatFits: low ? (2 * low - 1) * (CELL / 2) : 0 };
  }
  const way: number[] = [];
  for (let i = to; ; i = shortest.prev[i]) { way.push(i); if (i === from) break; }
  way.reverse();
  const inner = way.slice(1, -1).filter((i) => c[i] > 0);
  // The middle of the tightest stretch, not where it starts.
  const least = inner.reduce((a, i) => Math.min(a, c[i]), Infinity);
  const tightest = inner.filter((i) => c[i] === least);
  const tight = tightest[Math.floor(tightest.length / 2)] ?? from;
  let length = 0;
  for (let k = 1; k < way.length; k++) length += Math.hypot(world(way[k])[0] - world(way[k - 1])[0], world(way[k])[1] - world(way[k - 1])[1]);
  const every = Math.max(1, Math.ceil(way.length / points));
  return {
    walkable: true, unitSize, length: Math.round(length),
    narrowest: { width: (Math.max(1, c[tight]) * 2 - 1) * CELL, at: world(tight) },
    widestWay: (low * 2 - 1) * CELL,
    route: [...way.filter((_, k) => k % every === 0), to].map(world),
  };
}
