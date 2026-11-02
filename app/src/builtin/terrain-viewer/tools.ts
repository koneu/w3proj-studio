// Terrain brushes: height (raise, lower, plateau, smooth) and ground texture
// painting, applied to the corners inside a circular brush, with undo.

import { groundHeight, setGroundHeight, setLayer, WATER_OFFSET, type Corner, type Terrain } from "./w3e";

export type HeightTool = "raise" | "lower" | "plateau" | "smooth";
/** Cliff layer up/down; water: shallow (one layer down), deep (two), dry. */
export type LayerTool = "cliffUp" | "cliffDown" | "shallow" | "deep" | "dry";

/** What a layer stroke sets, decided where the stroke starts: the cliff
 *  layer, and for new water its stored level word (low 14 bits). */
export interface LayerTarget {
  layer: number;
  waterLevel?: number;
}

export interface Brush {
  /** World position of the brush centre. */
  x: number;
  y: number;
  /** Radius in tiles. */
  radius: number;
}

/** Corners inside the brush with a weight (1 in the middle, 0 at the rim). */
function cornersIn(t: Terrain, b: Brush): { i: number; w: number }[] {
  const r = b.radius * 128;
  const out: { i: number; w: number }[] = [];
  const x0 = Math.max(0, Math.floor((b.x - r - t.offsetX) / 128)), x1 = Math.min(t.width - 1, Math.ceil((b.x + r - t.offsetX) / 128));
  const y0 = Math.max(0, Math.floor((b.y - r - t.offsetY) / 128)), y1 = Math.min(t.height - 1, Math.ceil((b.y + r - t.offsetY) / 128));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(t.offsetX + x * 128 - b.x, t.offsetY + y * 128 - b.y);
    if (d > r) continue;
    // Smooth falloff so repeated strokes don't leave terraces.
    const w = Math.cos((d / r) * (Math.PI / 2)) ** 2;
    out.push({ i: y * t.width + x, w: Math.max(w, 0.15) });
  }
  return out;
}

/** Records corner states before a stroke changes them, for undo/redo. */
export class Stroke {
  private before = new Map<number, Corner>();
  private after = new Map<number, Corner>();

  constructor(readonly label: string) {}

  /** Indices of the corners the stroke changed (or touched). */
  corners(): number[] {
    return [...this.before.keys()];
  }

  touch(t: Terrain, i: number) {
    if (!this.before.has(i)) this.before.set(i, { ...t.corners[i] });
  }

  /** Call when the stroke ends; false if nothing changed. */
  finish(t: Terrain): boolean {
    for (const i of this.before.keys()) this.after.set(i, { ...t.corners[i] });
    for (const [i, b] of this.before) {
      const a = this.after.get(i)!;
      if (a.rawHeight !== b.rawHeight || a.texture !== b.texture || a.variation !== b.variation || a.ramp !== b.ramp || a.blight !== b.blight
        || a.layer !== b.layer || a.hasWater !== b.hasWater || a.rawWater !== b.rawWater) return true;
    }
    return false;
  }

  undo(t: Terrain) {
    for (const [i, c] of this.before) t.corners[i] = { ...c };
  }

  redo(t: Terrain) {
    for (const [i, c] of this.after) t.corners[i] = { ...c };
  }
}

/** One application of a height brush. `amount` is world units at the centre
 *  (raise/lower), the target height (plateau) or ignored (smooth). Returns
 *  whether anything changed. */
export function applyHeight(t: Terrain, b: Brush, tool: HeightTool, amount: number, stroke: Stroke): boolean {
  const cs = cornersIn(t, b);
  if (!cs.length) return false;
  const before = cs.map(({ i }) => groundHeight(t.corners[i]));
  cs.forEach(({ i, w }, k) => {
    const c = t.corners[i];
    let h = before[k];
    if (tool === "raise") h += amount * w;
    else if (tool === "lower") h -= amount * w;
    else if (tool === "plateau") h += (amount - h) * Math.min(1, w * 1.5);
    else {
      // Average of the 3×3 neighbourhood, blended by the brush weight.
      const x = i % t.width, y = Math.floor(i / t.width);
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height) continue;
        sum += groundHeight(t.corners[ny * t.width + nx]);
        n++;
      }
      h += (sum / n - h) * w * 0.5;
    }
    stroke.touch(t, i);
    setGroundHeight(c, h);
  });
  return true;
}

/** One application of a cliff or water brush: corners under the brush move
 *  to the target layer; water tools also set the water flag and level, dry
 *  only clears the flag. Returns whether anything changed. */
export function applyLayer(t: Terrain, b: Brush, tool: LayerTool, target: LayerTarget, stroke: Stroke): boolean {
  let changed = false;
  for (const { i } of cornersIn(t, b)) {
    const c = t.corners[i];
    if (tool === "dry") {
      if (!c.hasWater) continue;
      stroke.touch(t, i);
      c.hasWater = false;
      changed = true;
      continue;
    }
    const water = tool === "shallow" || tool === "deep";
    if (c.layer === target.layer && (!water || (c.hasWater && (c.rawWater & 0x3fff) === target.waterLevel))) continue;
    stroke.touch(t, i);
    setLayer(c, target.layer);
    if (water && target.waterLevel !== undefined) setWaterLevel(c, target.waterLevel);
    changed = true;
  }
  return changed;
}

/** Marks a corner as water with a stored level (keeping the word's unknown high bits). */
function setWaterLevel(c: Corner, level: number) {
  c.hasWater = true;
  c.rawWater = (c.rawWater & 0xc000) | (level & 0x3fff);
  c.water = (level - 0x2000) / 4 - WATER_OFFSET;
}

/** The stored water level word that puts the surface at world height `z`. */
export function waterLevelAt(z: number): number {
  return Math.max(0, Math.min(0x3fff, Math.round((z + WATER_OFFSET) * 4) + 0x2000));
}

/** Paints ground texture `tex` (index into terrain.groundTiles) under the brush. */
export function paintTexture(t: Terrain, b: Brush, tex: number, stroke: Stroke): boolean {
  let changed = false;
  for (const { i } of cornersIn(t, b)) {
    const c = t.corners[i];
    if (c.texture === tex) continue;
    stroke.touch(t, i);
    c.texture = tex;
    c.variation = randomVariation();
    changed = true;
  }
  return changed;
}

/** Ground variation for freshly painted corners: mostly the plain full tiles
 *  (16, 17+), sometimes one of the extended variations (0–15). Textures that
 *  have no extended part show plain tiles for all of these. */
function randomVariation(): number {
  const r = Math.random();
  if (r < 0.6) return 16;
  if (r < 0.85) return 17;
  return Math.floor(Math.random() * 16);
}

/** Ramp tool, one click at world (wx, wy): on a one-layer cliff tile the
 *  corners along the slope get the ramp flag (the high end and two corners
 *  on the lower layer, `2 * halfWidth + 1` corners across, as World Editor
 *  ramps are); on a tile that already has ramp corners the ramp there is
 *  removed. Returns a message when nothing could be done. */
export function toggleRamp(t: Terrain, wx: number, wy: number, halfWidth: number, stroke: Stroke): string | null {
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

/** Adds (on) or removes blight under the brush. */
export function paintBlight(t: Terrain, b: Brush, on: boolean, stroke: Stroke): boolean {
  let changed = false;
  for (const { i } of cornersIn(t, b)) {
    const c = t.corners[i];
    if (c.blight === on) continue;
    stroke.touch(t, i);
    c.blight = on;
    changed = true;
  }
  return changed;
}
