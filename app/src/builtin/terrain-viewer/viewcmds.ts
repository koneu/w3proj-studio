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

/** Which selected object View Selection goes to (the World Editor's Edit > View Selection > Cycle Main View - Next, ~,
 *  and - Previous, Shift+~): an index into the `count` selected, in viewOrder's order, `last` the one looked at before
 *  (-1 when it isn't one of them). Each press pans to one object, keeping the camera's distance and angles (we-drive
 *  2026-11-12). Next goes round: after the last comes the first again (verification round 3, 2026-11-13: five trees
 *  and four footmen, the sixth press back on the first; the run of 2026-11-12 that saw it stop at the end didn't know
 *  the editor's order, so it read the order's last as the end). Previous goes round the other way. -1 for nothing
 *  selected. */
export function cycleIndex(count: number, last: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (last < 0 || last >= count) return step > 0 ? 0 : count - 1;
  return (last + step + count) % count;
}

/** The order View Selection goes through the selected objects (`points`: their x, y; `filePlace`: each one's index in
 *  its placement file): west to east, by x ascending, whatever order they were placed or selected in (verification
 *  round 3, 2026-11-13: trees at x 0, 1280, -1024, 512, -1792 in file order came as -1792, -1024, 0, 512, 1280; footmen
 *  likewise). Equal x: the one later in the file first (we-drive 2026-11-13: three trees at x 0, stored with y 2048,
 *  2304, 1792 in that order, came as 1792, 2304, 2048, neither by y nor in file order). Indexes into `points`. */
export function viewOrder(points: readonly (readonly number[])[], filePlace: readonly number[]): number[] {
  return points.map((_, i) => i).sort((a, b) => (points[a][0] - points[b][0]) || (filePlace[b] - filePlace[a]) || a - b);
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

/** How far down the camera can look (radians from level): a tenth of a degree short of straight down, where the view's
 *  sideways axis would have no direction; the map's sides look upright, as in the World Editor's View Entire Map.
 *  Rotating with the mouse stops here too. */
export const MAX_PITCH = Math.PI / 2 - 0.002;
/** North up: the eye south of the target. */
export const NORTH_UP_YAW = -Math.PI / 2;

/** View Entire Map in the World Editor's 1184x844 view (we-drive, new maps of 64x64, 128x64 and 64x128 and map 03,
 *  2026-11-11): the playable part's larger side spans this share of the view's width, */
const WE_MAP_SIDE = 932.6 / 1184;
/** the playable part's middle shows this far down the view (the point the editor zooms around), */
const WE_MAP_ROW = 221.9 / 844;
/** and the editor draws with a 4:3 projection stretched over its wider view: up and down, the ground shows at
 *  (4/3) / (1184/844) = 0.95 of its scale across (a 128x64 map's playable 52 rows were 397 pixels, its 116 columns 932). */
const WE_PROJECTION_ASPECT = 4 / 3;

/**
 * View Entire Map as the World Editor shows it: looking straight down with north up, the playable part's larger side
 * across 79% of the view's width whatever the map's shape, its middle at 26% of the view's height. So the map's
 * south edge shows at 87% of the height on a 64x64 map (734 of 844, the sides at 18 and 1165), at 53% on a 128x64 one
 * (450; 77 and 1106) and at 82% on a 64x128 one (696; 334 and 849), and a map's north is cut off unless it is much
 * wider than tall. Studio's projection isn't stretched: the map's sides and its south edge show where the editor's
 * do, the rest of it 5% further north. `map` is the whole map, `playable` its playable part (the whole map if
 * unknown), `fov` vertical, `aspect` the view's width / height. Exact for the camera's pitch (MAX_PITCH, a hair short
 * of straight down) over ground at the target's height.
 */
export function viewOfMap(map: Box, playable: Box | null, fov: number, aspect: number) {
  const p = playable ?? map;
  const side = Math.max(p.maxX - p.minX, p.maxY - p.minY, 1);
  const tanY = Math.tan(fov / 2), tanX = tanY * Math.max(0.1, aspect), cp = Math.cos(MAX_PITCH), sp = Math.sin(MAX_PITCH);
  // At the target's depth the view is 2 * distance * tanX wide.
  const distance = side / (2 * WE_MAP_SIDE * tanX);
  const middleY = (p.minY + p.maxY) / 2;
  // Where the editor shows the map's south edge, as a share of the view's height from its top: the middle's row plus
  // the distance to it at the editor's scale up and down (its scale across, the share of the width per unit, times
  // its view's width / height, times the squash 4/3 / its aspect: the aspects cancel).
  const southRow = WE_MAP_ROW + WE_MAP_SIDE * WE_PROJECTION_ASPECT * (middleY - map.minY) / side;
  // Seen from the eye (north up), a ground point `dy` north of the target lies `distance + dy * cp` deep, and shows
  // `dy * sp / depth / tanY` up from the view's middle (as a share of half its height).
  const up = 1 - 2 * southRow;
  const dy = up * tanY * distance / (sp - up * tanY * cp);
  const target: [number, number, number] = [(p.minX + p.maxX) / 2, map.minY - dy, (map.minZ + map.maxZ) / 2];
  return { target, distance, yaw: NORTH_UP_YAW, pitch: MAX_PITCH };
}

// ---- grids -------------------------------------------------------------------------------

export type GridSize = "none" | "small" | "medium" | "large";
/** Distance between grid lines: small is the pathing cell, medium the tile, large four tiles. */
export const GRID_STEP: Record<GridSize, number> = { none: 0, small: 32, medium: 128, large: 512 };

/** One set of grid lines: every `step` world units from the map's corner, in `rgba` (0–1, alpha how much of it covers
 *  the ground). */
export interface GridLines { step: number; rgba: readonly [number, number, number, number] }

/** The World Editor's line colours: in SD the tiles' lines pure white and every 4 tiles pure yellow, a pixel wide and
 *  opaque (we-drive, map 03's opening view, 2026-11-12: 254, 254, 254 and 252, 253, 2; its HD tints them, 195, 199, 228
 *  and 196, 200, 68 on HillsbradCreek, 2026-11-11), none over deep water. The pathing cells' lines were only seen in
 *  HD, a faint lavender (115, 120, 159 over ground of about 100, 100, 105). */
const GRID_COLOUR: Record<number, GridLines["rgba"]> = { 32: [0.55, 0.58, 0.85, 0.5], 128: [1, 1, 1, 1], 512: [1, 1, 0, 1] };

/** The lines a grid of this step draws, finest first: as the World Editor's, a finer grid keeps the coarser ones'
 *  lines over its own (medium: the tiles' white lines and every 4 tiles yellow; small: the pathing cells too). */
export function gridLines(step: number): GridLines[] {
  if (!(step > 0)) return [];
  return [32, 128, 512].filter((s) => s >= step).map((s) => ({ step: s, rgba: GRID_COLOUR[s] }));
}

/** What a "Toggle ... Grid" does: the same size again switches the grid off, another one replaces it. */
export const toggleGrid = (current: GridSize, size: Exclude<GridSize, "none">): GridSize => (current === size ? "none" : size);

/** The World Editor's Grid key (G) goes round: none, large, medium, small, none (we-drive, five presses on
 *  HillsbradCreek, 2026-11-10). */
const GRID_ROUND: readonly GridSize[] = ["none", "large", "medium", "small"];
export const nextGrid = (current: GridSize): GridSize => GRID_ROUND[(GRID_ROUND.indexOf(current) + 1) % GRID_ROUND.length];

// ---- layers ------------------------------------------------------------------------------

/** The World Editor's naval pathing colour: a half-transparent light red. Measured from its N view against the same
 *  view without it (we-drive, 2026-11-11): over land each channel came out as half the ground plus (255, 128, 128) / 2. */
export const NAVAL_BLOCKED: readonly number[] = [255, 128, 128, 128];
/** Over the map's edge (past the playable part) its naval view is a flat brown instead, the ground's texture and the
 *  edge's dark gone under it (we-drive, map 03's west edge, 2026-11-11: 108, 55, 15 all over; the darkened playable
 *  ground just inside came out as half of it plus half the light red, as anywhere else). */
export const NAVAL_EDGE: readonly number[] = [108, 55, 15, 255];

/** The tiles past the playable map (the renderer's edgeTiles: 1 per tile, rows from the south) of a map `tilesX` wide. */
export interface EdgeTiles { tiles: ArrayLike<number>; tilesX: number }

/** Where ships can't sail (per pathing cell, 4 by 4 per tile, rows from the south), as the World Editor shows it: red
 *  over every cell without water for ships (land, what blocks them), nothing over water they sail, shallow or deep, and
 *  the map's edge brown: the cells of the tiles past the playable map (`edge`, as the border's shade: by the w3i's
 *  complements; that the naval view follows them too is assumed, not measured on a map whose marks disagree). Over the edge's water the editor's black water lies on top (the renderer's
 *  darkWaterCorners): HillsbradCreek's west border, a deep lake, stays black in its naval view (we-drive, 2026-11-12). */
export function navalColors(cells: ArrayLike<number>, edge?: EdgeTiles | null): Uint8Array {
  const rgba = new Uint8Array(cells.length * 4);
  const width = edge ? edge.tilesX * 4 : 0;
  for (let i = 0; i < cells.length; i++) {
    if (edge && width > 0 && edge.tiles[Math.floor(i / width / 4) * edge.tilesX + ((i % width) >> 2)]) { rgba.set(NAVAL_EDGE, i * 4); continue; }
    if (cells[i] & NO_WATER) rgba.set(NAVAL_BLOCKED, i * 4);
  }
  return rgba;
}

/** Over the map's edge (past the playable part) the World Editor's Pathing - Ground is a flat grey whatever the cells
 *  hold, water on or off (we-drive, border128x96, 2026-11-14: 137, 138, 137). */
export const GROUND_EDGE: readonly number[] = [137, 138, 137, 255];
/** Its regions are not dimmed there: the fill the playable part has, without the darker edge line (red 196, 27, 21 and
 *  yellow 194, 194, 6 for pure red and yellow, same measurement). */
const REGION_EDGE_ALPHA = 194;

/** Whether pathing cell `i` (row-major, `edge.tilesX * 4` wide, rows from the south) lies on a tile past the playable map. */
export function edgeCell(edge: EdgeTiles | null | undefined, i: number): boolean {
  if (!edge || !(edge.tilesX > 0)) return false;
  const width = edge.tilesX * 4;
  return !!edge.tiles[Math.floor(i / width / 4) * edge.tilesX + ((i % width) >> 2)];
}

/** `rgba` (per pathing cell) cut in two at the map's edge: what lies over the playable part, and what lies over the
 *  tiles past it (the other half left clear). The editor draws the edge's part over the water, the other under it. */
export function splitEdge(rgba: Uint8Array, edge: EdgeTiles): { inside: Uint8Array; over: Uint8Array } {
  const inside = new Uint8Array(rgba), over = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length / 4; i++) {
    if (!edgeCell(edge, i)) continue;
    over.set(rgba.subarray(i * 4, i * 4 + 4), i * 4);
    inside.fill(0, i * 4, i * 4 + 4);
  }
  return { inside, over };
}

/** Pathing - Ground (per pathing cell, rows from the south), in the World Editor's colours: magenta where nothing
 *  walks, blue where units walk but nothing can be built (we-drive, map 03's lake and its shore, 2026-11-09). Deep
 *  water's cells are magenta too, but the editor lays the layer on the ground, under the water: deep water hides it
 *  in SD and HD alike, shallow water lets it show through faintly, and View > Water off shows it all (we-drive, a copy of
 *  (2)EchoIsles' south shore, 2026-11-13). The renderer draws the view layer before the water, so Studio does the same. */
export function groundPathingColors(cells: ArrayLike<number>, edge?: EdgeTiles | null): Uint8Array {
  const rgba = new Uint8Array(cells.length * 4);
  for (let i = 0; i < cells.length; i++) {
    if (edgeCell(edge, i)) { rgba.set(GROUND_EDGE, i * 4); continue; }
    const c = cells[i];
    if (c & NO_WALK) rgba.set([230, 40, 230, 150], i * 4);
    else if (c & NO_BUILD) rgba.set([40, 90, 255, 140], i * 4);
  }
  return rgba;
}

export interface RegionBox { left: number; bottom: number; right: number; top: number; color?: { red: number; green: number; blue: number } }

/** The Regions layer (per pathing cell of `width` × `height`, rows from the south, the map's corner at `offsetX`,
 *  `offsetY`): each region filled with its colour and edged darker, larger ones first so that small ones stay on top. */
export function regionColors(regions: readonly RegionBox[], width: number, height: number, offsetX: number, offsetY: number, edge?: EdgeTiles | null): Uint8Array {
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
        const i = y * width + x;
        if (edgeCell(edge, i)) { rgba.set([c.red, c.green, c.blue, REGION_EDGE_ALPHA], i * 4); continue; }
        const rim = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
        rgba.set(rim ? [c.red * 0.3, c.green * 0.3, c.blue * 0.3, 235] : [c.red, c.green, c.blue, 170], i * 4);
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
