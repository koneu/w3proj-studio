// A piece of a map on its own: what the clipboard holds, and meant for anything else that moves part
// of a map around, like the split map files in the open points. It's plain JSON with positions
// relative to its centre, and refers to nothing in an open map, so it can be saved, pasted into another
// map, or turned. Tile and cliff types are kept by name, as a map numbers them its own way.

import { setGroundHeight, setLayer, setWaterLevel, groundHeight, type Corner, type Terrain } from "./w3e";

export const FRAGMENT_FORMAT = "w3proj.fragment/1";

export interface FragmentObject {
  list: "doodads" | "units";
  /** From the fragment's centre, the height from the ground under it. */
  at: [number, number, number];
  /** Radians. */
  angle: number;
  /** The rest of the placed object, as its file has it. */
  entry: Record<string, unknown>;
}

/** A corner of the ground, with `texture` and `cliffTexture` numbering the fragment's own lists. */
export interface FragmentCorner {
  ground: number;
  /** The stored level: the word's top bits say where the map's border is, which is no part of this. */
  water: number;
  hasWater: boolean;
  texture: number;
  texExtra: number;
  variation: number;
  cliffVariation: number;
  cliffTexture: number;
  layer: number;
  ramp: boolean;
  blight: boolean;
  /** Painted as Boundary. */
  boundary: boolean;
}

export interface FragmentGround {
  /** Corner (0, 0), from the centre. */
  at: [number, number];
  /** In corners; rows run from the south. */
  width: number;
  height: number;
  tiles: string[];
  cliffs: string[];
  corners: FragmentCorner[];
}

export interface Fragment {
  format: typeof FRAGMENT_FORMAT;
  objects: FragmentObject[];
  ground?: FragmentGround;
}

/** Corners of a map, both ends included. */
export interface CornerArea { x0: number; y0: number; x1: number; y1: number }

export type Turn = "mirrorX" | "mirrorY" | "cw" | "ccw";

/** The World Editor's pathing cell: what's on it stays on it after a move. */
const CELL = 32;

export const snapped = (v: number) => Math.round(v / CELL) * CELL;

/** The middle of what's given, on a cell. */
export function centreOf(points: readonly (readonly number[])[]): [number, number] {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [snapped((Math.min(...xs) + Math.max(...xs)) / 2), snapped((Math.min(...ys) + Math.max(...ys)) / 2)];
}

interface Source { position: readonly number[]; angle: number }

export function fragmentOf(items: readonly { list: FragmentObject["list"]; entry: Source }[], groundAt: (x: number, y: number) => number, centre?: readonly [number, number]): Fragment {
  const [cx, cy] = centre ?? centreOf(items.map((i) => i.entry.position));
  return {
    format: FRAGMENT_FORMAT,
    objects: items.map(({ list, entry }) => {
      const { position, angle, ...rest } = structuredClone(entry) as Source & Record<string, unknown>;
      const [x, y, z] = position;
      return { list, at: [x - cx, y - cy, z - groundAt(x, y)], angle, entry: rest };
    }),
  };
}

/** A point from the centre, after a turn. */
export function turnOffset(turn: Turn, x: number, y: number): [number, number] {
  switch (turn) {
    // Not -x: that makes -0 of 0, which isn't the same number after JSON.
    case "mirrorX": return [0 - x, y];
    case "mirrorY": return [x, 0 - y];
    case "cw": return [y, 0 - x];
    case "ccw": return [0 - y, x];
  }
}

const FULL = Math.PI * 2;

/** A facing after a turn. */
export function turnAngle(turn: Turn, angle: number): number {
  const turned = { mirrorX: Math.PI - angle, mirrorY: -angle, cw: angle - Math.PI / 2, ccw: angle + Math.PI / 2 }[turn];
  return ((turned % FULL) + FULL) % FULL;
}

const TILE = 128;

/** The tile a world point is on, kept on the map. */
export function tileOf(t: Pick<Terrain, "width" | "height" | "offsetX" | "offsetY">, x: number, y: number): [number, number] {
  return [
    Math.max(0, Math.min(t.width - 2, Math.floor((x - t.offsetX) / TILE))),
    Math.max(0, Math.min(t.height - 2, Math.floor((y - t.offsetY) / TILE))),
  ];
}

/** The corners of the tiles between two tiles, either way round. */
export function areaBetween(a: readonly [number, number], b: readonly [number, number]): CornerArea {
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]) + 1, y1: Math.max(a[1], b[1]) + 1 };
}

/** The ground of an area, around `centre`. */
export function groundOf(t: Terrain, a: CornerArea, centre: readonly [number, number]): FragmentGround {
  const width = a.x1 - a.x0 + 1, height = a.y1 - a.y0 + 1;
  const corners: FragmentCorner[] = [];
  for (let y = a.y0; y <= a.y1; y++) for (let x = a.x0; x <= a.x1; x++) {
    const c = t.corners[y * t.width + x];
    corners.push({
      ground: groundHeight(c), water: c.rawWater & 0x3fff, hasWater: c.hasWater, texture: c.texture, texExtra: c.texExtra,
      variation: c.variation, cliffVariation: c.cliffVariation, cliffTexture: c.cliffTexture, layer: c.layer, ramp: c.ramp, blight: c.blight, boundary: c.boundary,
    });
  }
  return {
    at: [t.offsetX + a.x0 * TILE - centre[0], t.offsetY + a.y0 * TILE - centre[1]],
    width, height, tiles: [...t.groundTiles], cliffs: [...t.cliffTiles], corners,
  };
}

/** The same ground mirrored or turned: the corners move, what's on each stays. */
export function turnGround(g: FragmentGround, turn: Turn): FragmentGround {
  const { width: w, height: h } = g, quarter = turn === "cw" || turn === "ccw";
  const width = quarter ? h : w, height = quarter ? w : h;
  const corners = new Array<FragmentCorner>(g.corners.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [nx, ny] = { mirrorX: [w - 1 - x, y], mirrorY: [x, h - 1 - y], cw: [y, w - 1 - x], ccw: [h - 1 - y, x] }[turn];
    corners[ny * width + nx] = g.corners[y * w + x];
  }
  const east = g.at[0] + (w - 1) * TILE, north = g.at[1] + (h - 1) * TILE;
  const at: [number, number] = { mirrorX: [0 - east, g.at[1]], mirrorY: [g.at[0], 0 - north], cw: [g.at[1], 0 - east], ccw: [0 - north, g.at[0]] }[turn] as [number, number];
  return { ...g, at, width, height, corners };
}

/** Where corner (0, 0) of the ground lands when the centre is put at (x, y). */
export function groundOrigin(t: Terrain, g: FragmentGround, x: number, y: number): [number, number] {
  return [Math.round((x + g.at[0] - t.offsetX) / TILE), Math.round((y + g.at[1] - t.offsetY) / TILE)];
}

/** Puts ground on the map, with corner (0, 0) at corner `origin`; what falls off the map is left out. The
 *  border marks stay the map's own. `tiles` and `cliffs` give this map's number for the fragment's. */
export function stampGround(t: Terrain, g: FragmentGround, origin: readonly [number, number], tiles: readonly number[], cliffs: readonly number[]) {
  const before = new Map<number, Corner>(), after = new Map<number, Corner>();
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
    const mx = origin[0] + x, my = origin[1] + y;
    if (mx < 0 || my < 0 || mx >= t.width || my >= t.height) continue;
    const i = my * t.width + mx, c = t.corners[i], from = g.corners[y * g.width + x];
    before.set(i, { ...c });
    setLayer(c, from.layer);
    setGroundHeight(c, from.ground);
    setWaterLevel(c, from.water);
    Object.assign(c, {
      hasWater: from.hasWater, texture: tiles[from.texture] ?? 0, texExtra: from.texExtra, variation: from.variation,
      cliffVariation: from.cliffVariation, cliffTexture: cliffs[from.cliffTexture] ?? from.cliffTexture, ramp: from.ramp, blight: from.blight, boundary: from.boundary,
    });
    after.set(i, { ...c });
  }
  const restore = (saved: Map<number, Corner>) => { for (const [i, c] of saved) t.corners[i] = { ...c }; };
  return { corners: [...before.keys()], undo: () => restore(before), redo: () => restore(after) };
}

export function turnFragment(f: Fragment, turn: Turn): Fragment {
  return {
    ...f,
    ...(f.ground ? { ground: turnGround(f.ground, turn) } : {}),
    objects: f.objects.map((o) => {
      const [x, y] = turnOffset(turn, o.at[0], o.at[1]);
      return { ...o, at: [x, y, o.at[2]], angle: turnAngle(turn, o.angle) };
    }),
  };
}
