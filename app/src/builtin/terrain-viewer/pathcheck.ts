// Can a unit get from here to there? Answers it on a grid of blocked cells, so a tool can test a
// layout without running the game. This is a good stand-in for the game's pathing, not the same.

/** Pathing cells are this wide. */
const CELL = 32;

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
export function checkPath(g: Grid, start: [number, number], goal: [number, number], unitSize: number): PathReport {
  const { width: w, height: h } = g;
  const cell = ([x, y]: [number, number]) => {
    const cx = Math.floor((x - g.offsetX) / CELL), cy = Math.floor((y - g.offsetY) / CELL);
    return cx < 0 || cy < 0 || cx >= w || cy >= h ? -1 : cy * w + cx;
  };
  const world = (i: number): [number, number] => [g.offsetX + (i % w + 0.5) * CELL, g.offsetY + (Math.floor(i / w) + 0.5) * CELL];
  const from = cell(start), to = cell(goal);
  if (from < 0 || to < 0) return { walkable: false, unitSize, problem: `${from < 0 ? "The start" : "The end"} is outside the map.` };
  const c = clearance(g);
  // Clearance c leaves a way 2c - 1 cells wide, and a unit needs twice its collision size. Counted
  // in whole cells that errs towards "too narrow": better to say so than to promise a way.
  const needed = Math.max(1, Math.ceil(unitSize / CELL + 0.5));
  const blockedEnd = !c[from] ? from : !c[to] ? to : null;
  if (blockedEnd !== null) {
    const x = blockedEnd % w, y = Math.floor(blockedEnd / w);
    let free: [number, number] | undefined;
    for (let r = 1; r < 64 && !free; r++) {
      for (let dy = -r; dy <= r && !free; dy++) {
        for (let dx = -r; dx <= r && !free; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h) continue;
          if (c[(y + dy) * w + x + dx]) free = world((y + dy) * w + x + dx);
        }
      }
    }
    return { walkable: false, unitSize, problem: `${blockedEnd === from ? "The start" : "The end"} is inside something that blocks, or on ground that can't be walked: that says nothing about the way to it.`, ...(free ? { nearestFree: free } : {}) };
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
  const every = Math.max(1, Math.ceil(way.length / 12));
  return {
    walkable: true, unitSize, length: Math.round(length),
    narrowest: { width: (Math.max(1, c[tight]) * 2 - 1) * CELL, at: world(tight) },
    widestWay: (low * 2 - 1) * CELL,
    route: [...way.filter((_, k) => k % every === 0), to].map(world),
  };
}
