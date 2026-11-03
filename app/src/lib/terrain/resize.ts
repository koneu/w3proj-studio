// Changing a map's size and playable area, as the World Editor's "Map Size
// and Camera Bounds": tiles are added (+) or removed (−) per side, keeping the
// world position of everything that stays (the offset moves instead). Map
// sizes are multiples of 32 tiles (all 116 game maps); the camera bounds sit
// 4 tiles inside the unplayable border horizontally and 2 vertically (also
// all 116 maps).

import type { Corner, Terrain } from "./w3e";

/** Tiles per side: left, right, bottom, top. */
export type Sides = [number, number, number, number];

export const MIN_SIZE = 32, MAX_SIZE = 480, SIZE_STEP = 32;

/** Map size in tiles after `change` (whole map, unplayable border included). */
export function resizedSize(t: Terrain, change: Sides): [number, number] {
  return [t.width - 1 + change[0] + change[1], t.height - 1 + change[2] + change[3]];
}

/** Why `change` can't be applied, or null. */
export function resizeProblem(t: Terrain, change: Sides, complements: Sides): string | null {
  const [w, h] = resizedSize(t, change);
  for (const [n, what] of [[w, "width"], [h, "height"]] as const) {
    if (n < MIN_SIZE || n > MAX_SIZE) return `The ${what} must be ${MIN_SIZE}–${MAX_SIZE} tiles (${n}).`;
    if (n % SIZE_STEP) return `The ${what} must be a multiple of ${SIZE_STEP} tiles (${n}).`;
  }
  if (complements.some((c) => c < 0 || !Number.isInteger(c))) return "Borders are whole numbers of tiles, 0 or more.";
  if (w - complements[0] - complements[1] < 16 || h - complements[2] - complements[3] < 16) return "The playable area must stay at least 16 tiles wide and high.";
  return null;
}

/** The terrain with `change` applied: new corners continue the nearest edge (same ground and
 *  height, no ramps), removed ones are dropped; world positions stay. */
export function resizeTerrain(t: Terrain, change: Sides): Terrain {
  const [l, , b] = change;
  const [w, h] = resizedSize(t, change);
  const corners: Corner[] = new Array((w + 1) * (h + 1));
  for (let y = 0; y <= h; y++) {
    const oy = Math.min(Math.max(y - b, 0), t.height - 1);
    for (let x = 0; x <= w; x++) {
      const ox = Math.min(Math.max(x - l, 0), t.width - 1);
      const src = t.corners[oy * t.width + ox];
      const inside = x - l === ox && y - b === oy;
      corners[y * (w + 1) + x] = inside ? { ...src } : { ...src, ramp: false, blight: false };
    }
  }
  return { ...t, width: w + 1, height: h + 1, offsetX: t.offsetX - l * 128, offsetY: t.offsetY - b * 128, corners };
}

/** A grid of `cells` per tile (shadows: 4) resized like the terrain; new cells get `fill`. */
export function resizeGrid(grid: Uint8Array, t: Terrain, change: Sides, cells: number, fill = 0): Uint8Array {
  const ow = (t.width - 1) * cells, oh = (t.height - 1) * cells;
  const [w, h] = resizedSize(t, change).map((n) => n * cells);
  const dx = change[0] * cells, dy = change[2] * cells;
  const out = new Uint8Array(w * h).fill(fill);
  for (let y = 0; y < h; y++) {
    const oy = y - dy;
    if (oy < 0 || oy >= oh) continue;
    for (let x = 0; x < w; x++) {
      const ox = x - dx;
      if (ox >= 0 && ox < ow) out[y * w + x] = grid[oy * ow + ox] ?? fill;
    }
  }
  return out;
}

/** The world rectangle a terrain covers. */
export function worldRect(t: Terrain): { left: number; bottom: number; right: number; top: number } {
  return { left: t.offsetX, bottom: t.offsetY, right: t.offsetX + (t.width - 1) * 128, top: t.offsetY + (t.height - 1) * 128 };
}

/** war3map.w3i's camera bounds for a terrain and border (complements): 4 tiles inside it
 *  horizontally, 2 vertically; corners as stored (left/bottom, right/top, left/top, right/bottom). */
export function cameraBounds(t: Terrain, c: Sides): number[] {
  const w = t.width - 1, h = t.height - 1;
  const left = t.offsetX + (c[0] + 4) * 128, right = t.offsetX + (w - c[1] - 4) * 128;
  const bottom = t.offsetY + (c[2] + 2) * 128, top = t.offsetY + (h - c[3] - 2) * 128;
  return [left, bottom, right, top, left, top, right, bottom];
}

/** Playable size in tiles for a terrain and border. */
export const playableSize = (t: Terrain, c: Sides): [number, number] => [t.width - 1 - c[0] - c[1], t.height - 1 - c[2] - c[3]];
