// Terrain brushes: height (raise, lower, plateau, smooth, noise) and ground texture
// painting, applied to the corners inside a round or square brush, with undo.

import { matchCliffTypes } from "../../lib/terrain/cliffs";
import { flattenWaterRim } from "../../lib/terrain/waterrim";
import { groundHeight, randomVariation, setGroundHeight, setLayer, setWaterLevel, waterOffsetOf, type Corner, type Terrain } from "../../lib/terrain/w3e";

export { matchCliffTypes, toggleRamp } from "../../lib/terrain/cliffs";

export type HeightTool = "raise" | "lower" | "plateau" | "smooth" | "noise";
/** Cliff layer up/down by one or two, level (the start's layer); water: shallow (one layer
 *  down), deep (two), dry. */
export type LayerTool = "cliffUp" | "cliffUp2" | "cliffDown" | "cliffDown2" | "cliffLevel" | "shallow" | "deep" | "dry";

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
  /** Radius in tiles (half the side of a square brush). */
  radius: number;
  square?: boolean;
  /** The corners on the rim (radius tiles out) are left out: the height brushes fade to nothing there. */
  open?: boolean;
}

/** The World Editor's brush of a size (the toolbar's Size, as the World Editor's brush size) at a ground point, for its
 *  cliff, water and ground texture brushes: centred on the nearest corner, it takes the corners up to size − 1 tiles
 *  from it, so size 1 is that corner alone, size 2 it and the 4 next to it (a cross), size 3 the 13 within two.
 *  we-drive, one click each on a flat empty Lordaeron map: Shallow Water sizes 1, 2, 3 took 1, 5, 13 corners
 *  (2026-11-12, verify round 2, C3; tests/fixtures/water-brush); Raise One sizes 1, 2, 3, 5, 8 1, 5, 13, 49, 149
 *  (verify round 3 item 7), and a grass texture the same 1, 5, 13, 49, 149 (2026-11-13, verify3-we-diffs): the corners
 *  within a circle of radius size − 1. The square shape wasn't seen: a square of that half side. */
export function cornerBrush(t: Pick<Terrain, "offsetX" | "offsetY">, x: number, y: number, size: number, square = false): Brush {
  const snap = (v: number, o: number) => o + Math.round((v - o) / 128) * 128;
  return { x: snap(x, t.offsetX), y: snap(y, t.offsetY), radius: Math.max(0, Math.round(size) - 1), square };
}

const HEIGHT_TOOLS: ReadonlySet<string> = new Set<HeightTool>(["raise", "lower", "plateau", "smooth", "noise"]);

/** The brush a painter tool puts down for a pointer at (x, y) and the toolbar's Size (not Ramp's, which goes by the
 *  cliff): the World Editor's corner brush (cornerBrush). The height brushes leave its rim out: the World Editor's
 *  Raise (we-drive, one click each on flat ground, 2026-11-13, verify3-we-diffs) changed 1, 1, 9, 45, 145 corners at
 *  sizes 1, 2, 3, 5, 8, the corners strictly inside radius size − 1 round the nearest corner (size 1: that corner),
 *  fading to nothing at the rim. Cliffs, water and the ground textures (Blight and Boundary are tiles of its texture
 *  palette) take the rim too. */
export function brushOf(tool: string, t: Pick<Terrain, "offsetX" | "offsetY">, x: number, y: number, size: number, square = false): Brush {
  const b = cornerBrush(t, x, y, size, square);
  return HEIGHT_TOOLS.has(tool) ? { ...b, open: true } : b;
}

/** How far out the brush's outline is drawn, in world units: half a tile past the outermost corners it takes. */
export function brushReach(b: Brush): number {
  return (b.open ? Math.max(b.radius - 0.5, 0.5) : b.radius + 0.5) * 128;
}

/** Corners inside the brush with a weight (1 in the middle, 0 at the rim). */
function cornersIn(t: Terrain, b: Brush): { i: number; w: number }[] {
  const r = b.radius * 128;
  const out: { i: number; w: number }[] = [];
  const x0 = Math.max(0, Math.floor((b.x - r - t.offsetX) / 128)), x1 = Math.min(t.width - 1, Math.ceil((b.x + r - t.offsetX) / 128));
  const y0 = Math.max(0, Math.floor((b.y - r - t.offsetY) / 128)), y1 = Math.min(t.height - 1, Math.ceil((b.y + r - t.offsetY) / 128));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = t.offsetX + x * 128 - b.x, dy = t.offsetY + y * 128 - b.y;
    const d = b.square ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
    if (d > r || (b.open && r > 0 && d >= r)) continue;
    // Smooth falloff so repeated strokes don't leave terraces.
    const w = r > 0 ? Math.cos((d / r) * (Math.PI / 2)) ** 2 : 1;
    out.push({ i: y * t.width + x, w: Math.max(w, 0.15) });
  }
  return out;
}

/** Records corner states before a stroke changes them, for undo/redo. */
export class Stroke {
  private before = new Map<number, Corner>();
  private after = new Map<number, Corner>();
  /** Corners the brush went over, changed or not. */
  private covered = new Set<number>();
  /** Corners a water brush turned into water: they take the cliff type (retypeCliffs). */
  readonly wet = new Set<number>();

  constructor(readonly label: string) {}

  /** Indices of the corners the stroke changed (or touched). */
  corners(): number[] {
    return [...this.before.keys()];
  }

  cover(i: number) { this.covered.add(i); }
  /** The changed corners and those the brush only went over (painting a tile already there). */
  area(): number[] {
    return [...new Set([...this.before.keys(), ...this.covered])];
  }

  touch(t: Terrain, i: number) {
    if (!this.before.has(i)) this.before.set(i, { ...t.corners[i] });
  }

  /** Call when the stroke ends; false if nothing changed. */
  finish(t: Terrain): boolean {
    for (const i of this.before.keys()) this.after.set(i, { ...t.corners[i] });
    for (const [i, b] of this.before) {
      const a = this.after.get(i)!;
      if (a.rawHeight !== b.rawHeight || a.texture !== b.texture || a.variation !== b.variation || a.ramp !== b.ramp || a.blight !== b.blight || a.boundary !== b.boundary
        || a.layer !== b.layer || a.hasWater !== b.hasWater || a.rawWater !== b.rawWater || a.cliffTexture !== b.cliffTexture) return true;
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
 *  (raise/lower), the most a corner moves up or down (noise: each corner by its own
 *  random share, from `random`), the target height (plateau) or ignored (smooth).
 *  Returns whether anything changed. */
export function applyHeight(t: Terrain, b: Brush, tool: HeightTool, amount: number, stroke: Stroke, random: () => number = Math.random): boolean {
  const cs = cornersIn(t, b);
  if (!cs.length) return false;
  const before = cs.map(({ i }) => groundHeight(t.corners[i]));
  cs.forEach(({ i, w }, k) => {
    const c = t.corners[i];
    let h = before[k];
    if (tool === "raise") h += amount * w;
    else if (tool === "lower") h -= amount * w;
    else if (tool === "plateau") h += (amount - h) * Math.min(1, w * 1.5);
    else if (tool === "noise") h += (random() * 2 - 1) * amount * w;
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
  const inside = cornersIn(t, b);
  if (tool === "shallow" || tool === "deep") {
    // As the World Editor does, the ground two corners round the new water is levelled first.
    const wet = inside.map(({ i }) => i).filter((i) => {
      const c = t.corners[i];
      return !(c.layer === target.layer && c.hasWater && (c.rawWater & 0x3fff) === target.waterLevel);
    });
    if (flattenWaterRim(t, wet, new Set(inside.map(({ i }) => i)), (i) => stroke.touch(t, i)).length) changed = true;
  }
  for (const { i } of inside) {
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
    if (water && target.waterLevel !== undefined) setWaterLevel(c, target.waterLevel, waterOffsetOf(t));
    if (water) stroke.wet.add(i);
    changed = true;
  }
  return changed;
}

/** After a stroke: cliffs next to what it changed take the cliff type `chosen` (the palette's) or that of their
 *  ground tile, and so do the corners a water brush turned into water (matchCliffTypes). Whether a corner changed. */
export function retypeCliffs(t: Terrain, stroke: Stroke, cliffGround: string[], chosen?: number): boolean {
  return matchCliffTypes(t, stroke.area(), cliffGround, stroke, chosen, stroke.wet);
}


/** Paints ground texture `tex` (index into terrain.groundTiles) under the brush. */
export function paintTexture(t: Terrain, b: Brush, tex: number, stroke: Stroke): boolean {
  let changed = false;
  for (const { i } of cornersIn(t, b)) {
    stroke.cover(i);
    const c = t.corners[i];
    if (c.texture === tex) continue;
    stroke.touch(t, i);
    c.texture = tex;
    c.variation = randomVariation();
    changed = true;
  }
  return changed;
}

/** Adds (on) or removes blight under the brush. */
/** Paints or removes Boundary: the World Editor's unplayable tiles, a flag that leaves the ground as it is. */
export function paintBoundary(t: Terrain, b: Brush, on: boolean, stroke: Stroke): boolean {
  let changed = false;
  for (const { i } of cornersIn(t, b)) {
    const c = t.corners[i];
    if (c.boundary === on) continue;
    stroke.touch(t, i);
    c.boundary = on;
    changed = true;
  }
  return changed;
}

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
