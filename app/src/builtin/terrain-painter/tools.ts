// Terrain brushes: height (raise, lower, plateau, smooth, noise) and ground texture
// painting, applied to the corners inside a round or square brush, with undo.

import { cliffTypeStencil, dropBrokenRamps, matchCliffTypes } from "../../lib/terrain/cliffs";
import { liftToFloor, waterBasin } from "../../lib/terrain/waterrim";
import { groundHeight, rampLift, randomVariation, setGroundHeight, setLayer, setWaterLevel, waterLevelAt, waterOffsetOf, WATER_OFFSET, type Corner, type Terrain } from "../../lib/terrain/w3e";

export { matchCliffTypes, rampClick } from "../../lib/terrain/cliffs";

export type HeightTool = "raise" | "lower" | "plateau" | "smooth" | "noise";
/** Cliff layer up/down by one or two, level (the start's layer); water: shallow (one layer
 *  down), deep (two), dry. */
export type LayerTool = "cliffUp" | "cliffUp2" | "cliffDown" | "cliffDown2" | "cliffLevel" | "shallow" | "deep" | "dry";

const LAYER_TOOLS: ReadonlySet<string> = new Set<LayerTool>(["cliffUp", "cliffUp2", "cliffDown", "cliffDown2", "cliffLevel", "shallow", "deep", "dry"]);
const CLIFF_TOOLS: ReadonlySet<string> = new Set<LayerTool>(["cliffUp", "cliffUp2", "cliffDown", "cliffDown2", "cliffLevel"]);

/** What a layer stroke sets, decided where the stroke starts: the cliff
 *  layer, and for new water its stored level word (low 14 bits). */
export interface LayerTarget {
  layer: number;
  waterLevel?: number;
  /** The cliff level where the stroke started (water: one or two above `layer`, unless that went below 0). */
  start?: number;
  /** The palette's cliff type (water: whether the corners round the new water come to its level, waterBasin). */
  cliffType?: number;
}

const LAYER_STEPS: Partial<Record<LayerTool, number>> = { cliffUp: 1, cliffUp2: 2, cliffDown: -1, cliffDown2: -2, shallow: -1, deep: -2 };

/** The cliff level a cliff or water stroke sets, from the level `start` of the corner it starts on, or null when the
 *  brush does nothing there. The World Editor's Decrease One and Decrease Two do nothing at all when the level they
 *  would set is below 0: from a pit's floor at level 0 (Decrease One, Decrease Two) and from level 1 (Decrease Two)
 *  no corner moved and none was typed, at the pit's middle and on the floor's rim, with or without a tile picked
 *  beside it (we-compare cliff-floor and painted-cliff-type-grass, 2026-11-14, branch painted-cliff-type-we). Studio
 *  used to lower the whole brush to level 0 there. A water brush whose level would be below 0 lowers nothing: the
 *  corners turn wet on the level they are on (waterBelowFloor), so the level returned is the start's. Past the top,
 *  Increase does nothing with the map's Enforce Terrain Limits on (`enforceLimits`) and wraps round without it
 *  (ENFORCED_TOP_LEVEL). */
export function strokeLayer(tool: LayerTool, start: number, enforceLimits = false): number | null {
  const to = start + (LAYER_STEPS[tool] ?? 0);
  if (to < 0 && (tool === "cliffDown" || tool === "cliffDown2")) return null;
  if (waterBelowFloor(tool, start)) return start;
  if (tool === "cliffUp" || tool === "cliffUp2") {
    if (enforceLimits && to > ENFORCED_TOP_LEVEL) return null;
    if (to > 15) return to & 15;
  }
  return Math.max(0, Math.min(15, to));
}

/** The highest cliff level Increase One and Two build with the map's Enforce Terrain Limits on. The World Editor's
 *  Increase did nothing at all where it would have gone higher (we-drive, flat maps of one level, one size-1 click,
 *  2026-11-15, branch cliff-slope-we): Increase One from 14 and Two from 13 and 14 changed no corner, One from 13 and
 *  Two from 12 built level 14. With the switch off (the default) the level wraps round past 15 as its 4 bits do:
 *  Increase Two from 14 and One from 15 set the brush to level 0 and the slope round it climbed back to the plateau
 *  (cliffSlope), the "cap" of 12 a size-3 brush clicked ten times on one pixel seemed to have (we-compare
 *  limits-off-cliff-cap): the pointer's corner moves down the growing slope, and a click on the top wraps it. */
export const ENFORCED_TOP_LEVEL = 14;

/** The World Editor's cliff slope: after a cliff brush set its corners (`brush`), each corner beside or diagonal to
 *  one that moved comes to within two levels of it, and so on outwards until nothing moves (the brush's own corners
 *  stay). we-drive, 2026-11-15, branch cliff-slope-we: Increase Two clicked ten times on one pixel of flat.w3x, saved
 *  after each click, left square rings 2, 4, 6, … round a size-1 brush and the brush's disc grown by one corner each
 *  way per ring at size 3, every save the stamp of one corner (tools.test.ts); a brush wrapped to level 0 on a level-14
 *  field (Increase Two from 14) left a pit 0, 2, 4, … 12 in square rings (we-compare cliff-slope-wrap). `moved(i,
 *  from, first)` is called before corner i changes (from: its level then; first: it is beside the brush). */
export function cliffSlope(t: Terrain, brush: readonly number[], moved: (i: number, from: number, first: boolean) => void): void {
  const inBrush = new Set(brush);
  const queue = [...brush];
  // Each change moves a corner towards a level its neighbour already has; the bound only guards a terrain that could
  // keep two corners trading places (none is known): every corner may change a few times over.
  const most = brush.length + 16 * t.width * t.height;
  for (let k = 0; k < queue.length && k < most; k++) {
    const i = queue[k], level = t.corners[i].layer;
    const x = i % t.width, y = Math.floor(i / t.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, n = ny * t.width + nx;
      if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height || inBrush.has(n)) continue;
      const c = t.corners[n];
      const to = Math.max(level - 2, Math.min(level + 2, c.layer));
      if (to === c.layer) continue;
      moved(n, c.layer, k < brush.length);
      setLayer(c, to);
      queue.push(n);
    }
  }
}

/** What a cliff or water stroke started on corner (x, y) sets, or null when it does nothing there (strokeLayer). Cliff
 *  tools step one level from the start point; water goes one or two levels below it, with the surface the water offset
 *  (89.6) under its original ground, as the World Editor does: its shallow water is 38.4 deep, deep water 166.4 (12 game
 *  maps). On a ramp's middle corner the water goes by the ramp's height, half a level up (rampLift): the editor's word
 *  was 256 more there (we-compare water-ramp-below, 2026-11-14, branch water-brush-we2). `cliffType`: the palette's. */
export function layerTarget(t: Terrain, tool: LayerTool, x: number, y: number, cliffType?: number, enforceLimits = false): LayerTarget | null {
  const c = t.corners[y * t.width + x];
  const layer = strokeLayer(tool, c.layer, enforceLimits);
  if (layer === null) return null;
  return { layer, waterLevel: waterLevelAt(c.height + rampLift(t, x, y) - WATER_OFFSET), start: c.layer, cliffType };
}

/** Whether a Shallow or Deep stroke started on cliff level `start` would put its water below level 0. The World
 *  Editor's brush then only makes its corners wet where they are: Shallow on a level-0 pit floor, Deep on level 0 and
 *  on level 1 left the clicked corner on its level, wet, with its own water word, and changed nothing round it: no
 *  corner lowered, retyped or given the water word (we-compare water-level0-shallow, water-level0-deep,
 *  water-level1-deep, 2026-11-14, branch water-brush-we2; Studio used to lower to level 0 and run waterBasin). */
export function waterBelowFloor(tool: LayerTool, start: number): boolean {
  return (tool === "shallow" || tool === "deep") && start + (LAYER_STEPS[tool] ?? 0) < 0;
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
 *  within a circle of radius size − 1. The square shape is the square of that half side (we-compare brush-square,
 *  2026-11-15: Grass sizes 3 and 5 took 5 × 5 and 9 × 9 corners, Level, Increase One and Decrease One the same). */
export function cornerBrush(t: Pick<Terrain, "offsetX" | "offsetY">, x: number, y: number, size: number, square = false): Brush {
  const snap = (v: number, o: number) => o + Math.round((v - o) / 128) * 128;
  return { x: snap(x, t.offsetX), y: snap(y, t.offsetY), radius: Math.max(0, Math.round(size) - 1), square };
}

/** The height brushes that leave the rim out (Plateau and Smooth take it: discCorners). */
const OPEN_TOOLS: ReadonlySet<string> = new Set<HeightTool>(["raise", "lower", "noise"]);
const BOUNDARY_TOOLS: ReadonlySet<string> = new Set(["boundary", "unboundary"]);

/** The brush a painter tool puts down for a pointer at (x, y) and the toolbar's Size (not Ramp's, which goes by the
 *  cliff): the World Editor's corner brush (cornerBrush). Raise and Lower (and Noise) leave its rim out: the World
 *  Editor's Raise (we-drive, one click each on flat ground, 2026-11-13, verify3-we-diffs) changed 1, 1, 9, 45, 145
 *  corners at sizes 1, 2, 3, 5, 8, the corners strictly inside radius size − 1 round the nearest corner (size 1: that
 *  corner), fading to nothing at the rim. Plateau and Smooth, cliffs, water and the ground textures (Blight and
 *  Boundary are tiles of its texture palette) take the rim too. Boundary and Remove Boundary alone are centred on the lower-left corner of the tile
 *  under the pointer instead of the nearest corner (the World Editor flags the tile there): we-drive, 2026-11-14,
 *  branch boundary-we, 16 size-1 clicks at 0.2 to 0.8 of a tile in x and y each flagged that corner, and sizes 2, 3
 *  and 5 took 5, 13 and 49 corners round it (spec tests/we-compare/boundary-wpm.json). */
export function brushOf(tool: string, t: Pick<Terrain, "offsetX" | "offsetY">, x: number, y: number, size: number, square = false): Brush {
  const b = cornerBrush(t, x, y, size, square);
  if (BOUNDARY_TOOLS.has(tool)) {
    // A pointer on a corner line (the view's centre column is one) counts as the tile past it, as the editor's does:
    // the slack takes rounding in the pick.
    const down = (v: number, o: number) => o + Math.floor((v - o) / 128 + 1e-6) * 128;
    return { ...b, x: down(x, t.offsetX), y: down(y, t.offsetY) };
  }
  return OPEN_TOOLS.has(tool) ? { ...b, open: true } : b;
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
  /** Corners a cliff or water brush moved to another layer or turned into water, and those of the cliff brush's
   *  stencil (cliffTypeStencil): they take the cliff type though no cliff touches them (retypeCliffs). */
  readonly own = new Set<number>();
  /** Corners only the cliff slope moved (cliffSlope), not a brush: they take the cliff type, the corners round them
   *  don't (typingArea), but for `ring`'s. */
  readonly slope = new Set<number>();
  /** The slope's corners right beside a brush larger than size 1: the corners round them take the cliff type too. */
  readonly ring = new Set<number>();
  /** Corners a cliff brush of this stroke went over (they never count as the slope's). */
  readonly brushed = new Set<number>();

  constructor(readonly label: string) {}

  /** The corners whose cliff tiles round them take the cliff type after a cliff or water stroke (retypeCliffs): the
   *  area but the corners only the slope moved, past its first ring. we-drive, 2026-11-15, branch cliff-slope-we, the
   *  saves after each of ten Increase Two clicks on one pixel of flat.w3x: size 1 typed the slope's corners and none
   *  round them (all 10 saves as Studio's but one, 8 corners the next click typed anyway); size 3 typed the corners
   *  round the ring beside the brush too, not round the rings further out (all 10 but 2 corners, (±2, 4) from the
   *  second click's centre). The rule beyond these is not known. */
  typingArea(): number[] {
    return this.area().filter((i) => !this.slope.has(i) || this.ring.has(i));
  }

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

/** What one Raise or Lower stamp adds at the brush's centre per step of the brush size, in stored height units (a
 *  quarter of a world unit): 6.4 world units a size. */
export const RAISE_PER_SIZE = 25.6;

/** One Raise or Lower stamp, as the World Editor's: the corners strictly inside radius R = size − 1 round the brush's
 *  corner (size 1 and 2: that corner) move by 25.6 × size stored units × cos(π/2 · d / R), d their distance in tiles,
 *  and the stored word is rounded down after each stamp (a Lower of 76.8 makes −77, two Raises of 76.8 make 152).
 *  The brush shape doesn't count: the editor's Square raised the same disc. we-drive, flat.w3x, one click each
 *  (2026-11-15, branch raise-brush-we): centres 25, 51, 76, 128, 204 at sizes 1, 2, 3, 5, 8; size 5 at d = 1, √2, 2, √5,
 *  √8, 3, √10, √13: 118, 108, 90, 81, 56, 48, 41, 19; size 3 Lower −77, −55, −35; a second click adds as much again;
 *  a pointer held still adds nothing more. */
function raiseLower(t: Terrain, b: Brush, up: boolean, stroke: Stroke): boolean {
  const R = b.radius, amount = RAISE_PER_SIZE * (R + 1);
  const cx = Math.round((b.x - t.offsetX) / 128), cy = Math.round((b.y - t.offsetY) / 128);
  const reach = Math.max(0, Math.ceil(R) - 1);
  let changed = false;
  for (let y = Math.max(0, cy - reach); y <= Math.min(t.height - 1, cy + reach); y++) {
    for (let x = Math.max(0, cx - reach); x <= Math.min(t.width - 1, cx + reach); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > 0 && d >= R) continue;
      const delta = amount * (R > 0 ? Math.cos((Math.PI / 2) * (d / R)) : 1);
      const i = y * t.width + x;
      changed = setRaw(t, i, Math.floor(t.corners[i].rawHeight + (up ? delta : -delta)), stroke) || changed;
    }
  }
  return changed;
}

/** The corners of the World Editor's Plateau and Smooth brushes: within radius size − 1 of the brush's corner, the rim
 *  included, as its cliff brush (sizes 1, 2, 3, 5: 1, 5, 13, 49 corners), and unlike Raise and Lower they take the
 *  Square shape (size 3: the 5 × 5 square). we-drive, 2026-11-15. */
function discCorners(t: Terrain, b: Brush): number[] {
  const R = b.radius, reach = Math.floor(R);
  const cx = Math.round((b.x - t.offsetX) / 128), cy = Math.round((b.y - t.offsetY) / 128);
  const out: number[] = [];
  for (let y = Math.max(0, cy - reach); y <= Math.min(t.height - 1, cy + reach); y++) {
    for (let x = Math.max(0, cx - reach); x <= Math.min(t.width - 1, cx + reach); x++) {
      if (b.square || Math.hypot(x - cx, y - cy) <= R) out.push(y * t.width + x);
    }
  }
  return out;
}

/** Whether a tool's brush takes the Square shape: the World Editor's Raise and Lower raised a disc with it (raiseLower). */
export const takesShape = (tool: string) => tool !== "raise" && tool !== "lower" && tool !== "ramp";

/** Sets a corner's stored ground word, recording it for undo; whether it changed. */
function setRaw(t: Terrain, i: number, raw: number, stroke: Stroke): boolean {
  const c = t.corners[i];
  raw = Math.max(-0x8000, Math.min(0x7fff, raw));
  if (raw === c.rawHeight) return false;
  stroke.touch(t, i);
  c.rawHeight = raw;
  c.height = (raw - 0x2000) / 4 + (c.layer - 2) * 128;
  return true;
}

/** One Plateau stamp, as the World Editor's: every corner of the disc (discCorners) takes the stored ground word
 *  `target` (the corner the stroke started on). we-drive, 2026-11-15: size 3 one tile beside a size-5 Raise set the 13
 *  corners within two tiles to the clicked corner's 118, nothing between. */
function plateau(t: Terrain, b: Brush, target: number, stroke: Stroke): boolean {
  let changed = false;
  for (const i of discCorners(t, b)) changed = setRaw(t, i, target, stroke) || changed;
  return changed;
}

/** One Smooth stamp, as the World Editor's: each corner of the disc (discCorners) becomes 48/60 of itself, 2/60 of each
 *  corner beside it and 1/60 of each diagonal one, read before the stamp, rounded down (where the map ends, the
 *  weights there are left out). we-drive, 2026-11-15: a 255 spike smoothed by size 3 went to 204, its four
 *  neighbours to 8, its diagonals to 4, and a second click to 164, 13, 7; a size-5 Raise smoothed by size 3: 125, 115,
 *  105, 87 for 128, 118, 108, 90, the rim's 90 included, the corners past it untouched. */
function smooth(t: Terrain, b: Brush, stroke: Stroke): boolean {
  const ids = discCorners(t, b);
  const next = ids.map((i) => {
    const x = i % t.width, y = Math.floor(i / t.width);
    let sum = 0, weight = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height) continue;
      const w = dx === 0 && dy === 0 ? 48 : dx === 0 || dy === 0 ? 2 : 1;
      sum += w * t.corners[ny * t.width + nx].rawHeight;
      weight += w;
    }
    return Math.floor(sum / weight);
  });
  let changed = false;
  ids.forEach((i, k) => { changed = setRaw(t, i, next[k], stroke) || changed; });
  return changed;
}

/** One application of a height brush. `amount` is the most a corner moves up or down (noise: each corner by its own
 *  random share, from `random`), the stored ground word to level to (plateau), or ignored (raise and lower:
 *  raiseLower; smooth). Returns whether anything changed. */
export function applyHeight(t: Terrain, b: Brush, tool: HeightTool, amount: number, stroke: Stroke, random: () => number = Math.random): boolean {
  if (tool === "raise" || tool === "lower") return raiseLower(t, b, tool === "raise", stroke);
  if (tool === "plateau") return plateau(t, b, amount, stroke);
  if (tool === "smooth") return smooth(t, b, stroke);
  const cs = cornersIn(t, b);
  if (!cs.length) return false;
  for (const { i, w } of cs) {
    const c = t.corners[i];
    stroke.touch(t, i);
    setGroundHeight(c, groundHeight(c) + (random() * 2 - 1) * amount * w);
  }
  return true;
}

/** One application of a cliff or water brush: corners under the brush move
 *  to the target layer; water tools also set the water flag and level, dry
 *  only clears the flag. `enforceWater` (Enforce Water Height Limits): the new water's ground is kept from going
 *  below the floor, as the World Editor's is (liftToFloor). Returns whether anything changed. */
export function applyLayer(t: Terrain, b: Brush, tool: LayerTool, target: LayerTarget, stroke: Stroke, enforceWater = false): boolean {
  let changed = false;
  const inside = cornersIn(t, b);
  const water = tool === "shallow" || tool === "deep";
  const start = target.start ?? target.layer + (tool === "deep" ? 2 : tool === "shallow" ? 1 : 0);
  /** The water would go below level 0: the corners only turn wet where they are (waterBelowFloor). */
  const wetOnly = waterBelowFloor(tool, start);
  /** Corner to its cliff level before this stamp moved it (the water brush's ramps: dropBrokenRamps). */
  const moved = new Map<number, number>();
  if (water && !wetOnly && inside.length) {
    // As the World Editor does, the ground and the cliff levels round the new water are made ready first (waterBasin).
    const cx = Math.round((b.x - t.offsetX) / 128), cy = Math.round((b.y - t.offsetY) / 128);
    if (cx >= 0 && cy >= 0 && cx < t.width && cy < t.height) {
      const brush = new Set(inside.map(({ i }) => i));
      const touch = (i: number) => {
        stroke.touch(t, i);
        if (!moved.has(i)) moved.set(i, t.corners[i].layer);
      };
      if (waterBasin(t, cy * t.width + cx, brush, b.radius + 1, !!b.square, start, touch, target.cliffType).length) changed = true;
    }
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
    const layer = wetOnly ? c.layer : target.layer;
    if (c.layer === layer && (!water || (c.hasWater && (c.rawWater & 0x3fff) === target.waterLevel))) continue;
    stroke.touch(t, i);
    if (c.layer !== layer && !moved.has(i)) moved.set(i, c.layer);
    setLayer(c, layer);
    if (water && target.waterLevel !== undefined) setWaterLevel(c, target.waterLevel, waterOffsetOf(t));
    stroke.own.add(i);
    changed = true;
  }
  // The low ground comes up with the switch on or off: the editor's lift was the same with Enforce Water Height Limits
  // off (we-compare water-limit-off-deep, 2026-11-14, branch water-brush-we2).
  if (water && liftToFloor(t, inside.map(({ i }) => i), (i) => stroke.touch(t, i)).length) changed = true;
  if (CLIFF_TOOLS.has(tool)) for (const { i } of inside) { stroke.brushed.add(i); stroke.slope.delete(i); stroke.ring.delete(i); }
  if (CLIFF_TOOLS.has(tool) && moved.size) {
    // No cliff taller than two levels: from the brush outwards, each corner beside (or diagonal to) one that moved
    // comes to within two levels of it, ring after ring, as far as it takes (cliffSlope).
    cliffSlope(t, inside.map(({ i }) => i), (n, from, first) => {
      stroke.touch(t, n);
      if (!moved.has(n)) moved.set(n, from);
      stroke.own.add(n);
      if (stroke.brushed.has(n)) return;
      stroke.slope.add(n);
      if (first && b.radius > 0) stroke.ring.add(n);
    });
  }
  // The ramps the cliff and water brushes break lose their flags, as the editor's do (dropBrokenRamps; water: we-compare
  // water-ramp-on, -below and -deep took the three flags of a ramp line off, 2026-11-14, branch water-brush-we2).
  if (moved.size) dropBrokenRamps(t, moved, stroke);
  if (CLIFF_TOOLS.has(tool)) {
    // The corners round the centre the editor's cliff brush types, cliff or not (cliffTypeStencil); retypeCliffs types them.
    const cx = Math.round((b.x - t.offsetX) / 128), cy = Math.round((b.y - t.offsetY) / 128);
    for (const [dx, dy] of cliffTypeStencil(b.radius, !!b.square)) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= t.width || y >= t.height) continue;
      stroke.cover(y * t.width + x);
      stroke.own.add(y * t.width + x);
    }
  }
  const level = target.waterLevel;
  if (water && !wetOnly && enforceWater && level !== undefined) {
    // The dry corners round the new water get its level word too, without the water flag: the World Editor's
    // did (the 24 round a size 3 click, we-compare water-brush-slope-shallow-east, 2026-11-13), but only with Enforce
    // Water Height Limits on (water-limit-off-deep: 8192 left, 2026-11-14) and not where the water went no lower.
    const brush = new Set(inside.map(({ i }) => i));
    for (const i of brush) {
      const x = i % t.width, y = Math.floor(i / t.width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * t.width + nx;
        if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height || brush.has(n)) continue;
        const c = t.corners[n];
        if (c.hasWater || (c.rawWater & 0x3fff) === level) continue;
        stroke.touch(t, n);
        setWaterLevel(c, level, waterOffsetOf(t));
        c.hasWater = false;
        changed = true;
      }
    }
  }
  return changed;
}

/** After a cliff or water stroke: cliffs next to what it changed take the cliff type `chosen` (the palette's) or that
 *  of their ground tile, and so do the corners the brush itself moved (matchCliffTypes). The World Editor's cliff
 *  brush (size 3, Decrease Two, Grass Cliff) typed the 13 corners it lowered, the middle one with only the pit round
 *  it too, and the 24 round them on cliff tiles (we-compare painted-cliff-type, 2026-11-13); its cliff brushes also type
 *  the corners of their stencil round each stamp, cliff or not (cliffTypeStencil). A ground texture stroke
 *  re-types nothing: the editor's left all 37 of those cliff corners as they were under a Dirt stroke, and so did
 *  its strokes narrower and wider than the pit (sizes 1, 3, 5, 8), over part of it, with Rock, with Grass over a
 *  Dirt Cliff pit and over plateau.w3x's edge, whatever cliff type was chosen (painted-cliff-type-*, 2026-11-14,
 *  branch painted-cliff-type-we). What re-types under the editor's tile stroke is its cliff brush: with Apply Cliff
 *  left ticked one click paints and runs the cliff tool, the same as Studio's Paint stroke followed by its cliff
 *  stroke there (painted-with-cliff-*). Whether a corner changed. */
export function retypeCliffs(t: Terrain, stroke: Stroke, cliffGround: string[], chosen?: number): boolean {
  if (!LAYER_TOOLS.has(stroke.label)) return false;
  return matchCliffTypes(t, stroke.typingArea(), cliffGround, stroke, chosen, stroke.own, stroke.slope);
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
