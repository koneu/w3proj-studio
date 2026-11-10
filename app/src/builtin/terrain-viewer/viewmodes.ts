// What the terrain view shows, as the World Editor's View menu has it: each layer on or off, the terrain textured,
// as a wireframe or hidden, and game view (View > Lock to Game View Settings, key V), which shows the map as the
// game would and nothing of the editor's own. And the World Editor's keys for those items in the view.
// No editor state here: the viewer passes what it has, the tests pass made-up values.

import type { GridSize } from "./viewcmds";

export type TerrainLook = "textured" | "wireframe" | "hidden";
export const TERRAIN_LOOKS: readonly TerrainLook[] = ["textured", "wireframe", "hidden"];
/** View > Terrain's key (Ctrl+T) goes round: textured, wireframe, hidden (the World Editor, we-drive 2026-11-09). */
export const nextTerrainLook = (t: TerrainLook): TerrainLook => TERRAIN_LOOKS[(TERRAIN_LOOKS.indexOf(t) + 1) % TERRAIN_LOOKS.length];

/** Everything the view can show or leave out. The first group is what the map looks like, the second the editor's
 *  own marks over it. */
export interface ViewSet {
  terrain: TerrainLook;
  doodads: boolean;
  units: boolean;
  water: boolean;
  blight: boolean;
  cliffs: boolean;
  effects: boolean;
  weather: boolean;
  /** The map's day and night lighting (off: an even light). */
  lighting: boolean;
  fog: boolean;
  grid: GridSize;
  naval: boolean;
  heights: boolean;
  cameras: boolean;
  /** Pathing - Ground. */
  pathing: boolean;
  regions: boolean;
  lightRanges: boolean;
  /** View > Camera Bounds (B): a line round the map's camera bounds. */
  cameraBounds: boolean;
  /** View > Info Display (I): the start locations, and a ring round each unit that drops items. */
  info: boolean;
}

/** The layers that are a picture laid over the ground (built per pathing cell, see refreshLayers). */
export const GROUND_LAYERS = ["naval", "heights", "cameras", "pathing", "regions"] as const;
export type GroundLayer = (typeof GROUND_LAYERS)[number];
/** The layers a View command switches on and off. */
export type ToggleLayer = GroundLayer | "lightRanges" | "cameraBounds" | "doodads" | "units" | "blight" | "info";

export interface Shown extends ViewSet {
  /** The start locations and the start buildings drawn in their rings (with Info Display). */
  starts: boolean;
}

/**
 * What the view draws: the set as it is, or in game view the game's picture. The World Editor's game view greys out
 * every View item and draws the map as the game does: terrain textured, doodads, units, water, blight, lighting,
 * weather and fog on (TESTING.md: its fog map shows only fog colour with game view on), and none of the editor's
 * marks: no grid, pathing, regions, camera objects, camera bounds, light ranges or start locations (we-drive,
 * map 03 with regions, a camera, lights, every one of those items on, 2026-11-09). Turned off, the items are as they
 * were. Studio's own marks (height map, naval pathing) go with the editor's.
 *
 * Info Display (View menu, I, on by default) draws the start locations and a ring of white marks round every unit that
 * drops items; turned off, both go and the units stay as they are (we-drive, SD, a copy of (2)EchoIsles with footmen
 * of players 1, 2, 6, Neutral Hostile and Neutral Passive and one with an item set, 2026-11-09).
 */
export function shownView(set: ViewSet, gameView: boolean): Shown {
  if (!gameView) return { ...set, starts: set.info };
  return {
    terrain: "textured", doodads: true, units: true, water: true, blight: true, cliffs: true, effects: true, weather: true,
    lighting: true, fog: true,
    grid: "none", naval: false, heights: false, cameras: false, pathing: false, regions: false, lightRanges: false,
    cameraBounds: false, info: false, starts: false,
  };
}

// ---- info display ------------------------------------------------------------------------------

/** The ring Info Display draws round a unit that drops items (white, as the editor's marks). */
export const DROP_RING = { r: 44, rgb: [255, 255, 255] as [number, number, number] };

/** Info Display's rings: one round each placed unit with an item table or item sets of its own (start locations and
 *  items have none). */
export function dropRings(units: readonly { id: string; position: readonly number[]; itemTable?: number; itemSets?: readonly unknown[] }[]): RangeRing[] {
  const out: RangeRing[] = [];
  for (const u of units) {
    const drops = (u.itemTable ?? -1) >= 0 || (u.itemSets?.length ?? 0) > 0;
    const [x, y] = u.position;
    if (drops && u.id !== "sloc" && Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y, r: DROP_RING.r, rgb: DROP_RING.rgb });
  }
  return out;
}

/** Whether any of the ground layers is drawn. */
export const anyGroundLayer = (s: Pick<ViewSet, GroundLayer>) => GROUND_LAYERS.some((k) => s[k]);

// ---- light ranges ------------------------------------------------------------------------------

/** A circle on the ground: centre, radius, colour 0–255. */
export interface RangeRing { x: number; y: number; r: number; rgb: [number, number, number] }

/** The World Editor's Light Ranges colour (green). */
export const LIGHT_RANGE_RGB: [number, number, number] = [60, 255, 60];

/**
 * Light Ranges for one light of one placed object: a ring on the ground round where the light is (`pivot`, in the
 * model, through the object's `world` matrix: column-major 4×4) as far as it reaches (the attenuation's end, scaled
 * with the object), and a fainter one where it starts to fade, when that's nearer. None for a light that reaches nowhere.
 */
export function lightRings(world: ArrayLike<number>, pivot: readonly number[], light: { attenuationStart: number; attenuationEnd: number }): RangeRing[] {
  const [px, py, pz] = [pivot[0] ?? 0, pivot[1] ?? 0, pivot[2] ?? 0];
  const x = world[0] * px + world[4] * py + world[8] * pz + world[12];
  const y = world[1] * px + world[5] * py + world[9] * pz + world[13];
  // The object's size across: the length of its x axis.
  const scale = Math.hypot(world[0], world[1], world[2]);
  const end = light.attenuationEnd * scale, start = light.attenuationStart * scale;
  if (!(end > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return [];
  const rings: RangeRing[] = [{ x, y, r: end, rgb: LIGHT_RANGE_RGB }];
  if (start > 0 && start < end) rings.push({ x, y, r: start, rgb: [30, 150, 30] });
  return rings;
}

// ---- keys --------------------------------------------------------------------------------------
// The World Editor's keys in its terrain view are the default key bindings of the terrain view's commands
// (extension.json `contributes.keybindings`, all under `terrainFocus`); the user can change them (Keyboard Shortcuts).
// Its View items' keys come from its View menu (we-drive --view-menu): F Fog Effects, G grid, B camera bounds, V game
// view, Ctrl+T terrain, Ctrl+D doodads, Ctrl+U units, W water, H blight, L lighting, E weather, Ctrl+Shift+L light
// ranges, P and N pathing, I info display, Ctrl+R regions, Ctrl+M camera objects. Turning the selection toward the
// pointer is T, as F is Fog Effects. The view reads what a key is bound to (w3.keybindings.commandsFor) and keeps its
// own order: H and V mirror a selection or a paste before they are View keys.

// ---- camera keys -------------------------------------------------------------------------------

/** What a camera key does: pan by a share of the view's height (x right, y up on the screen), zoom (distance times
 *  `zoom`) or turn (radians, positive turns the view's left side away). */
export type CameraMove = { pan: [number, number] } | { zoom: number } | { turn: number };

/**
 * The World Editor's camera keys in its terrain view (we-drive, one press each on map 03 at distance 2200 with nothing
 * selected, 2026-11-09): an arrow (or the number pad's) moves the start location in the middle 48 pixels of 844 down
 * the picture, Shift+Up 210; Ctrl+Up and Ctrl+Down zoom in and out by about 11%; Ctrl+Left and Ctrl+Right turn the
 * view about 5°, its left side away for Left. Studio with these steps at the same camera (app-drive --camera
 * we:center,2200): 53 (at 1/17.5) and 261 (at 4.4 times that) before they were tuned to these; zoom 12.7% at 1.12.
 * Alt with an arrow, Insert, Delete, Page Up and Down, Home and End don't move the camera (with something selected the
 * Page keys, Home and End change it: selectionkeys.ts; so do Ctrl and the arrows, which nudge it). The pointer at the
 * view's edge scrolls it too (edgeScroll, below).
 */
export const CAMERA_STEPS = { pan: 1 / 19, fast: 3.8, zoom: 1.11, turn: (5 * Math.PI) / 180 };

const PAN = CAMERA_STEPS.pan, FAST = CAMERA_STEPS.pan * CAMERA_STEPS.fast;

/** What each camera command does (the World Editor's Camera - Translate, Translate Fast, Zoom and Rotate; their keys:
 *  the arrows and the number pad's, with Shift faster, Ctrl+Up and Down zoom, Ctrl+Left and Right turn). */
export const CAMERA_COMMANDS: Readonly<Record<string, CameraMove>> = {
  "w3.terrain.camera.panUp": { pan: [0, PAN] },
  "w3.terrain.camera.panDown": { pan: [0, -PAN] },
  "w3.terrain.camera.panLeft": { pan: [-PAN, 0] },
  "w3.terrain.camera.panRight": { pan: [PAN, 0] },
  "w3.terrain.camera.panUpFast": { pan: [0, FAST] },
  "w3.terrain.camera.panDownFast": { pan: [0, -FAST] },
  "w3.terrain.camera.panLeftFast": { pan: [-FAST, 0] },
  "w3.terrain.camera.panRightFast": { pan: [FAST, 0] },
  "w3.terrain.camera.zoomIn": { zoom: 1 / CAMERA_STEPS.zoom },
  "w3.terrain.camera.zoomOut": { zoom: CAMERA_STEPS.zoom },
  "w3.terrain.camera.rotateLeft": { turn: CAMERA_STEPS.turn },
  "w3.terrain.camera.rotateRight": { turn: -CAMERA_STEPS.turn },
};

/** The camera move of the first camera command among `commands` (what a key is bound to, the winner first), or null. */
export function cameraMoveOf(commands: readonly string[]): CameraMove | null {
  for (const c of commands) if (CAMERA_COMMANDS[c]) return CAMERA_COMMANDS[c];
  return null;
}

/** Screen-edge scrolling: the pointer within `edge` CSS pixels of the view's side scrolls toward it, `speed` view
 *  heights a second (about what a held arrow key does). */
export const EDGE_SCROLL = { edge: 6, speed: 1.5 };

/** Where the pointer at (x, y) in a view of `width` × `height` CSS pixels scrolls it: a direction per axis (x right,
 *  y up on the screen, each -1, 0 or 1), or null when it's not at an edge or outside the view. */
export function edgeScroll(x: number, y: number, width: number, height: number, edge = EDGE_SCROLL.edge): [number, number] | null {
  if (![x, y, width, height].every(Number.isFinite) || width <= edge * 4 || height <= edge * 4) return null;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const dx = x < edge ? -1 : x >= width - edge ? 1 : 0;
  const dy = y < edge ? 1 : y >= height - edge ? -1 : 0;
  return dx || dy ? [dx, dy] : null;
}

// ---- camera bounds -----------------------------------------------------------------------------

/** The Camera Bounds line's colour (light blue, as the World Editor's: we-drive, HillsbradCreek's west edge). */
export const CAMERA_BOUNDS_RGB: [number, number, number] = [150, 200, 255];

/** The corners of a map's camera bounds (war3map.w3i: lower left, upper right, upper left, lower right) in the order
 *  round, or null when they aren't all numbers. */
export function cameraBoundsCorners(info: { cameraBounds?: readonly number[] } | null | undefined): [number, number][] | null {
  const b = info?.cameraBounds;
  if (!Array.isArray(b) || b.length < 8 || !b.slice(0, 8).every((n) => Number.isFinite(n))) return null;
  const [x1, y1, x2, y2, x3, y3, x4, y4] = b;
  return [[x1, y1], [x4, y4], [x2, y2], [x3, y3]];
}

/** The points of a closed line through `corners` with no two more than `step` apart, so that it can follow the
 *  ground; at most `max` points (longer steps then). */
export function lineAlong(corners: readonly (readonly [number, number])[], step = 64, max = 4096): [number, number][] {
  if (corners.length < 2) return corners.map(([x, y]) => [x, y]);
  const edges = corners.map((a, i) => [a, corners[(i + 1) % corners.length]] as const);
  const total = edges.reduce((sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
  const s = Math.max(step, total / max);
  const out: [number, number][] = [];
  for (const [a, b] of edges) {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / s));
    for (let i = 0; i < n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  return out;
}
