// Cliff types and ramps: what the terrain brushes and the AI tools share.

import type { Corner, Terrain } from "./w3e";

/** What these functions report the corners they're about to change to. */
export interface CornerLog {
  touch(t: Terrain, i: number): void;
}

/** Corners of cliff tiles get the cliff type `fixed` (a cliff type number, as chosen in the World
 *  Editor's cliff palette), or without it the cliff type of their ground tile where it has one,
 *  so painting grass next to a cliff, or raising a cliff on grass, gives a grass cliff. That's what the World
 *  Editor's maps show: on cliff corners the ground tile and the cliff type agree in 85–100 % (12
 *  maps), on flat ground they don't. `cliffGround`: the ground tile of each cliff type number;
 *  corners next to `around` are checked too (a cliff's type comes from its bottom-left corner). */
export function matchCliffTypes(t: Terrain, around: Iterable<number>, cliffGround: string[], stroke: CornerLog, fixed?: number): boolean {
  if (!cliffGround.length) return false;
  const W = t.width, H = t.height;
  const layer = (x: number, y: number) => t.corners[y * W + x].layer;
  /** The tile with bottom-left corner (x, y) is a cliff (its corners aren't all on one layer). */
  const cliffTile = (x: number, y: number) => x >= 0 && y >= 0 && x < W - 1 && y < H - 1
    && !(layer(x, y) === layer(x + 1, y) && layer(x, y) === layer(x, y + 1) && layer(x, y) === layer(x + 1, y + 1));
  const near = new Set<number>();
  for (const i of around) {
    const x = i % W, y = Math.floor(i / W);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H) near.add((y + dy) * W + x + dx);
    }
  }
  let changed = false;
  for (const i of near) {
    const x = i % W, y = Math.floor(i / W);
    if (!(cliffTile(x - 1, y - 1) || cliffTile(x, y - 1) || cliffTile(x - 1, y) || cliffTile(x, y))) continue;
    const c = t.corners[i];
    const type = fixed ?? cliffGround.indexOf(t.groundTiles[c.texture]);
    if (type < 0 || c.cliffTexture === type) continue;
    stroke.touch(t, i);
    c.cliffTexture = type;
    changed = true;
  }
  return changed;
}

/** Ramp tool, one click at world (wx, wy): on a one-layer cliff tile the
 *  corners along the slope get the ramp flag (the high end and two corners
 *  on the lower layer, `2 * halfWidth + 1` corners across, as World Editor
 *  ramps are); on a tile that already has ramp corners the ramp there is
 *  removed. Returns a message when nothing could be done. */
export function toggleRamp(t: Terrain, wx: number, wy: number, halfWidth: number, stroke: CornerLog): string | null {
  const x = Math.floor((wx - t.offsetX) / 128), y = Math.floor((wy - t.offsetY) / 128);
  if (x < 0 || y < 0 || x >= t.width - 1 || y >= t.height - 1) return "Outside the map.";
  const at = (cx: number, cy: number) => (cx >= 0 && cy >= 0 && cx < t.width && cy < t.height ? t.corners[cy * t.width + cx] : null);
  const set = (cx: number, cy: number, on: boolean) => {
    const c = at(cx, cy);
    if (!c || c.ramp === on) return;
    stroke.touch(t, cy * t.width + cx);
    c.ramp = on;
  };
  const quad = [at(x, y)!, at(x + 1, y)!, at(x, y + 1)!, at(x + 1, y + 1)!];

  // Remove: clear the connected ramp corners around the click.
  if (quad.some((c) => c.ramp)) {
    const todo = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].filter(([cx, cy]) => at(cx, cy)!.ramp);
    const seen = new Set<number>();
    while (todo.length) {
      const [cx, cy] = todo.pop()!;
      const i = cy * t.width + cx;
      if (seen.has(i) || !at(cx, cy)?.ramp || Math.abs(cx - x) > 8 || Math.abs(cy - y) > 8) continue;
      seen.add(i);
      set(cx, cy, false);
      todo.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    return null;
  }

  // Build: the clicked tile or, since clicks land beside the cliff face as
  // often as on it, the nearest tile around it that is a straight edge.
  const fx = (wx - t.offsetX) / 128 - 0.5, fy = (wy - t.offsetY) / 128 - 0.5;
  const candidates: [number, number][] = [];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) candidates.push([x + i, y + j]);
  candidates.sort((a, b) => Math.hypot(a[0] - fx, a[1] - fy) - Math.hypot(b[0] - fx, b[1] - fy));
  let problem = "Click a cliff one level high to build a ramp.";
  for (const [tx, ty] of candidates) {
    const cells = rampCells(tx, ty);
    if (typeof cells === "string") { if (tx === x && ty === y) problem = cells; continue; }
    for (const [cx, cy] of cells) set(cx, cy, true);
    return null;
  }
  return problem;

  /** Corners a ramp from cliff tile (tx, ty) would flag, or why it can't be built. */
  function rampCells(tx: number, ty: number): [number, number][] | string {
    const q = [at(tx, ty), at(tx + 1, ty), at(tx, ty + 1), at(tx + 1, ty + 1)];
    if (q.some((c) => !c)) return "Outside the map.";
    const [bl, br, tl, tr] = q as Corner[];
    const lo = Math.min(bl.layer, br.layer, tl.layer, tr.layer), hi = Math.max(bl.layer, br.layer, tl.layer, tr.layer);
    if (hi - lo > 1) return "Ramps only work on cliffs one level high; this one is higher.";
    if (hi - lo !== 1) return "Click a cliff one level high to build a ramp.";
    // Slope direction: the axis along which the tile's layers differ.
    let along: [number, number], start: [number, number];
    if (bl.layer === hi && tl.layer === hi && br.layer === lo && tr.layer === lo) { along = [1, 0]; start = [tx, ty]; }
    else if (br.layer === hi && tr.layer === hi && bl.layer === lo && tl.layer === lo) { along = [-1, 0]; start = [tx + 1, ty]; }
    else if (bl.layer === hi && br.layer === hi && tl.layer === lo && tr.layer === lo) { along = [0, 1]; start = [tx, ty]; }
    else if (tl.layer === hi && tr.layer === hi && bl.layer === lo && br.layer === lo) { along = [0, -1]; start = [tx, ty + 1]; }
    else return "Click a straight cliff edge (not a corner) to build a ramp.";
    // The ramp's centre line runs through the click.
    const centre = along[0] ? Math.round((wy - t.offsetY) / 128) : Math.round((wx - t.offsetX) / 128);
    const cells: [number, number][] = [];
    for (let k = -halfWidth; k <= halfWidth; k++) {
      for (let s = 0; s < 3; s++) {
        const cx = along[0] ? start[0] + along[0] * s : centre + k;
        const cy = along[0] ? centre + k : start[1] + along[1] * s;
        const c = at(cx, cy);
        if (!c) return "The ramp would leave the map.";
        if (c.layer !== (s === 0 ? hi : lo)) return "The cliff isn't straight and level enough here for a ramp this wide (try a smaller Size).";
        cells.push([cx, cy]);
      }
    }
    return cells;
  }
}
