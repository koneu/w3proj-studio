// What the MCP tools work out for placing things and looking at a map. No editor state in here:
// a tool passes what it read, and `random` so that tests can repeat a result.

import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { inArea, type Area } from "../../lib/terrain/area";
import type { Terrain } from "../../lib/terrain/w3e";

const TILE = 128;
/** The longest side of a text map, in characters. */
const MAP_SIZE = 64;

/** Spots on a jittered grid, like the Scatter brush, on the pathing grid. The outer part of an
 *  ellipse thins out, so a forest doesn't end in a line. */
export function scatterSpots(area: Area, spacing: number, shape: "ellipse" | "box", random: () => number) {
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

export interface Dressing { facing?: number; scale?: number; variation?: number }
interface Look { numVar: number; randScale: boolean; minScale: number; maxScale: number; fixedRot: number | null }
interface Dressed { variation: number; angle: number; scale: [number, number, number] }

/** What makes placed objects differ. What's asked for wins; with `vary` the rest is random within
 *  what the object's type allows, as the Scatter brush does. */
export function dress(e: Dressed, look: Look | null, asked: Dressing, vary: boolean, random: () => number) {
  const variations = look?.numVar ?? 1;
  if (asked.variation !== undefined) e.variation = Math.max(0, Math.min(variations - 1, Math.round(asked.variation)));
  else if (vary && variations > 1) e.variation = Math.floor(random() * variations);
  const degrees = look?.fixedRot ?? asked.facing;
  if (degrees !== undefined && degrees !== null) e.angle = (degrees * Math.PI) / 180;
  else if (vary) e.angle = random() * Math.PI * 2;
  if (asked.scale !== undefined) e.scale = [asked.scale, asked.scale, asked.scale];
  else if (vary && look?.randScale && look.maxScale > look.minScale) {
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

/** The camera that shows an area: `top` looks almost straight down. North stays up. */
export function viewOfArea(area: Area, ground: number, aspect: number, fov: number, top: boolean) {
  const width = area.right - area.left, height = area.top - area.bottom;
  const fit = Math.max(height, width / aspect) * 1.2;
  return {
    target: [(area.left + area.right) / 2, (area.bottom + area.top) / 2, ground] as [number, number, number],
    yaw: -Math.PI / 2, pitch: top ? 1.5 : 0.95, distance: Math.max(400, fit / 2 / Math.tan(fov / 2)),
  };
}
