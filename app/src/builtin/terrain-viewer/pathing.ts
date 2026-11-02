// war3map.wpm: the pathing map the game uses for walking, flying and
// building. One byte per 32×32 cell (4×4 cells per tile), rows from the
// bottom-left like the terrain:
//   "MP3W", u32 version (0), u32 width, u32 height, then width×height flags.
// Flags: 0x02 no walk, 0x04 no fly, 0x08 no build, 0x20 blight,
//        0x40 no water, 0x80 blocked by something other than water.
// The rules below were worked out by comparing generated maps with the ones
// World Editor saved for the sample maps.

import type { Corner, Terrain } from "./w3e";

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
}

/** Water deeper than this (world units) can't be walked. */
export const DEEP_WATER = 52;

const depth = (k: Corner) => (k.hasWater ? k.water - k.height : -Infinity);

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
      const cliff = new Set(q.map((k) => k.layer)).size > 1 && !q.some((k) => k.ramp);
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
