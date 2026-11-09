// What the terrain viewer's View commands work out, with no editor state: where the camera goes to
// show a selection or the whole map, which grid is drawn, and the picture of the toggled layers
// (the camera objects' is lib/terrain/cameras).
// The viewer passes what it read; the tests pass made-up maps.

import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import type { CameraObject } from "../../lib/terrain/cameras";
import type { TerrainToolGroupInstance } from "../../extensions/services";

/** The camera objects the Camera Objects layer draws: those of a tool group that holds them (the
 *  Camera Editor, with its unsaved edits), else the saved file's. */
export async function layerCameras(groups: Iterable<Pick<TerrainToolGroupInstance, "cameraObjects">>,
  saved: () => Promise<readonly CameraObject[]>): Promise<readonly CameraObject[]> {
  for (const g of groups) if (g.cameraObjects) return g.cameraObjects();
  return saved();
}

/** The regions the Regions layer draws: those of a tool group that holds them (the Region Editor, with its unsaved
 *  edits), else the saved file's. */
export async function layerRegions(groups: Iterable<Pick<TerrainToolGroupInstance, "regionObjects">>,
  saved: () => Promise<readonly RegionBox[]>): Promise<readonly RegionBox[]> {
  for (const g of groups) if (g.regionObjects) return g.regionObjects();
  return saved();
}

export interface Box { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
/** The camera's direction: `yaw` and `pitch` point from the target to the eye, `fov` is vertical. */
export interface Angle { yaw: number; pitch: number; fov: number }

/** The box around points (x, y, z), grown by `pad` in x and y. Null for none. */
export function boxOf(points: readonly (readonly number[])[], pad = 0): Box | null {
  if (!points.length) return null;
  const box: Box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [x, y, z = 0] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    box.minX = Math.min(box.minX, x - pad); box.maxX = Math.max(box.maxX, x + pad);
    box.minY = Math.min(box.minY, y - pad); box.maxY = Math.max(box.maxY, y + pad);
    box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z);
  }
  return box.minX <= box.maxX ? box : null;
}

/**
 * Where the camera has to stand so that the box fills the view, from the angle it already looks at:
 * the target is the box's middle, and the distance the smallest at which all eight corners are inside
 * the picture (exact for this angle, `margin` is the extra room around, 1.1 = 10%).
 */
export function viewOfBox(box: Box, angle: Angle, aspect: number, opts: { margin?: number; minDistance?: number; maxDistance?: number } = {}) {
  const { margin = 1.1, minDistance = 0, maxDistance = Infinity } = opts;
  const target: [number, number, number] = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2];
  const cp = Math.cos(angle.pitch), sp = Math.sin(angle.pitch), cy = Math.cos(angle.yaw), sy = Math.sin(angle.yaw);
  // The camera's axes: back (target to eye), right and up.
  const back = [cp * cy, cp * sy, sp], right = [-sy, cy, 0], up = [-sp * cy, -sp * sy, cp];
  const ty = Math.tan(angle.fov / 2), tx = ty * Math.max(0.1, aspect);
  let need = 0;
  for (const x of [box.minX, box.maxX]) for (const y of [box.minY, box.maxY]) for (const z of [box.minZ, box.maxZ]) {
    const d = [x - target[0], y - target[1], z - target[2]];
    const dot = (v: number[]) => d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
    // A point `c` behind the target is `distance - c` in front of the eye, and must stay inside both half widths.
    need = Math.max(need, dot(back) + Math.max(Math.abs(dot(right)) / tx, Math.abs(dot(up)) / ty));
  }
  return { target, distance: Math.min(maxDistance, Math.max(minDistance, need * margin)) };
}

// ---- grids -------------------------------------------------------------------------------

export type GridSize = "none" | "small" | "medium" | "large";
/** Distance between grid lines: small is the pathing cell, medium the tile, large four tiles. */
export const GRID_STEP: Record<GridSize, number> = { none: 0, small: 32, medium: 128, large: 512 };

/** What a "Toggle ... Grid" does: the same size again switches the grid off, another one replaces it. */
export const toggleGrid = (current: GridSize, size: Exclude<GridSize, "none">): GridSize => (current === size ? "none" : size);

// ---- layers ------------------------------------------------------------------------------

/** Where ships can sail (per pathing cell, rows from the south): deep water strongly, shallow water lightly. */
export function navalColors(cells: ArrayLike<number>): Uint8Array {
  const rgba = new Uint8Array(cells.length * 4);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c & NO_WATER) continue;
    rgba.set(c & 0x02 ? [20, 70, 255, 200] : [90, 220, 255, 150], i * 4);
  }
  return rgba;
}

/** Pathing - Ground (per pathing cell, rows from the south), in the World Editor's colours: magenta where nothing
 *  walks, blue where units walk but nothing can be built (we-drive, map 03's lake and its shore, 2026-11-09). */
export function groundPathingColors(cells: ArrayLike<number>): Uint8Array {
  const rgba = new Uint8Array(cells.length * 4);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c & NO_WALK) rgba.set([230, 40, 230, 150], i * 4);
    else if (c & NO_BUILD) rgba.set([40, 90, 255, 140], i * 4);
  }
  return rgba;
}

export interface RegionBox { left: number; bottom: number; right: number; top: number; color?: { red: number; green: number; blue: number } }

/** The Regions layer (per pathing cell of `width` × `height`, rows from the south, the map's corner at `offsetX`,
 *  `offsetY`): each region filled with its colour and edged darker, larger ones first so that small ones stay on top. */
export function regionColors(regions: readonly RegionBox[], width: number, height: number, offsetX: number, offsetY: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const cell = 32;
  const area = (r: RegionBox) => (r.right - r.left) * (r.top - r.bottom);
  for (const r of [...regions].sort((a, b) => area(b) - area(a))) {
    if (![r.left, r.right, r.bottom, r.top].every(Number.isFinite)) continue;
    const x0 = Math.max(0, Math.round((r.left - offsetX) / cell)), x1 = Math.min(width, Math.round((r.right - offsetX) / cell));
    const y0 = Math.max(0, Math.round((r.bottom - offsetY) / cell)), y1 = Math.min(height, Math.round((r.top - offsetY) / cell));
    const c = r.color ?? { red: 255, green: 255, blue: 255 };
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
        rgba.set(edge ? [c.red * 0.3, c.green * 0.3, c.blue * 0.3, 235] : [c.red, c.green, c.blue, 170], (y * width + x) * 4);
      }
    }
  }
  return rgba;
}

/** Layers of equal size laid over each other, the first at the bottom (alpha over); null leaves a layer out. Null when none is left. */
export function composeLayers(layers: readonly (Uint8Array | null)[]): Uint8Array | null {
  const shown = layers.filter((l): l is Uint8Array => !!l);
  if (!shown.length) return null;
  if (shown.length === 1) return shown[0];
  const out = new Uint8Array(shown[0].length);
  for (let i = 0; i < out.length; i += 4) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const l of shown) {
      const la = l[i + 3] / 255;
      if (!la) continue;
      const na = la + a * (1 - la);
      r = (l[i] * la + r * a * (1 - la)) / na; g = (l[i + 1] * la + g * a * (1 - la)) / na; b = (l[i + 2] * la + b * a * (1 - la)) / na; a = na;
    }
    out.set([Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)], i);
  }
  return out;
}
