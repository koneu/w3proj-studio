// Cliff types and ramps: what the terrain brushes and the AI tools share.

import { setLayer, type Corner, type Terrain } from "./w3e";

/** What these functions report the corners they're about to change to. */
export interface CornerLog {
  touch(t: Terrain, i: number): void;
}

/** A log that makes one undo step of the corners it saw. */
export class CornerUndo implements CornerLog {
  private readonly before = new Map<number, Corner>();
  touch(t: Terrain, i: number) { if (!this.before.has(i)) this.before.set(i, { ...t.corners[i] }); }
  /** The step, once the changes are made. */
  step(t: Terrain) {
    const before = this.before, after = new Map([...before.keys()].map((i) => [i, { ...t.corners[i] }]));
    const restore = (saved: Map<number, Corner>) => { for (const [i, c] of saved) t.corners[i] = { ...c }; };
    return { corners: [...before.keys()], undo: () => restore(before), redo: () => restore(after) };
  }
}

/** Moves a block of corners `by` cliff levels, so its shape stays: what's on it comes along. The water stays where it
 *  is (its stored level and flag untouched), as the World Editor's Adjust Cliff Levels leaves it (adjustCliffLevels):
 *  the depth follows from the new ground. A ramp the block cuts through is gone, as it needs the levels it was built on. */
export function adjustLevels(t: Terrain, a: { x0: number; y0: number; x1: number; y1: number }, by: number, cliffGround: string[], log: CornerLog) {
  const W = t.width;
  const inside = (i: number) => { const x = i % W, y = Math.floor(i / W); return x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1; };
  const block: number[] = [];
  for (let y = a.y0; y <= a.y1; y++) for (let x = a.x0; x <= a.x1; x++) block.push(y * W + x);
  const seen = new Set<number>();
  for (const start of block) {
    if (!t.corners[start].ramp || seen.has(start)) continue;
    const ramp = [start];
    seen.add(start);
    for (const i of ramp) {
      const x = i % W;
      for (const n of [...(x > 0 ? [i - 1] : []), ...(x < W - 1 ? [i + 1] : []), i - W, i + W]) {
        if (t.corners[n]?.ramp && !seen.has(n)) { seen.add(n); ramp.push(n); }
      }
    }
    if (ramp.every(inside)) continue;
    for (const i of ramp) { log.touch(t, i); t.corners[i].ramp = false; }
  }
  for (const i of block) {
    log.touch(t, i);
    const c = t.corners[i];
    setLayer(c, c.layer + by);
  }
  matchCliffTypes(t, block, cliffGround, log);
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
 *  removed. Returns a message when nothing could be done. `asFarAsPossible` is for the brush: a ramp takes
 *  the width that fits, and a corner or diagonal cliff gets one too. Without it a ramp is the width asked for
 *  or nothing, for callers that have to be told. `keep` is for a drag: what's there stays, so going over a
 *  ramp doesn't take it away. */
export function toggleRamp(t: Terrain, wx: number, wy: number, halfWidth: number, stroke: CornerLog, asFarAsPossible = false, keep = false): string | null {
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
  if (keep && quad.every((c) => c.ramp)) return null;
  if (!keep && quad.some((c) => c.ramp)) {
    const todo = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].filter(([cx, cy]) => at(cx, cy)!.ramp);
    const seen = new Set<number>();
    while (todo.length) {
      const [cx, cy] = todo.pop()!;
      const i = cy * t.width + cx;
      if (seen.has(i) || !at(cx, cy)?.ramp) continue;
      seen.add(i);
      set(cx, cy, false);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) todo.push([cx + dx, cy + dy]);
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
  const band = asFarAsPossible ? slopeBand(t, Math.round((wx - t.offsetX) / 128), Math.round((wy - t.offsetY) / 128), Math.max(1, halfWidth)) : [];
  if (band.length) {
    for (const [cx, cy] of band) set(cx, cy, true);
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
    const rows: [number, number][][] = [];
    for (let k = -halfWidth; k <= halfWidth; k++) {
      const row: [number, number][] = [];
      let fits = true;
      for (let s = 0; s < 3; s++) {
        const cx = along[0] ? start[0] + along[0] * s : centre + k;
        const cy = along[0] ? centre + k : start[1] + along[1] * s;
        const c = at(cx, cy);
        if (!c) { if (!asFarAsPossible) return "The ramp would leave the map."; fits = false; break; }
        if (c.layer !== (s === 0 ? hi : lo)) {
          if (!asFarAsPossible) return "The cliff isn't straight and level enough here for a ramp this wide (try a smaller Size).";
          fits = false;
          break;
        }
        row.push([cx, cy]);
      }
      rows.push(fits ? row : []);
    }
    const run = widestRun(rows.map((r) => r.length > 0), halfWidth);
    if (!run) return "The cliff isn't straight and level enough here for a ramp.";
    return rows.slice(run[0], run[1] + 1).flat();
  }

}

/** A ramp on a cliff that bends, as the World Editor flags one: every corner of the cliff tiles, and the low
 *  ground one step further. Measured on a ramp it built right round a plateau and one along a diagonal: 135 of
 *  138 corners. It covers the cliff within `reach` corners of corner (cx, cy) and no further: a drag paints the
 *  rest. Empty if there's no one-level cliff here. */
export function slopeBand(t: Terrain, cx: number, cy: number, reach: number): [number, number][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < t.width && y < t.height ? t.corners[y * t.width + x] : null);
  const levels = (tx: number, ty: number) => [at(tx, ty), at(tx + 1, ty), at(tx, ty + 1), at(tx + 1, ty + 1)].map((c) => c?.layer ?? -1);
  let start: [number, number] | null = null, hi = -1;
  for (let dy = -2; dy <= 1 && !start; dy++) for (let dx = -2; dx <= 1 && !start; dx++) {
    const ls = levels(cx + dx, cy + dy), top = Math.max(...ls);
    if (!ls.includes(-1) && top - Math.min(...ls) === 1) { start = [cx + dx, cy + dy]; hi = top; }
  }
  if (!start) return [];
  const lo = hi - 1;
  const cliffTile = (tx: number, ty: number) => { const ls = levels(tx, ty); return ls.includes(hi) && ls.includes(lo) && ls.every((l) => l === hi || l === lo); };
  const tiles = new Set<number>();
  const key = (x: number, y: number) => y * t.width + x;
  for (let y = cy - reach; y < cy + reach; y++) for (let x = cx - reach; x < cx + reach; x++) if (cliffTile(x, y)) tiles.add(key(x, y));
  const onCliff = (x: number, y: number) => tiles.has(key(x, y)) || tiles.has(key(x - 1, y)) || tiles.has(key(x, y - 1)) || tiles.has(key(x - 1, y - 1));
  const lowEdge = (x: number, y: number) => at(x, y)?.layer === lo && onCliff(x, y);
  const out: [number, number][] = [];
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const c = at(x, y)!;
    if (onCliff(x, y) || (c.layer === lo && (lowEdge(x + 1, y) || lowEdge(x - 1, y) || lowEdge(x, y + 1) || lowEdge(x, y - 1)))) out.push([x, y]);
  }
  return out.length >= 4 ? out : [];
}

/** A ramp side: a 2×1 or 1×2 block of tiles where a ramp meets the cliff beside it, drawn with one model from the
 *  cliff type's ramp folder. `x`, `y` is its bottom-left tile; `outer` its outer corners (bottom-left, top-left,
 *  top-right, bottom-right) and `base` their lowest layer; `tiles` the tiles it covers (y × (width-1) + x). */
export interface RampSide { x: number; y: number; w: number; h: number; outer: Corner[]; base: number; tiles: number[] }

/** The ramp sides of a terrain: every tile with some ramp corners, not all, whose corners' layers differ, is the
 *  first of the blocks around it that fits a ramp side (`accept`: the caller can also have it, e.g. a model for it;
 *  if not, the next block is tried). The flat tile such a block takes in is part of it. The view draws them with
 *  ramp models (planCliffs); the pathing map blocks them as cliffs. */
export function rampSides(t: Terrain, accept: (side: RampSide) => boolean = () => true): RampSide[] {
  const corner = (x: number, y: number) => t.corners[y * t.width + x];
  const tw = t.width - 1;
  const covered = new Set<number>();
  const out: RampSide[] = [];
  for (let y = 0; y < t.height - 1; y++) {
    for (let x = 0; x < tw; x++) {
      if (covered.has(y * tw + x)) continue;
      const cs = [corner(x, y), corner(x, y + 1), corner(x + 1, y + 1), corner(x + 1, y)];
      if (!cs.some((c) => c.ramp) || cs.every((c) => c.ramp) || cs.every((c) => c.layer === cs[0].layer)) continue;
      // Blocks containing this tile: horizontal (2×1) or vertical (1×2).
      const blocks: [number, number, number, number][] = [[x, y, 2, 1], [x - 1, y, 2, 1], [x, y, 1, 2], [x, y - 1, 1, 2]];
      for (const [bx, by, bw, bh] of blocks) {
        if (bx < 0 || by < 0 || bx + bw > tw || by + bh > t.height - 1) continue;
        const tiles = bw === 2 ? [by * tw + bx, by * tw + bx + 1] : [by * tw + bx, (by + 1) * tw + bx];
        if (tiles.some((i) => covered.has(i))) continue;
        const outer = [corner(bx, by), corner(bx, by + bh), corner(bx + bw, by + bh), corner(bx + bw, by)];
        const base = Math.min(...outer.map((c) => c.layer));
        if (outer.some((c) => c.layer - base > 2)) continue;
        // The ramp corners run along the block's long side: a row (top 1,2 or
        // bottom 0,3) for 2×1 pieces, a column (left 0,1 or right 2,3) for 1×2.
        const ramps = outer.map((c, i) => (c.ramp ? i : -1)).filter((i) => i >= 0).join("");
        if (!(bw === 2 ? ramps === "12" || ramps === "03" : ramps === "01" || ramps === "23")) continue;
        // And they rise one layer along it (L to H, H to X: the game's ramp pieces, CliffTransAAHL0 and so on); two
        // on one layer are where a ramp's top runs along a cliff, an ordinary cliff (Last Refuge's tile 74,39).
        const [r0, r1] = [...ramps].map((i) => outer[Number(i)].layer);
        if (Math.abs(r0 - r1) !== 1) continue;
        // A side piece for a ramp running straight past it: the ramp's row flagged all along, the far side
        // not, and level with the ramp's low end in the middle (it falls high, low, low). Others are where a
        // ramp ends on a bent cliff, where the piece leaves a hole here: an ordinary cliff meets its
        // neighbours. This only decides what the view draws, the map keeps its flags.
        const middle = bw === 2 ? [corner(bx + 1, by), corner(bx + 1, by + 1)] : [corner(bx, by + 1), corner(bx + 1, by + 1)];
        const [near, far] = ramps === "03" || ramps === "01" ? middle : [middle[1], middle[0]];
        const low = Math.min(...outer.filter((c) => c.ramp).map((c) => c.layer));
        if (!near.ramp || far.ramp || near.layer !== low) continue;
        const side = { x: bx, y: by, w: bw, h: bh, outer, base, tiles };
        if (!accept(side)) continue;
        out.push(side);
        for (const i of tiles) covered.add(i);
        break;
      }
    }
  }
  return out;
}

/** The longest unbroken stretch of rows that fit, of two at least (one tile wide), nearest the middle one
 *  (`middle` is its index) when there are several as long. Null if none. */
export function widestRun(fits: readonly boolean[], middle: number): [number, number] | null {
  let best: [number, number] | null = null;
  const off = (r: [number, number]) => (middle < r[0] ? r[0] - middle : middle > r[1] ? middle - r[1] : 0);
  for (let i = 0; i < fits.length; i++) {
    if (!fits[i] || fits[i - 1]) continue;
    let j = i;
    while (fits[j + 1]) j++;
    const run: [number, number] = [i, j];
    if (j === i) continue;
    if (!best || off(run) < off(best) || (off(run) === off(best) && j - i > best[1] - best[0])) best = run;
  }
  return best;
}
