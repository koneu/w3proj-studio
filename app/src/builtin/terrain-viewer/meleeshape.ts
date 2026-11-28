// The shape of the ground round a place and over a whole map, for check_melee and find_spots: how far a camp is
// walled in and how many ways lead to it, and how much of the walkable ground lies in the open. Counted on the
// walk grid (pathcheck.ts Grid: 32 units a cell, every tree, doodad and cliff in it).

import { clearance, type Grid } from "./pathcheck";

/** The rays a place is looked round with, and how far out each looks for something in the way. */
const RAYS = 24, REACH = Array.from({ length: 13 }, (_, i) => 256 + i * 32);

export interface Ring {
  /** The share of the ring round the place that is walled off: 1 a dead end, 0 open ground all round. */
  closed: number;
  /** The gaps in the ring: runs of open directions, each at least two rays (30°) wide. */
  ways: number;
  /** The widest gap, in degrees (360: nothing in the way anywhere). */
  widest: number;
}

/** How the ring round (x, y) is closed: per direction, whether something blocks between 256 and 640 out (looked at
 *  every cell, so a single row of trees counts). */
export function ringAround(g: Grid, x: number, y: number): Ring {
  const wall = (px: number, py: number) => {
    const cx = Math.floor((px - g.offsetX) / 32), cy = Math.floor((py - g.offsetY) / 32);
    return cx < 0 || cy < 0 || cx >= g.width || cy >= g.height || g.blocked[cy * g.width + cx] === 1;
  };
  const shut: boolean[] = [];
  for (let a = 0; a < RAYS; a++) {
    const angle = (a * 2 * Math.PI) / RAYS;
    shut.push(REACH.some((r) => wall(x + r * Math.cos(angle), y + r * Math.sin(angle))));
  }
  const closed = shut.filter(Boolean).length;
  if (closed === 0) return { closed: 0, ways: 1, widest: 360 };
  // Runs of open rays, round the circle: started after a shut one.
  const first = shut.indexOf(true);
  let ways = 0, widest = 0, run = 0;
  for (let k = 1; k <= RAYS; k++) {
    if (!shut[(first + k) % RAYS]) { run++; continue; }
    if (run >= 2) ways++;
    widest = Math.max(widest, run);
    run = 0;
  }
  return { closed: closed / RAYS, ways, widest: (widest * 360) / RAYS };
}

/** A map's open ground: of its walkable cells, the share more than `far` (world units) from anything in the way. */
export function openness(g: Grid, far = 400): { walkable: number; open: number; share: number } {
  const c = clearance(g), need = Math.floor(far / 32);
  let walkable = 0, open = 0;
  for (let i = 0; i < c.length; i++) {
    if (g.blocked[i]) continue;
    walkable++;
    if (c[i] > need) open++;
  }
  return { walkable, open, share: walkable ? open / walkable : 0 };
}
