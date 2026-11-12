// war3map.wpm: the pathing map the game uses for walking, flying and
// building. One byte per 32×32 cell (4×4 cells per tile), rows from the
// bottom-left like the terrain:
//   "MP3W", u32 version (0), u32 width, u32 height, then width×height flags.
// Flags: 0x02 no walk, 0x04 no fly, 0x08 no build, 0x20 blight,
//        0x40 no water, 0x80 blocked by something other than water.
// The rules below were worked out by comparing generated maps with the ones
// World Editor saved for the sample maps.

import { rampLift, WATER_OFFSET, type Corner, type Terrain } from "./w3e";
import { rampSides } from "./cliffs";

export const NO_WALK = 0x02, NO_FLY = 0x04, NO_BUILD = 0x08, BLIGHT = 0x20, NO_WATER = 0x40, BLOCKED = 0x80;

/** Pathing of a ground tile type (TerrainArt\Terrain.slk). */
export interface TileRule { walkable: boolean; buildable: boolean; flyable: boolean }

/** A pathing texture placed in the map (doodads, destructables). Pixels are
 *  cells; red blocks walking, green flying, blue building. */
export interface PathingStamp {
  /** World position of the centre. */
  x: number;
  y: number;
  /** Radians; textures turn in 90° steps. */
  angle: number;
  width: number;
  height: number;
  /** RGBA, rows top to bottom. */
  rgba: ArrayLike<number>;
  /** Walkable destructables (bridges): the game adds their pathing at run
   *  time, the map only has the covered cells cleared. */
  clear?: boolean;
}

export interface PathingInput {
  terrain: Terrain;
  /** Unplayable border in tiles: left, right, bottom, top (w3i). */
  margins: [number, number, number, number];
  tileRules: Map<string, TileRule>;
  stamps?: PathingStamp[];
  /** Water deeper than this can't be walked (default DEEP_WATER). */
  deepWater?: number;
  /** How far below its stored level the tileset's water surface lies (default WATER_OFFSET): the `height` of
   *  TerrainArt/Water.slk × −128. Most tilesets have 89.6; Ashenvale and Dungeon 76.8, Dalaran 96, Outland 192. The
   *  World Editor measures the depth from there: with 89.6, Ashenvale maps came out with thousands of deep cells
   *  walkable. */
  waterOffset?: number;
}

/** Water deeper than this (world units) can't be walked. */
export const DEEP_WATER = 52;

const waterDepth = (k: Corner) => (k.hasWater ? k.water - k.height : -Infinity);

/** Whether a tile (its four corners) is a cliff in the pathing map: its corners' layers differ, and it isn't a ramp.
 *  A ramp tile has the ramp flag on all four corners and spans one layer; a tile with only some corners flagged
 *  (beside a ramp, or the stray flags maps carry among cliffs) is a cliff. Worked out from the stored pathing maps of
 *  the sample and ladder maps: every such tile is blocked there (e.g. Autumn Leaves' west cliffs, tiles 15..20 × 16..65).
 *  generatePathing also blocks a ramp tile that rises with no ramp foot beside it (it needs the neighbours). */
export function isCliffTile(q: readonly Corner[]): boolean {
  const layers = q.map((k) => k.layer);
  const lo = Math.min(...layers), hi = Math.max(...layers);
  if (lo === hi) return false;
  return !(hi - lo === 1 && q.every((k) => k.ramp));
}

export function generatePathing(input: PathingInput): Uint8Array {
  const { terrain: t, margins: [ml, mr, mb, mt], tileRules } = input;
  const deep = input.deepWater ?? DEEP_WATER;
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4;
  const out = new Uint8Array(16 + w * h);
  const view = new DataView(out.buffer);
  out.set([0x4d, 0x50, 0x33, 0x57]); // "MP3W"
  view.setUint32(4, 0, true);
  view.setUint32(8, w, true);
  view.setUint32(12, h, true);
  const cells = out.subarray(16);
  const C = (x: number, y: number) => t.corners[y * t.width + x];
  // A ramp side's flat tile (the other one is a cliff anyway) is blocked where a ramp tile lies across the side's
  // ramp edge (Mount Hyjal's ramps), or where its far side is a cliff one layer high (Autumn Leaves' tile 15,25).
  // Beside stray ramp flags with low ground all along the far side it stays walkable (Autumn Leaves' tile 17,32).
  // Measured on the stored pathing maps of 161 sample and ladder maps.
  const tw = t.width - 1;
  const isRampTile = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= tw || y >= t.height - 1) return false;
    const q = [C(x, y), C(x + 1, y), C(x, y + 1), C(x + 1, y + 1)];
    return q.every((k) => k.ramp) && !isCliffTile(q);
  };
  // A ramp climbs one layer over two tiles: foot, middle (on the low layer, half a layer up: rampLift), top. So
  // along an edge of a ramp tile that rises, the ramp goes on past the low end: the next corner out is a ramp corner
  // on the low layer too. A tile with all four flags across one layer where no rising edge has that (stray flags
  // around a pit, Autumn Leaves' tile 17,17) steps a whole layer in one tile: a cliff. In the 161 maps' stored
  // pathing it is the only such tile, and the only ramp tile blocked for no other reason.
  const footless = (x: number, y: number) => {
    if (!isRampTile(x, y)) return false;
    const p: [number, number][] = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
    let rising = false;
    for (const [i, j] of [[0, 1], [2, 3], [0, 2], [1, 3]]) {
      const a = C(...p[i]), b = C(...p[j]);
      if (a.layer === b.layer) continue;
      rising = true;
      const [lo, hi] = a.layer < b.layer ? [p[i], p[j]] : [p[j], p[i]];
      const fx = 2 * lo[0] - hi[0], fy = 2 * lo[1] - hi[1];
      if (fx < 0 || fy < 0 || fx >= t.width || fy >= t.height) continue;
      const foot = C(fx, fy);
      if (foot.ramp && foot.layer === C(...lo).layer) return false;
    }
    return rising;
  };
  const sides = new Set(rampSides(t).filter((s) => {
    const far = s.outer.filter((k) => !k.ramp);
    if (Math.abs(far[0].layer - far[1].layer) === 1) return true;
    // outer: bottom-left, top-left, top-right, bottom-right; the ramp corners are two of them along the long side.
    const ramps = s.outer.map((k, i) => (k.ramp ? i : -1)).filter((i) => i >= 0).join("");
    const across: [number, number][] = s.w === 2
      ? (ramps === "12" ? [[s.x, s.y + 1], [s.x + 1, s.y + 1]] : [[s.x, s.y - 1], [s.x + 1, s.y - 1]])
      : (ramps === "01" ? [[s.x - 1, s.y], [s.x - 1, s.y + 1]] : [[s.x + 1, s.y], [s.x + 1, s.y + 1]]);
    return across.some(([x, y]) => isRampTile(x, y));
  }).flatMap((s) => s.tiles));
  // A straight ramp's middle corners stand half a layer up (rampLift): the water over them is that much shallower
  // (Snoware Bay). On a diagonal ramp, where a ramp corner beside one is a layer up, it stays (Ekrezem's Maze).
  const lift = new Map<Corner, number>();
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < t.width && y < t.height ? C(x, y) : null);
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const l = rampLift(t, x, y), k = C(x, y);
    if (!l) continue;
    // The axis the ramp climbs along: the one with a ramp corner a layer up.
    const alongX = [at(x + 1, y), at(x - 1, y)].some((n) => n?.ramp && n.layer === k.layer + 1);
    const across = alongX ? [at(x, y + 1), at(x, y - 1)] : [at(x + 1, y), at(x - 1, y)];
    if (across.some((n) => n?.ramp && n.layer !== k.layer)) continue;
    lift.set(k, l);
  }
  // A corner's water level is read with WATER_OFFSET; the tileset's own surface may lie elsewhere (waterOffset).
  const raise = WATER_OFFSET - (input.waterOffset ?? WATER_OFFSET);
  const depth = (k: Corner) => waterDepth(k) + raise - (lift.get(k) ?? 0);

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const tx = cx >> 2, ty = cy >> 2;
      const q: Corner[] = [C(tx, ty), C(tx + 1, ty), C(tx, ty + 1), C(tx + 1, ty + 1)];
      let p = NO_WATER;
      // Ground texture: the nearest corner's tile.
      const c = C((cx + 2) >> 2, (cy + 2) >> 2);
      const rule = tileRules.get(t.groundTiles[c.texture]);
      const unwalkable = rule !== undefined && !rule.walkable;
      if (rule) {
        if (unwalkable) p |= NO_WALK;
        if (!rule.buildable) p |= NO_BUILD;
        if (!rule.flyable) p |= NO_FLY;
      }
      if (c.blight) p |= BLIGHT;
      const cliff = isCliffTile(q) || sides.has(ty * (t.width - 1) + tx) || (q[0].ramp && footless(tx, ty));
      if (q.every((k) => depth(k) > 0) || depth(c) > deep) {
        // Water (the whole tile is under water) hides cliffs; unwalkable
        // ground stays dry but blocked.
        if (unwalkable) p |= NO_BUILD | BLOCKED;
        else {
          p = (p & ~(NO_WATER | NO_WALK)) | NO_BUILD;
          if ((cliff ? Math.max(...q.map(depth)) : depth(c)) > deep) p |= NO_WALK;
        }
      } else if (cliff) p |= NO_WALK | NO_BUILD | BLOCKED;
      // Shore: dry, but the nearest corner is under water.
      else if (depth(c) > 0) p |= NO_BUILD;
      cells[cy * w + cx] = p;
    }
  }
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      if (cx < ml * 4 || cx >= w - mr * 4 || cy < mb * 4 || cy >= h - mt * 4) cells[cy * w + cx] = BLOCKED | NO_WATER | NO_BUILD | NO_FLY | NO_WALK;
    }
  }
  const stamps = input.stamps ?? [];
  for (const s of stamps) if (s.clear) stamp(cells, w, h, t, s);
  for (const s of stamps) if (!s.clear) stamp(cells, w, h, t, s);
  return out;
}

/** Visits the pathing cells a texture placed at (x, y) with `angle` covers:
 *  `fn(cell x, cell y, pixel)` with the pixel index (rows top to bottom).
 *  Cells outside the w × h grid are skipped. */
export function forEachStampCell(t: Terrain, w: number, h: number,
  s: { x: number; y: number; angle: number; width: number; height: number }, fn: (cx: number, cy: number, pixel: number) => void) {
  // Textures are drawn for the default facing (270°).
  const turns = (((Math.round(s.angle / (Math.PI / 2)) + 1) % 4) + 4) % 4;
  const sw = turns % 2 ? s.height : s.width, sh = turns % 2 ? s.width : s.height;
  // Bottom-left cell of the (turned) texture.
  const x0 = Math.round((s.x - t.offsetX) / 32 - sw / 2), y0 = Math.round((s.y - t.offsetY) / 32 - sh / 2);
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      const cx = x0 + i, cy = y0 + j;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      // (i, j) from the bottom-left in the turned frame → texture pixel.
      let u: number, v: number;
      switch (turns) {
        case 0: u = i; v = j; break;
        case 1: u = j; v = s.height - 1 - i; break;
        case 2: u = s.width - 1 - i; v = s.height - 1 - j; break;
        default: u = s.width - 1 - j; v = i; break;
      }
      fn(cx, cy, (s.height - 1 - v) * s.width + u);
    }
  }
}

/** Ors a pathing texture into the cells (or clears them). */
function stamp(cells: Uint8Array, w: number, h: number, t: Terrain, s: PathingStamp) {
  forEachStampCell(t, w, h, s, (cx, cy, pixel) => {
    const o = pixel * 4;
    const r = s.rgba[o], g = s.rgba[o + 1], b = s.rgba[o + 2];
    if (s.clear) {
      if (r > 127 || g > 127 || b > 127) cells[cy * w + cx] = 0;
      return;
    }
    let f = 0;
    if (r > 127) f |= NO_WALK | BLOCKED | NO_WATER;
    if (g > 127) f |= NO_FLY;
    if (b > 127) f |= NO_BUILD;
    cells[cy * w + cx] |= f;
  });
}
