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
      if (a.rawHeight !== b.rawHeight || a.texture !== b.texture || a.variation !== b.variation
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
