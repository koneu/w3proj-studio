// What the MCP tools work out for placing things and looking at a map. No editor state in here:
// a tool passes what it read, and `random` so that tests can repeat a result.

import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { distanceToLine, inArea, type Area } from "../../lib/terrain/area";
import { groundHeight, heightAt, randomVariation, setGroundHeight, type Terrain } from "../../lib/terrain/w3e";

const TILE = 128;
/** The longest side of a text map, in characters. */
const MAP_SIZE = 64;

/** Spots on a jittered grid, like the Scatter brush, on the pathing grid. The outer part of an
 *  ellipse thins out, so a forest doesn't end in a line. */
export function scatterSpots(area: Area, spacing: number, shape: Shape, random: () => number) {
  const out: { x: number; y: number }[] = [];
  const cx = (area.left + area.right) / 2, cy = (area.bottom + area.top) / 2;
  const rx = (area.right - area.left) / 2, ry = (area.top - area.bottom) / 2;
  for (let gy = area.bottom + spacing / 2; gy < area.top; gy += spacing) {
    for (let gx = area.left + spacing / 2; gx < area.right; gx += spacing) {
      const x = Math.round((gx + (random() - 0.5) * spacing * 0.6) / 32) * 32;
      const y = Math.round((gy + (random() - 0.5) * spacing * 0.6) / 32) * 32;
      if (!inArea(x, y, area)) continue;
      if (shape === "ellipse") {
        const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
        if (r > 1 || (r > 0.7 && random() > (1 - r) / 0.3)) continue;
      }
      out.push({ x, y });
    }
  }
  return out;
}

export interface Dressing { facing?: number; scale?: number; scaleRange?: [number, number]; variation?: number }
interface Look { numVar: number; randScale: boolean; minScale: number; maxScale: number; fixedRot: number | null }
interface Dressed { variation: number; angle: number; scale: [number, number, number] }

/** What makes placed objects differ. What's asked for wins; with `vary` the rest is random within
 *  what the object's type allows, as the Scatter brush does. */
export function dress(e: Dressed, look: Look | null, asked: Dressing, vary: boolean, random: () => number) {
  if (asked.scaleRange) {
    const k = asked.scaleRange[0] + random() * (asked.scaleRange[1] - asked.scaleRange[0]);
    e.scale = [k, k, k];
  }
  const variations = look?.numVar ?? 1;
  if (asked.variation !== undefined) e.variation = Math.max(0, Math.min(variations - 1, Math.round(asked.variation)));
  else if (vary && variations > 1) e.variation = Math.floor(random() * variations);
  const degrees = look?.fixedRot ?? asked.facing;
  if (degrees !== undefined && degrees !== null) e.angle = (degrees * Math.PI) / 180;
  else if (vary) e.angle = random() * Math.PI * 2;
  if (asked.scale !== undefined) e.scale = [asked.scale, asked.scale, asked.scale];
  else if (!asked.scaleRange && vary && look?.randScale && look.maxScale > look.minScale) {
    const k = look.minScale + random() * (look.maxScale - look.minScale);
    e.scale = [k, k, k];
  }
}

interface Pathing { cells: Uint8Array; width: number; height: number }

/** A text map of an area: rows from the north, one character for `step` tiles. */
export function textMap(t: Terrain, p: Pathing, area: Area) {
  const tiles = Math.ceil(Math.max(area.right - area.left, area.top - area.bottom) / TILE);
  const step = Math.max(1, Math.ceil(tiles / MAP_SIZE)), size = step * TILE;
  const x0 = Math.floor((area.left - t.offsetX) / size) * size + t.offsetX;
  const y0 = Math.floor((area.bottom - t.offsetY) / size) * size + t.offsetY;
  const symbol = (wx: number, wy: number) => {
    let free = 0, walk = 0, water = 0, blocked = 0;
    for (let cy = (wy - t.offsetY) / 32; cy < (wy + size - t.offsetY) / 32; cy++) {
      for (let cx = (wx - t.offsetX) / 32; cx < (wx + size - t.offsetX) / 32; cx++) {
        if (cx < 0 || cy < 0 || cx >= p.width || cy >= p.height) continue;
        const c = p.cells[cy * p.width + cx];
        if (!(c & NO_WATER)) water++;
        else if (c & NO_WALK) blocked++;
        else if (c & NO_BUILD) walk++;
        else free++;
      }
    }
    // A tree covers a sixteenth of a tile, so anything blocked at all shows.
    const most = Math.max(free, walk, water);
    return !most && !blocked ? " " : blocked ? "#" : most === water ? "~" : most === walk ? "," : ".";
  };
  const rows: string[] = [];
  for (let wy = y0 + Math.floor((area.top - y0 - 1) / size) * size; wy >= y0; wy -= size) {
    let row = "";
    for (let wx = x0; wx < area.right; wx += size) row += symbol(wx, wy);
    rows.push(row);
  }
  return { left: x0, top: y0 + (rows.length * size), cellSize: size, rows };
}

export type Shape = "ellipse" | "box";

/** How far a point is from the middle of an area: 0 there, 1 at its edge, more outside. */
function reach(area: Area, shape: Shape, x: number, y: number) {
  const dx = Math.abs(x - (area.left + area.right) / 2) / ((area.right - area.left) / 2);
  const dy = Math.abs(y - (area.bottom + area.top) / 2) / ((area.top - area.bottom) / 2);
  return shape === "ellipse" ? Math.hypot(dx, dy) : Math.max(dx, dy);
}

/** The corners of an area that aren't the map's unplayable boundary, with their reach. */
function cornersIn(t: Terrain, area: Area, shape: Shape) {
  const out: { i: number; r: number }[] = [];
  for (let y = 0; y < t.height; y++) {
    for (let x = 0; x < t.width; x++) {
      const i = y * t.width + x, r = reach(area, shape, t.offsetX + x * TILE, t.offsetY + y * TILE);
      if (r <= 1 && !t.corners[i].boundary) out.push({ i, r });
    }
  }
  return out;
}

/** The slot of a ground tile, added to the map's list if needed. */
export function groundSlot(t: Terrain, tile: string): number {
  const at = t.groundTiles.indexOf(tile);
  if (at >= 0) return at;
  if (t.groundTiles.length >= 16) throw new Error(`This map already has 16 ground tiles (${t.groundTiles.join(", ")}). Use one of those.`);
  t.groundTiles.push(tile);
  return t.groundTiles.length - 1;
}

/** Paints corners with a tile. `edge` (0 to 1) is how much of the outside thins out, so the
 *  patch doesn't end in a line. The changed corners. */
export function paintCorners(t: Terrain, area: Area, shape: Shape, slot: number, edge: number, random: () => number) {
  const changed: number[] = [];
  for (const { i, r } of cornersIn(t, area, shape)) {
    if (edge > 0 && r > 1 - edge && random() > (1 - r) / edge) continue;
    const c = t.corners[i];
    if (c.texture === slot) continue;
    c.texture = slot;
    c.variation = randomVariation();
    changed.push(i);
  }
  return changed;
}

/** Paints a trail along points, frayed along its sides and at its ends. With `flatten` the ground
 *  across it is levelled towards the height along its middle. The changed corners. */
export function paintPath(t: Terrain, points: readonly [number, number][], width: number, slot: number, edge: number, flatten: boolean, random: () => number) {
  const half = width / 2, changed = new Set<number>();
  const middle = (x: number, y: number) => {
    let best: [number, number] = points[0], gap = Infinity;
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, ay] = points[i], [bx, by] = points[i + 1], dx = bx - ax, dy = by - ay, span = dx * dx + dy * dy || 1;
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / span)), px = ax + k * dx, py = ay + k * dy, d = Math.hypot(x - px, y - py);
      if (d < gap) { gap = d; best = [px, py]; }
    }
    return best;
  };
  // Heights are read before any changes, and along the way, or the path would dig into itself.
  const before = flatten ? { ...t, corners: t.corners.map((c) => ({ ...c })) } : t;
  for (let y = 0; y < t.height; y++) {
    for (let x = 0; x < t.width; x++) {
      const i = y * t.width + x, c = t.corners[i], wx = t.offsetX + x * TILE, wy = t.offsetY + y * TILE;
      if (c.boundary) continue;
      const r = distanceToLine(wx, wy, points) / half;
      if (r > 1) continue;
      if (flatten) {
        const [mx, my] = middle(wx, wy), raw = c.rawHeight;
        const w = 0.5 + 0.5 * Math.cos(Math.PI * r), layerLift = (c.layer - 2) * TILE;
        const g = groundHeight(c), target = heightAt(before, mx, my) - layerLift;
        setGroundHeight(c, g + (target - g) * w);
        if (c.rawHeight !== raw) changed.add(i);
      }
      if ((edge > 0 && r > 1 - edge && random() > (1 - r) / edge) || c.texture === slot) continue;
      c.texture = slot;
      c.variation = randomVariation();
      changed.add(i);
    }
  }
  return [...changed];
}

export type SculptMode = "raise" | "lower" | "flatten" | "smooth";

/** Reshapes the ground, strongest in the middle and fading to nothing at the edge, so it makes no
 *  steps. flatten goes towards `amount`, or the area's average; smooth stays within a cliff level. */
export function sculptCorners(t: Terrain, area: Area, shape: Shape, mode: SculptMode, amount: number | undefined) {
  const inside = cornersIn(t, area, shape);
  const fade = (r: number) => 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, r));
  const heights = t.corners.map(groundHeight);
  const level = amount ?? inside.reduce((sum, { i }) => sum + heights[i], 0) / Math.max(1, inside.length);
  const around = (i: number) => {
    const x = i % t.width, y = Math.floor(i / t.width);
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ox = x + dx, oy = y + dy;
        if (ox < 0 || oy < 0 || ox >= t.width || oy >= t.height) continue;
        const o = oy * t.width + ox;
        if (t.corners[o].layer === t.corners[i].layer) { sum += heights[o]; n++; }
      }
    }
    return sum / n;
  };
  const changed: number[] = [];
  for (const { i, r } of inside) {
    const g = heights[i], w = fade(r);
    const next = mode === "raise" ? g + (amount ?? 64) * w : mode === "lower" ? g - (amount ?? 64) * w
      : mode === "flatten" ? g + (level - g) * w : g + (around(i) - g) * w;
    const before = t.corners[i].rawHeight;
    setGroundHeight(t.corners[i], next);
    if (t.corners[i].rawHeight !== before) changed.push(i);
  }
  return changed;
}

interface Follower { position: number[]; flags?: number }

/** Puts objects near changed corners back on the ground, as the terrain editor does: all units and
 *  items, and doodads unless they have a fixed height (flag 4). How many moved. */
export function followGround(list: Follower[], t: Terrain, corners: number[], doodads: boolean) {
  if (!corners.length) return 0;
  const xs = corners.map((i) => i % t.width), ys = corners.map((i) => Math.floor(i / t.width));
  // Tiles next to a changed corner change too.
  const near = {
    left: t.offsetX + (Math.min(...xs) - 1) * TILE, right: t.offsetX + (Math.max(...xs) + 1) * TILE,
    bottom: t.offsetY + (Math.min(...ys) - 1) * TILE, top: t.offsetY + (Math.max(...ys) + 1) * TILE,
  };
  let moved = 0;
  for (const p of list) {
    if ((doodads && (p.flags ?? 0) & 4) || !inArea(p.position[0], p.position[1], near)) continue;
    const z = heightAt(t, p.position[0], p.position[1]);
    if (Math.abs(z - p.position[2]) > 0.01) { p.position = [p.position[0], p.position[1], z]; moved++; }
  }
  return moved;
}

/** Ground heights of an area as rows of numbers from the north, at most 33 × 33. */
export function heightGrid(t: Terrain, area: Area) {
  const step = Math.max(1, Math.ceil(Math.max(area.right - area.left, area.top - area.bottom) / TILE / 32));
  const size = step * TILE;
  const left = Math.ceil((area.left - t.offsetX) / size) * size + t.offsetX;
  const top = Math.floor((area.top - t.offsetY) / size) * size + t.offsetY;
  const rows: number[][] = [];
  for (let y = top; y >= area.bottom; y -= size) {
    const row: number[] = [];
    for (let x = left; x <= area.right; x += size) row.push(Math.round(heightAt(t, x, y)));
    rows.push(row);
  }
  return { left, top, cellSize: size, rows };
}

/** A colour for every pathing cell (rows from the south): blue low to red high, with a dark line
 *  every `step` units of height, so a picture shows slopes that the light hides. */
export function heightColors(t: Terrain, step = 32) {
  const width = (t.width - 1) * 4, height = (t.height - 1) * 4;
  const zs = new Float32Array(width * height);
  let low = Infinity, high = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const z = heightAt(t, t.offsetX + (x + 0.5) * 32, t.offsetY + (y + 0.5) * 32);
      zs[y * width + x] = z;
      low = Math.min(low, z);
      high = Math.max(high, z);
    }
  }
  const rgba = new Uint8Array(width * height * 4), span = Math.max(1, high - low);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x, band = Math.floor(zs[i] / step), k = (zs[i] - low) / span;
      const line = (x > 0 && Math.floor(zs[i - 1] / step) !== band) || (y > 0 && Math.floor(zs[i - width] / step) !== band);
      rgba.set(line ? [0, 0, 0, 220] : [Math.round(255 * k), 90, Math.round(255 * (1 - k)), 110], i * 4);
    }
  }
  return { rgba, width, height };
}

/** Evenly along a line, from end to end, turned to run along it. `facingOffset` is the facing
 *  (degrees) that makes the model's long side follow the line. */
export function lineSpots(from: [number, number], to: [number, number], spacing: number, facingOffset: number) {
  const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
  const count = Math.max(1, Math.round(length / spacing));
  const facing = (((Math.atan2(dy, dx) * 180) / Math.PI + facingOffset) % 360 + 360) % 360;
  return Array.from({ length: count + 1 }, (_, i) => ({ x: from[0] + (dx * i) / count, y: from[1] + (dy * i) / count, facing }));
}

/** Where to look for room when a spot is taken: rings around it, nearest first, on the pathing grid. */
export function spotsAround(x: number, y: number, reach = 320): [number, number][] {
  const out: [number, number][] = [];
  for (let d = 32; d <= reach; d += 32) {
    for (let a = 0; a < 8 + d / 16; a++) {
      const angle = (a / (8 + d / 16)) * Math.PI * 2;
      out.push([Math.round((x + Math.cos(angle) * d) / 32) * 32, Math.round((y + Math.sin(angle) * d) / 32) * 32]);
    }
  }
  return out;
}

/** What the ground in an area is like. */
export function terrainSummary(t: Terrain, p: Pathing, area: Area) {
  const counts = new Map<string, number>();
  const layers = new Set<number>();
  let lowest = Infinity, highest = -Infinity, corners = 0, water = 0, ramps = 0, blight = 0;
  for (let y = 0; y < t.height; y++) {
    for (let x = 0; x < t.width; x++) {
      if (!inArea(t.offsetX + x * TILE, t.offsetY + y * TILE, area)) continue;
      const c = t.corners[y * t.width + x];
      corners++;
      const tile = t.groundTiles[c.texture] ?? String(c.texture);
      counts.set(tile, (counts.get(tile) ?? 0) + 1);
      layers.add(c.layer);
      lowest = Math.min(lowest, c.height);
      highest = Math.max(highest, c.height);
      if (c.hasWater && c.water > c.height) water++;
      if (c.ramp) ramps++;
      if (c.blight) blight++;
    }
  }
  if (!corners) throw new Error("That area is outside the map.");
  const share = (n: number) => Math.round((n / corners) * 100);
  return {
    area, tileset: t.tileset,
    height: { lowest: Math.round(lowest), highest: Math.round(highest) },
    cliffLevels: [...layers].sort((a, b) => a - b),
    percent: { water: share(water), ramps: share(ramps), blight: share(blight) },
    groundTiles: [...counts].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, percent: share(n) })),
    map: textMap(t, p, area),
    legend: { ".": "free ground", ",": "walkable, can't build", "#": "at least partly blocked: cliffs, trees, doodads", "~": "water" },
  };
}

const PITCH = { top: 1.5, angled: 0.95, low: 0.42 };
export type ViewAngle = keyof typeof PITCH;

/** The camera that shows an area, north up: top is almost straight down, low shows the skyline. */
export function viewOfArea(area: Area, ground: number, aspect: number, fov: number, angle: ViewAngle) {
  const width = area.right - area.left, height = area.top - area.bottom;
  const fit = Math.max(height, width / aspect) * 1.2;
  return {
    target: [(area.left + area.right) / 2, (area.bottom + area.top) / 2, ground] as [number, number, number],
    yaw: -Math.PI / 2, pitch: PITCH[angle], distance: Math.max(400, fit / 2 / Math.tan(fov / 2)),
  };
}
