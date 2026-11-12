// Changing a map's size and playable area, as the World Editor's "Map Size
// and Camera Bounds": tiles are added (+) or removed (−) per side, keeping the
// world position of everything that stays (the offset moves instead). The
// whole map's size is a multiple of 4 tiles, as the World Editor's ("The full
// map size must be a multiple of %d in both dimensions"; we-drive, 2026-11-12:
// Last Refuge resized to 100 × 100 and 92 × 92, a click being 4 tiles); the
// camera bounds sit 4 tiles inside the unplayable border horizontally and 2
// vertically (all 116 game maps).

import { randomVariation, type Corner, type Terrain } from "./w3e";
import type { Area } from "./area";

/** Tiles per side: left, right, bottom, top. */
export type Sides = [number, number, number, number];

export const MIN_SIZE = 32, MAX_SIZE = 480, SIZE_STEP = 4;

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

/** The cliff variation the World Editor gives a corner Map Size adds: 0, 1 or 2 at random (we-drive, 2026-11-11: 812
 *  new corners had 294, 290 and 228, not the edge's 0). */
export const newCliffVariation = (random: () => number = Math.random) => Math.min(2, Math.floor(random() * 3));

/** The camera zoom (war3map.w3i, the game's default, highest and lowest camera distance) a map has after Map Size:
 *  one that has none (all 0) gets 1250 for each, as the World Editor writes it (we-drive, 2026-11-11: cliff.w3m grown
 *  went from 0, 0, 0 to 1250, 1250, 1250); one set already keeps its values. Null when nothing changes. */
export function resizedCameraZoom(zoom: { default: number; max: number; min?: number } | undefined): { default: number; max: number; min?: number } | null {
  if (!zoom || zoom.default !== 0 || zoom.max !== 0 || (zoom.min ?? 0) !== 0) return null;
  return { default: 1250, max: 1250, ...(zoom.min !== undefined ? { min: 1250 } : {}) };
}

/** A corner Map Size adds, as the World Editor makes it: a copy of the nearest corner on the old map's edge (height,
 *  cliff level, water, ground and cliff tile, flags), with a ground and a cliff variation of its own. we-drive
 *  2026-11-12, Last Refuge grown by 32 tiles left and bottom: all 7232 new corners equal their edge corner but for the
 *  variations and the map edge bit; cliff.w3m grown by 8 (2026-11-11) gave flat level-2 ground of tile 0 because its
 *  edge is that. The map edge bit of the water word comes after, from the playable area (markMapEdge). */
export function newCorner(edge: Corner, random: () => number = Math.random): Corner {
  return { ...edge, variation: randomVariation(random), cliffVariation: newCliffVariation(random) };
}

/** The terrain with `change` applied: new corners copy the old map's edge (newCorner), removed ones are dropped; world
 *  positions stay. The caller marks the map edge for the new playable area (markMapEdge). */
export function resizeTerrain(t: Terrain, change: Sides, random: () => number = Math.random): Terrain {
  const [l, , b] = change;
  const [w, h] = resizedSize(t, change);
  const corners: Corner[] = new Array((w + 1) * (h + 1));
  const clamp = (n: number, size: number) => Math.min(Math.max(n, 0), size - 1);
  for (let y = 0; y <= h; y++) {
    const oy = y - b;
    for (let x = 0; x <= w; x++) {
      const ox = x - l;
      const inside = ox >= 0 && oy >= 0 && ox < t.width && oy < t.height;
      corners[y * (w + 1) + x] = inside ? { ...t.corners[oy * t.width + ox] } : newCorner(t.corners[clamp(oy, t.height) * t.width + clamp(ox, t.width)], random);
    }
  }
  return { ...t, width: w + 1, height: h + 1, offsetX: t.offsetX - l * 128, offsetY: t.offsetY - b * 128, corners };
}

/** The doodad file's special doodads (caves, collapsed cliffs: placed by tile from the map's bottom left) after
 *  `change`: they stay on their ground, so their tiles shift by what was added or cut on the left and bottom; those whose
 *  tile is no longer on the map go, as the regular doodads outside do. Entries that aren't specials are kept as they
 *  are. */
export function resizeSpecials<T>(list: readonly T[], t: Terrain, change: Sides): { kept: T[]; removed: number } {
  const [w, h] = resizedSize(t, change);
  const kept: T[] = [];
  for (const s of list) {
    const e = s as { x?: unknown; y?: unknown };
    if (!Number.isInteger(e?.x) || !Number.isInteger(e?.y)) { kept.push(s); continue; }
    const x = (e.x as number) + change[0], y = (e.y as number) + change[2];
    if (x >= 0 && y >= 0 && x < w && y < h) kept.push({ ...s, x, y });
  }
  return { kept, removed: list.length - kept.length };
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
export function worldRect(t: Pick<Terrain, "offsetX" | "offsetY" | "width" | "height">): { left: number; bottom: number; right: number; top: number } {
  return { left: t.offsetX, bottom: t.offsetY, right: t.offsetX + (t.width - 1) * 128, top: t.offsetY + (t.height - 1) * 128 };
}

/** Whether a doodad at x, y stays on a map of world rectangle `rect` after Map Size: only strictly inside it, as the
 *  World Editor keeps them (we-drive 2026-11-12, Last Refuge cut by 32 tiles left and bottom, and by 64 left: the 11
 *  more doodads it removed each time stood exactly on the new left or bottom edge; the nearest kept one stood 4.7 inside).
 *  The right and top edges are taken alike; they weren't seen. Doodads past the playable area stay (the backdrop). */
export const doodadStays = (x: number, y: number, rect: Area) => x > rect.left && x < rect.right && y > rect.bottom && y < rect.top;

/** Whether a unit or item at x, y stays after Map Size: its building footprint (`half`: half its pathing texture's
 *  width and height in world units, 0 without one) lies within the new playable area, edges included. we-drive
 *  2026-11-12, Last Refuge cut three ways: every unit past the playable area went (12), and so did a mercenary camp
 *  on the edge and a gold mine (16 × 16 cells, half 256) 192 inside it, while one 256 inside stayed. Start locations aren't asked: they are moved. */
export const unitStays = (x: number, y: number, half: readonly [number, number], playable: Area) =>
  x - half[0] >= playable.left && x + half[0] <= playable.right && y - half[1] >= playable.bottom && y + half[1] <= playable.top;

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

/** The Pathing Editor's overrides (.w3proj/pathing.json): sparse, per 32×32 cell. */
export interface PathingOverrides { format?: string; width: number; height: number; cells: [number, number, number, number][] }

/** Whether a parsed pathing.json has the shape the editor writes: sizes and `[x, y, set, clear]` numbers. */
export function validPathingOverrides(file: unknown): file is PathingOverrides {
  const f = file as Partial<PathingOverrides> | null;
  return !!f && typeof f === "object" && Number.isInteger(f.width) && Number.isInteger(f.height) && Array.isArray(f.cells)
    && f.cells.every((c) => Array.isArray(c) && c.length === 4 && c.every((n) => Number.isInteger(n)));
}

/** The one test of "these overrides belong to a pathing map of `width`×`height` cells": the shape the
 *  editor writes and that size. The Pathing Editor, the resize and the wpm all ask this. */
export function overridesForSize(file: unknown, width: number, height: number): PathingOverrides | null {
  return validPathingOverrides(file) && file.width === width && file.height === height ? file : null;
}

/** The overrides after `change`: each stays on the same ground cell (cells shift with the
 *  offset), those on cells that no longer exist are dropped. A file for another size than the
 *  terrain's (the editor ignores it already) is returned as it is. */
export function resizePathingOverrides(file: PathingOverrides, t: Terrain, change: Sides): PathingOverrides {
  if (!validPathingOverrides(file)) return file;
  if (file.width !== (t.width - 1) * 4 || file.height !== (t.height - 1) * 4) return file;
  const [w, h] = resizedSize(t, change).map((n) => n * 4);
  const dx = change[0] * 4, dy = change[2] * 4;
  const cells: PathingOverrides["cells"] = [];
  for (const [x, y, set, clear] of file.cells) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < w && ny >= 0 && ny < h) cells.push([nx, ny, set, clear]);
  }
  cells.sort((a, b) => a[1] * w + a[0] - (b[1] * w + b[0]));
  return { ...file, width: w, height: h, cells };
}

/** What a resize does with a parsed pathing.json read before the change. `null`: the file isn't
 *  this map's overrides (malformed, or for a size that is neither the OLD terrain's nor the NEW one's: stale):
 *  neither applied nor rewritten. A file already for the NEW size is applied, never rewritten. Otherwise the moved overrides, and `write` only when their size or
 *  cells differ from what was read (a camera-bounds-only change leaves the file's bytes alone). */
export function planPathingOverrides(stored: unknown, t: Terrain, change: Sides): { file: PathingOverrides; write: boolean } | null {
  if (!validPathingOverrides(stored)) return null;
  if (!overridesForSize(stored, (t.width - 1) * 4, (t.height - 1) * 4)) {
    // For the NEW size already: the Pathing Editor adopts it as it is, so the wpm must carry it too
    // (applied, never rewritten). Any other size is stale: left alone.
    const [nw, nh] = resizedSize(t, change).map((n) => n * 4);
    return overridesForSize(stored, nw, nh) ? { file: stored, write: false } : null;
  }
  const file = resizePathingOverrides(stored, t, change);
  // The moved cells come sorted; a hand-written order alone is no reason to rewrite the file.
  const old = [...stored.cells].sort((a, b) => a[1] * stored.width + a[0] - (b[1] * stored.width + b[0]));
  const same = file.width === stored.width && file.height === stored.height && file.cells.length === old.length
    && file.cells.every((c, i) => c.every((n, j) => n === old[i][j]));
  return { file, write: !same };
}

/** The file's text, one cell per line to keep diffs small. Fields of its own (a hand-written note, a tool's data)
 *  are kept, between the sizes and the cells. */
export function pathingOverridesText(file: PathingOverrides): string {
  const { format, width, height, cells, ...rest } = file;
  const own = Object.entries(rest).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `\n  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, "\n  ")},`).join("");
  return `{\n  "format": ${JSON.stringify(format ?? "w3proj.pathing/1")},\n  "width": ${width},\n  "height": ${height},${own}\n  "cells": [${cells.map((c) => `\n    ${JSON.stringify(c)}`).join(",")}${cells.length ? "\n  " : ""}]\n}\n`;
}

/** Applies the overrides to a wpm (16-byte header, then one byte per cell) of terrain `t`.
 *  Returns false, changing nothing, when the file isn't valid or is for another size than `t`. */
export function applyPathingOverrides(wpm: Uint8Array, file: unknown, t: Terrain): boolean {
  const f = overridesForSize(file, (t.width - 1) * 4, (t.height - 1) * 4);
  if (!f) return false;
  const cells = wpm.subarray(16);
  for (const [x, y, set, clear] of f.cells) {
    const i = y * f.width + x;
    if (x >= 0 && x < f.width && y >= 0 && y < f.height && i < cells.length) cells[i] = (cells[i] | set) & ~clear;
  }
  return true;
}

/** What `resizeMap` does with the pathing overrides once the new wpm is built: applies them to it
 *  (not for a same-size change, which uses the tool groups' own filters instead) and returns the
 *  text to write to .w3proj/pathing.json, or null when the file must stay as it is. */
export function applyResizePathing(wpm: Uint8Array, plan: ReturnType<typeof planPathingOverrides>, next: Terrain, change: Sides): string | null {
  if (!plan) return null;
  if (change.some((c) => c !== 0)) applyPathingOverrides(wpm, plan.file, next);
  return plan.write ? pathingOverridesText(plan.file) : null;
}
