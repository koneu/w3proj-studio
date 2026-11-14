// Cliff types and ramps: what the terrain brushes and the AI tools share.

import type { Corner, Terrain } from "./w3e";

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

/** Corners of cliff tiles get the cliff type `fixed` (a cliff type number, as chosen in the World
 *  Editor's cliff palette), or without it the cliff type of their ground tile where it has one,
 *  so painting grass next to a cliff, or raising a cliff on grass, gives a grass cliff. That's what the World
 *  Editor's maps show: on cliff corners the ground tile and the cliff type agree in 85–100 % (12
 *  maps), on flat ground they don't. `cliffGround`: the ground tile of each cliff type number;
 *  corners next to `around` are checked too (a cliff's type comes from its bottom-left corner). `own` are corners
 *  that take the type though no cliff touches them: those a water brush turned into water, as the World Editor's
 *  size 3 brush gave its middle corner, with only water round it, the chosen cliff type too (we-drive 2026-11-12). */
export function matchCliffTypes(t: Terrain, around: Iterable<number>, cliffGround: string[], stroke: CornerLog, fixed?: number, own?: ReadonlySet<number>): boolean {
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
    if (!own?.has(i) && !(cliffTile(x - 1, y - 1) || cliffTile(x, y - 1) || cliffTile(x - 1, y) || cliffTile(x, y))) continue;
    const c = t.corners[i];
    const type = fixed ?? cliffGround.indexOf(t.groundTiles[c.texture]);
    if (type < 0 || c.cliffTexture === type) continue;
    stroke.touch(t, i);
    c.cliffTexture = type;
    changed = true;
  }
  return changed;
}

/** The World Editor's cliff types per round brush radius (its size − 1): for each row of corners from the top (north,
 *  `top` rows above the brush's centre) down, the first and last column, relative to the centre. */
const CLIFF_TYPE_ROWS: Record<number, { top: number; rows: [number, number][] }> = {
  0: { top: 1, rows: [[-1, 1], [-1, 1], [-1, 1]] },
  1: { top: 1, rows: [[-2, 2], [-2, 2], [-2, 2]] },
  2: { top: 3, rows: [[-1, 1], [-1, 1], [-3, 3], [-3, 3], [-3, 3], [-1, 1], [-1, 1]] },
  4: { top: 5, rows: [[-1, 1], [-1, 3], [-4, 3], [-4, 4], [-5, 4], [-5, 4], [-5, 3], [-4, 3], [-4, 2], [-2, 2]] },
  7: {
    top: 8,
    rows: [[-1, 1], [-1, 3], [-4, 5], [-6, 5], [-6, 5], [-7, 6], [-7, 6], [-8, 8], [-8, 8], [-8, 8], [-7, 7], [-7, 7], [-7, 6], [-5, 6], [-5, 3],
      [-3, 3], [-1, 1]],
  },
};

/** The corners round a cliff brush's centre (offsets in corners, y north) that the World Editor's cliff brush gives the
 *  cliff type, whether or not a cliff touches them: its Level, Increase One and Decrease One alike, also where the
 *  brush moved nothing (we-compare cliff-type-stencil and ramp-cliff-brush-up3, 2026-11-14, branch cliff-type-we:
 *  Level on flat.w3x, Increase and Decrease beside plateau.w3x's plateau). Measured per size: 1, the 3×3 round the
 *  centre; 2, 5 wide and 3 high (not the brush's cross); 3, a plus of two bars 3 corners wide reaching 3 out (the
 *  plateau's corners 2 and 3 rows above a size-3 Increase One below it got the type); 5 and 8, the irregular shapes in
 *  CLIFF_TYPE_ROWS, the same wherever they were stamped on flat ground (two places each, size 5 at five pointer
 *  positions on one corner). Beside an edited cliff the editor's size-5 and size-8 shapes differ by a few rim corners
 *  from these. Other sizes (the editor has none) and the square brush: the 3×3 round each corner of the brush. */
export function cliffTypeStencil(radius: number, square = false): [number, number][] {
  const table = square ? undefined : CLIFF_TYPE_ROWS[radius];
  if (table) return table.rows.flatMap(([x0, x1], k) => Array.from({ length: x1 - x0 + 1 }, (_, j) => [x0 + j, table.top - k] as [number, number]));
  const out = new Map<string, [number, number]>();
  for (let y = -radius - 1; y <= radius + 1; y++) for (let x = -radius - 1; x <= radius + 1; x++) {
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) {
      const bx = x + dx, by = y + dy;
      near = square ? Math.abs(bx) <= radius && Math.abs(by) <= radius : bx * bx + by * by <= radius * radius;
    }
    if (near) out.set(`${x},${y}`, [x, y]);
  }
  return [...out.values()];
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
    const cell = (k: number, s: number): [number, number] => along[0] ? [start[0] + along[0] * s, centre + k] : [centre + k, start[1] + along[1] * s];
    // A row whose middle corner isn't on the low layer is where the cliff bends (a corner sticking out of it). A
    // ramp can't end beside one: its side piece's far edge falls one corner earlier than the cliff it meets, and
    // that leaves a hole in the ground, black from the side. So the rows beside a bend don't fit.
    const bend = (k: number) => { const c = at(...cell(k, 1)); return !!c && c.layer !== lo; };
    const rows: [number, number][][] = [];
    for (let k = -halfWidth; k <= halfWidth; k++) {
      const row: [number, number][] = [];
      let fits = true;
      for (let s = 0; s < 3; s++) {
        const [cx, cy] = cell(k, s);
        const c = at(cx, cy);
        if (!c) { if (!asFarAsPossible) return "The ramp would leave the map."; fits = false; break; }
        if (c.layer !== (s === 0 ? hi : lo)) {
          if (!asFarAsPossible) return "The cliff isn't straight and level enough here for a ramp this wide (try a smaller Size).";
          fits = false;
          break;
        }
        row.push([cx, cy]);
      }
      if (fits && (bend(k - 1) || bend(k + 1))) {
        if (!asFarAsPossible) return "The cliff isn't straight and level enough here for a ramp this wide (try a smaller Size).";
        fits = false;
      }
      rows.push(fits ? row : []);
    }
    const run = widestRun(rows.map((r) => r.length > 0), halfWidth);
    if (!run) return "The cliff isn't straight and level enough here for a ramp.";
    return rows.slice(run[0], run[1] + 1).flat();
  }

}

/** What a click of the Ramp tool did: built (or added to) a ramp, took one off, or nothing (`problem` says why, if
 *  there's something to say). */
export interface RampClick { done: "built" | "removed" | "none"; problem?: string }

/** The Ramp tool's click at world (wx, wy), as the World Editor's (we-drive 2026-11-14, specs ramp-*.json): the
 *  corner nearest the click decides, and the brush size doesn't matter. On the high corner of a one-level cliff it
 *  flags a line of three corners down the cliff, that corner and the two below it; on the corner just below a high
 *  one (the middle of such a line) the same line. On a plateau's corner, where the cliff falls away on two sides,
 *  both lines and the corners between them (a 3×3 block). A line beside a bend in the cliff (the next line's middle
 *  corner isn't on the low layer) isn't built: a ramp's side piece can't end there. A wider ramp is more clicks,
 *  or a drag, along the edge. A click on a line that is a ramp already does nothing in the World Editor; here it
 *  takes off the ramp it belongs to (all flagged corners joined to it), unless `keep` (a drag going over it). */
export function rampClick(t: Terrain, wx: number, wy: number, stroke: CornerLog, keep = false): RampClick {
  const cx = Math.round((wx - t.offsetX) / 128), cy = Math.round((wy - t.offsetY) / 128);
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < t.width && y < t.height ? t.corners[y * t.width + x] : null);
  const c = at(cx, cy);
  if (!c) return { done: "none", problem: "Outside the map." };
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  /** The line from high corner (hx, hy) down the cliff in direction d, or null if it doesn't fit there. */
  const line = (hx: number, hy: number, [dx, dy]: [number, number]): [number, number][] | null => {
    const hi = at(hx, hy)?.layer;
    if (hi === undefined) return null;
    const cells: [number, number][] = [[hx, hy], [hx + dx, hy + dy], [hx + 2 * dx, hy + 2 * dy]];
    if (cells.slice(1).some(([x, y]) => at(x, y)?.layer !== hi - 1)) return null;
    // The lines on either side: their middle corner on the low layer too, or the cliff bends there.
    for (const s of [1, -1]) {
      const m = at(hx + dx + s * dy, hy + dy + s * dx);
      if (m && m.layer !== hi - 1) return null;
    }
    return cells;
  };
  const found: [number, number][][] = [];
  const down: [number, number][] = [];
  for (const d of dirs) {
    const l = line(cx, cy, d);
    if (l) { found.push(l); down.push(d); }
  }
  // A plateau's corner: the lines down both sides, and the corners between them.
  const ax = down.find((d) => d[0] !== 0), ay = down.find((d) => d[1] !== 0);
  if (ax && ay) {
    for (let i = 1; i <= 2; i++) for (let j = 1; j <= 2; j++) {
      const x = cx + i * ax[0], y = cy + j * ay[1];
      if (at(x, y)?.layer === c.layer - 1) found.push([[x, y]]);
    }
  }
  // The corner below a high one: the line through it.
  for (const [dx, dy] of dirs) {
    if (at(cx - dx, cy - dy)?.layer !== c.layer + 1) continue;
    const l = line(cx - dx, cy - dy, [dx, dy]);
    if (l) found.push(l);
  }
  if (!found.length) {
    const near = dirs.map(([dx, dy]) => at(cx + dx, cy + dy)).filter((n): n is Corner => !!n);
    if (near.some((n) => Math.abs(n.layer - c.layer) > 1)) return { done: "none", problem: "Ramps only work on cliffs one level high; this one is higher." };
    if (near.some((n) => n.layer !== c.layer)) return { done: "none", problem: "The cliff isn't straight here: click its edge where it runs straight for a ramp." };
    return { done: "none", problem: "Click a cliff one level high to build a ramp." };
  }
  const cells = found.flat();
  if (cells.every(([x, y]) => at(x, y)!.ramp)) {
    if (keep) return { done: "none" };
    // Take off the ramp: every flagged corner joined to these.
    const todo = [...cells], seen = new Set<number>();
    while (todo.length) {
      const [x, y] = todo.pop()!;
      const k = at(x, y);
      if (!k?.ramp || seen.has(y * t.width + x)) continue;
      seen.add(y * t.width + x);
      stroke.touch(t, y * t.width + x);
      k.ramp = false;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j) todo.push([x + i, y + j]);
    }
    return { done: "removed" };
  }
  for (const [x, y] of cells) {
    const k = at(x, y)!;
    if (k.ramp) continue;
    stroke.touch(t, y * t.width + x);
    k.ramp = true;
  }
  return { done: "built" };
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
 *  ramp models (planCliffs); the pathing map blocks them as cliffs (the flat tile not everywhere: generatePathing). */
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

/** After corners moved to another cliff level (`before`: corner index to its level before the move), the ramp runs
 *  through them that no longer climb are taken off, as the World Editor's cliff brush does (we-compare ramp-cliff-brush,
 *  2026-11-14, plateau.w3x's south face with ramp lines of three corners, low, low, high):
 *  - a run is an unbroken line of ramp-flagged corners along x or along y; one that climbed one level before (its
 *    levels spanned exactly 1) and spans 0 or 2 after loses all its flags, also on corners the move didn't touch (the
 *    high corner raised: 2,2,4; lowered: 2,2,2; the two low ones raised: 3,3,3);
 *  - one that still climbs one level keeps them (the middle corner raised: 2,3,3), and so do runs across the ramp,
 *    which are level (the rows of a wide ramp beside a column it lost).
 *  Left as they were, such flags make ramp tiles across two levels, which the editor draws with holes (black wedges).
 *  Returns the corners whose flag it cleared, each touched in `log` first. */
export function dropBrokenRamps(t: Terrain, before: ReadonlyMap<number, number>, log: CornerLog): number[] {
  const flagged = (x: number, y: number) => x >= 0 && y >= 0 && x < t.width && y < t.height && t.corners[y * t.width + x].ramp;
  const drop = new Set<number>();
  const seen = new Set<string>();
  for (const i of before.keys()) {
    if (!t.corners[i].ramp) continue;
    const x0 = i % t.width, y0 = Math.floor(i / t.width);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      let sx = x0, sy = y0;
      while (flagged(sx - dx, sy - dy)) { sx -= dx; sy -= dy; }
      const key = `${dx}:${sx},${sy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const run: number[] = [];
      for (let x = sx, y = sy; flagged(x, y); x += dx, y += dy) run.push(y * t.width + x);
      if (run.length < 2) continue;
      const span = (level: (k: number) => number) => {
        const ls = run.map(level);
        return Math.max(...ls) - Math.min(...ls);
      };
      if (span((k) => before.get(k) ?? t.corners[k].layer) === 1 && span((k) => t.corners[k].layer) !== 1) for (const k of run) drop.add(k);
    }
  }
  for (const k of drop) {
    log.touch(t, k);
    t.corners[k].ramp = false;
  }
  return [...drop];
}

/** After a block of corners moved by cliff levels (`before`: corner index to its level before the move), every ramp
 *  (corners joined by flags, side by side) the move didn't carry whole, with the ground round it, loses its flags:
 *  the ramp itself and its 8 neighbours must all have moved by the same number of levels, or it no longer meets the
 *  ground it was built between. Last Refuge's ramp cut by the Area panel's Level ±1 (2026-11-14) kept its flags with
 *  the levels changed under part of it or beside it, which the World Editor draws with holes (black wedges) for that
 *  w3e as Studio did; even the whole ramp raised with a cliff left beside it was one. Plain cliffs draw everywhere
 *  (set_cliffs takes ramps away alike). Returns the corners whose flag it cleared, each touched in `log` first. */
export function dropCutRamps(t: Terrain, before: ReadonlyMap<number, number>, log: CornerLog): number[] {
  const delta = (k: number) => (before.has(k) ? t.corners[k].layer - (before.get(k) as number) : 0);
  const near = (k: number) => {
    const x = k % t.width, y = Math.floor(k / t.width), out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < t.width && ny < t.height) out.push(ny * t.width + nx);
    }
    return out;
  };
  const side = (k: number) => near(k).filter((n) => n % t.width === k % t.width || Math.floor(n / t.width) === Math.floor(k / t.width));
  const seen = new Set<number>(), drop: number[] = [];
  for (const i of before.keys()) {
    for (const start of [i, ...near(i)]) {
      if (seen.has(start) || !t.corners[start].ramp) continue;
      const group: number[] = [], todo = [start];
      seen.add(start);
      while (todo.length) {
        const k = todo.pop() as number;
        group.push(k);
        for (const n of side(k)) if (!seen.has(n) && t.corners[n].ramp) { seen.add(n); todo.push(n); }
      }
      const by = delta(group[0]);
      if (group.every((k) => delta(k) === by && near(k).every((n) => delta(n) === by))) continue;
      drop.push(...group);
    }
  }
  for (const k of drop) {
    log.touch(t, k);
    t.corners[k].ramp = false;
  }
  return drop;
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
