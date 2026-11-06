// What the MCP tools work out for placing things and looking at a map. No editor state in here:
// a tool passes what it read, and `random` so that tests can repeat a result.

import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { distanceToLine, inArea, type Area } from "../../lib/terrain/area";
import { NO_BUILD as CELL_NO_BUILD, NO_WALK as CELL_NO_WALK } from "../../lib/terrain/pathing";
import { matchCliffTypes, toggleRamp } from "../../lib/terrain/cliffs";
import { groundHeight, heightAt, randomVariation, setGroundHeight, setLayer, setWaterLevel, waterLevelAt, WATER_OFFSET, type Terrain } from "../../lib/terrain/w3e";

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

/** Numbers in 0..1 from a seed: the same seed gives the same layout. */
export function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** A cliff type of the game (CliffTypes.slk) and the ground tile it belongs to. */
export interface CliffKind { cliffID: string; groundTile: string }

/** Remembers which corners shared terrain code changed. */
class Touched {
  readonly corners = new Set<number>();
  touch(_t: Terrain, i: number) { this.corners.add(i); }
}

/** What a corner's cliff type number means: the map's ground tiles that have a cliff version,
 *  in order (see cliffList). */
function cliffGrounds(t: Terrain, kinds: readonly CliffKind[]) {
  return t.groundTiles.filter((g) => kinds.some((k) => k.groundTile === g));
}

/** Cliffs next to changed corners take the type of their ground, as after a brush stroke. All the
 *  corners changed, those of the cliffs included. */
export function withCliffTypes(t: Terrain, changed: number[], kinds: readonly CliffKind[], cliffTile?: string) {
  const grounds = cliffGrounds(t, kinds), log = new Touched();
  for (const i of changed) log.corners.add(i);
  let fixed: number | undefined;
  if (cliffTile !== undefined) {
    if (kinds.some((k) => k.groundTile === cliffTile)) { groundSlot(t, cliffTile, kinds); grounds.splice(0, grounds.length, ...cliffGrounds(t, kinds)); }
    fixed = grounds.indexOf(cliffTile);
    if (fixed < 0) throw new Error(`"${cliffTile}" has no cliff. The map's cliffs are those of: ${grounds.join(", ") || "none"}. list_ground_tiles marks the tiles that have one.`);
  }
  matchCliffTypes(t, changed, grounds, log, fixed);
  return [...log.corners];
}

/** Takes away the whole ramp a corner belongs to: part of one is no way up. The corners go on `changed`. */
function dropRamp(t: Terrain, i: number, changed: number[]) {
  if (!t.corners[i].ramp) return;
  const todo = [i];
  while (todo.length) {
    const k = todo.pop() as number;
    if (!t.corners[k]?.ramp) continue;
    t.corners[k].ramp = false;
    changed.push(k);
    const x = k % t.width;
    todo.push(...(x > 0 ? [k - 1] : []), ...(x < t.width - 1 ? [k + 1] : []), k - t.width, k + t.width);
  }
}

/** The corner nearest the middle of those given. */
const middleOf = (corners: readonly { i: number; r: number }[]) => corners.reduce((a, b) => (b.r < a.r ? b : a));

/** Brings the ground of an area to one cliff level: `level`, or `by` levels from where the middle
 *  of the area is. The changed corners, with their ramps gone: a ramp needs the levels it was
 *  built on. */
export function setCliffs(t: Terrain, area: Area, shape: Shape, target: { level?: number; by?: number }, kinds: readonly CliffKind[], cliffTile?: string) {
  const inside = cornersIn(t, area, shape);
  if (!inside.length) throw new Error("That area has no ground in the map.");
  const level = target.level ?? t.corners[middleOf(inside).i].layer + (target.by ?? 0);
  if (level < 0 || level > 15) throw new Error(`Cliff levels go from 0 to 15, and this would be ${level}.`);
  const changed: number[] = [];
  for (const { i } of inside) {
    const c = t.corners[i];
    if (c.layer === level) continue;
    setLayer(c, level);
    dropRamp(t, i, changed);
    changed.push(i);
  }
  if (changed.length) return withCliffTypes(t, changed, kinds, cliffTile);
  return cliffTile === undefined ? changed : setCliffType(t, area, shape, cliffTile, kinds);
}

/** Gives the cliffs of an area the look of a ground tile's cliff, adding that tile to the map's list
 *  if needed: any tileset's cliffs work. The changed corners. */
export function setCliffType(t: Terrain, area: Area, shape: Shape, tile: string, kinds: readonly CliffKind[]) {
  const inside = cornersIn(t, area, shape);
  if (!inside.length) throw new Error("That area has no ground in the map.");
  if (!kinds.some((k) => k.groundTile === tile)) throw new Error(`"${tile}" has no cliff. list_ground_tiles marks the tiles that have one.`);
  groundSlot(t, tile, kinds);
  const grounds = cliffGrounds(t, kinds), log = new Touched();
  matchCliffTypes(t, inside.map(({ i }) => i), grounds, log, grounds.indexOf(tile));
  return [...log.corners];
}

export type WaterMode = "shallow" | "deep" | "dry" | "ford" | "lake";

/** Depth in the middle of sloped water. Units walk through up to 52 (the game's limit in this app's
 *  pathing); 38 is what the game's shallow water has, 102 the usual depth of Echo Isles' sea. */
const SLOPED_DEPTH = { ford: 38, lake: 102 } as const;
/** How far in from its rim, as part of the way to the middle, a slope takes to reach full depth. */
const BANK = 0.45;

/** Corners within `width` of a line, as cornersIn gives them: r is 0 on the line, 1 at its edge. */
function cornersAlong(t: Terrain, points: readonly [number, number][], width: number) {
  const out: { i: number; r: number }[] = [];
  for (let y = 0; y < t.height; y++) {
    for (let x = 0; x < t.width; x++) {
      const i = y * t.width + x, r = distanceToLine(t.offsetX + x * TILE, t.offsetY + y * TILE, points) / (width / 2);
      if (r <= 1 && !t.corners[i].boundary) out.push({ i, r });
    }
  }
  return out;
}

/** Water with no cliff around it, as real maps mostly have: on one cliff level, the ground slopes
 *  down under the surface, so units can walk in. The surface goes by dry ground, or by water that's
 *  there already. Ground only goes down. Corners on other cliff levels stay. */
function slopedWater(t: Terrain, inside: readonly { i: number; r: number }[], depth: number) {
  const showing = inside.filter(({ i }) => t.corners[i].hasWater && t.corners[i].water > t.corners[i].height);
  const from = t.corners[middleOf(inside).i];
  const surface = showing.length ? t.corners[middleOf(showing).i].water : from.height - 8;
  const level = waterLevelAt(surface), changed: number[] = [];
  for (const { i, r } of inside) {
    const c = t.corners[i];
    if (c.layer !== from.layer) continue;
    const k = Math.min(1, (1 - r) / BANK), s = k * k * (3 - 2 * k);
    const bottom = surface - depth, target = c.height + (bottom - c.height) * s;
    const before = c.rawHeight, wet = c.hasWater;
    if (target < c.height) setGroundHeight(c, target - (c.layer - 2) * TILE);
    dropRamp(t, i, changed);
    setWaterLevel(c, level);
    if (c.rawHeight !== before || !wet) changed.push(i);
  }
  return changed;
}

/** Puts water on an area or along a line. `ford` and `lake` slope in with no cliff around them.
 *  `shallow` and `deep` are the brushes': the ground one or two levels down, the surface just below
 *  where the ground was, so a cliff goes all round. They go by dry ground in the area, so widening
 *  a lake keeps its surface. `dry` only takes the water away: the ground stays down. The changed corners. */
export function setWater(t: Terrain, place: Area | { points: readonly [number, number][]; width: number }, shape: Shape, mode: WaterMode, kinds: readonly CliffKind[]) {
  const inside = "points" in place ? cornersAlong(t, place.points, place.width) : cornersIn(t, place, shape);
  if (!inside.length) throw new Error("That area has no ground in the map.");
  if (mode === "ford" || mode === "lake") return slopedWater(t, inside, SLOPED_DEPTH[mode]);
  const changed: number[] = [];
  if (mode === "dry") {
    for (const { i } of inside) if (t.corners[i].hasWater) { t.corners[i].hasWater = false; changed.push(i); }
    return changed;
  }
  const dry = inside.filter(({ i }) => !t.corners[i].hasWater);
  const from = t.corners[middleOf(dry.length ? dry : inside).i];
  const layer = dry.length ? from.layer - (mode === "deep" ? 2 : 1) : from.layer;
  if (layer < 0) throw new Error(`The ground here is at cliff level ${from.layer}, too low for ${mode} water. Raise it with set_cliff_level first.`);
  const surface = dry.length ? waterLevelAt(from.height - WATER_OFFSET) : from.rawWater & 0x3fff;
  for (const { i } of inside) {
    const c = t.corners[i];
    if (c.layer === layer && c.hasWater && (c.rawWater & 0x3fff) === surface) continue;
    setLayer(c, layer);
    dropRamp(t, i, changed);
    setWaterLevel(c, surface);
    changed.push(i);
  }
  return changed.length ? withCliffTypes(t, changed, kinds) : changed;
}

/** Why something can't stand at a place, as far as can be told from what's known there. */
export function whyNoRoom(t: Terrain, p: Pathing, standing: { id: string; position: readonly number[] } | null, x: number, y: number) {
  if (standing) return `${standing.id} stands there, at ${Math.round(standing.position[0])}, ${Math.round(standing.position[1])}`;
  const tx = Math.floor((x - t.offsetX) / TILE), ty = Math.floor((y - t.offsetY) / TILE);
  const at = (cx: number, cy: number) => (cx >= 0 && cy >= 0 && cx < t.width && cy < t.height ? t.corners[cy * t.width + cx] : undefined);
  const q = [at(tx, ty), at(tx + 1, ty), at(tx, ty + 1), at(tx + 1, ty + 1)].filter((c): c is NonNullable<typeof c> => !!c);
  if (new Set(q.map((c) => c.layer)).size > 1) return "a cliff runs through there";
  if (q.some((c) => c.hasWater && c.water > c.height)) return "there's water there";
  const cell = p.cells[Math.floor((y - t.offsetY) / 32) * p.width + Math.floor((x - t.offsetX) / 32)] ?? 0;
  if (cell & CELL_NO_WALK) return "the ground there can't be walked or built on, so it's the tile, or an object's pathing";
  if (cell & CELL_NO_BUILD) return "the ground there can't be built on, so it's the tile, or water close by";
  return "the spot itself is free, but this object's footprint reaches something beside it";
}

/** A place's twin on the other side of the map: turned 180° around the middle. */
export const twinOf = (x: number, y: number, whole: Area): [number, number] => [whole.left + whole.right - x, whole.bottom + whole.top - y];

/** Builds a ramp on the cliff edge at a place, or takes one away. `width` is in tiles. The changed
 *  corners. Throws what's in the way. */
export function setRamp(t: Terrain, x: number, y: number, width: number, remove: boolean) {
  const tx = Math.floor((x - t.offsetX) / TILE), ty = Math.floor((y - t.offsetY) / TILE);
  const at = (cx: number, cy: number) => (cx >= 0 && cy >= 0 && cx < t.width && cy < t.height ? t.corners[cy * t.width + cx] : undefined);
  const onRamp = [at(tx, ty), at(tx + 1, ty), at(tx, ty + 1), at(tx + 1, ty + 1)].some((c) => c?.ramp);
  if (onRamp && !remove) throw new Error("There's a ramp here already. Use remove to take it away.");
  if (!onRamp && remove) throw new Error("There's no ramp here.");
  const log = new Touched();
  const problem = toggleRamp(t, x, y, Math.round(width / 2), log);
  if (problem) throw new Error(`${problem.replace(/^Click (a|the)/, "It needs $1").replace("(try a smaller Size)", "(try a smaller width)")} terrain_info shows the cliff levels.`);
  return [...log.corners];
}

export type DropKind = "any" | "permanent" | "charged" | "powerup" | "artifact";
const DROP_LETTER: Record<DropKind, string> = { any: "Y", permanent: "i", charged: "j", powerup: "k", artifact: "l" };
/** What a placed unit can be told besides where it stands. */
export interface UnitChoices { camp?: unknown; acquireRange?: unknown; gold?: unknown; drops?: unknown }
interface UnitEntry { targetAcquisition?: number; gold?: number; itemSets?: { id: string; chance: number }[][] }

/** Applies what a tool asked of a placed unit, or with no entry only checks it. Each drop is one
 *  item set: a random item of that kind and level, as the game's melee maps have them. */
export function setUnitChoices(o: UnitChoices, e?: UnitEntry) {
  if (o.camp !== undefined && typeof o.camp !== "boolean") throw new Error("camp must be true or false.");
  if (o.acquireRange !== undefined && !(typeof o.acquireRange === "number" && o.acquireRange > 0 && o.acquireRange <= 5000)) throw new Error("acquireRange must be a distance above 0, up to 5000.");
  if (o.acquireRange !== undefined && o.camp === true) throw new Error("Give camp or acquireRange, not both.");
  if (o.gold !== undefined && !(Number.isInteger(o.gold) && (o.gold as number) >= 0 && (o.gold as number) <= 1000000)) throw new Error("gold must be a whole number up to 1000000.");
  const drops = o.drops === undefined ? undefined : o.drops as { level?: unknown; kind?: unknown }[];
  if (drops !== undefined && !Array.isArray(drops)) throw new Error("drops must be a list of { level, kind }.");
  const sets = drops?.map(({ level, kind }) => {
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 8) throw new Error("A drop's level goes from 1 to 8.");
    const letter = DROP_LETTER[(kind ?? "any") as DropKind];
    if (!letter) throw new Error(`A drop's kind is one of ${Object.keys(DROP_LETTER).join(", ")}.`);
    return [{ id: `Y${letter}I${level as number}`, chance: 100 }];
  });
  if (!e) return;
  if (o.camp !== undefined) e.targetAcquisition = o.camp ? -2 : -1;
  if (o.acquireRange !== undefined) e.targetAcquisition = o.acquireRange as number;
  if (o.gold !== undefined) e.gold = o.gold as number;
  if (sets) e.itemSets = sets;
}

/** The slot of a ground tile, added to the map's list if needed, with its cliff type if it has one
 *  (`kinds`), as painting with the brush does. */
export function groundSlot(t: Terrain, tile: string, kinds: readonly CliffKind[] = []): number {
  const at = t.groundTiles.indexOf(tile);
  if (at >= 0) return at;
  if (t.groundTiles.length >= 16) throw new Error(`This map already has 16 ground tiles (${t.groundTiles.join(", ")}). Use one of those.`);
  t.groundTiles.push(tile);
  // The list no longer matches the tileset's own: the game goes by this flag.
  t.customTilesets = true;
  t.customTilesetsRaw = 1;
  const cliff = kinds.find((k) => k.groundTile === tile);
  if (cliff && !t.cliffTiles.includes(cliff.cliffID)) t.cliffTiles.push(cliff.cliffID);
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
    c.variation = randomVariation(random);
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
      c.variation = randomVariation(random);
      changed.add(i);
    }
  }
  // Ground has a tile per corner, 128 apart: a thin line can pass between them and break up. The
  // corners nearest the line itself are always painted, so it stays in one piece.
  for (let k = 0; k + 1 < points.length; k++) {
    const [ax, ay] = points[k], [bx, by] = points[k + 1], steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 32));
    for (let n = 0; n <= steps; n++) {
      const x = Math.round((ax + ((bx - ax) * n) / steps - t.offsetX) / TILE), y = Math.round((ay + ((by - ay) * n) / steps - t.offsetY) / TILE);
      if (x < 0 || y < 0 || x >= t.width || y >= t.height) continue;
      const i = y * t.width + x, c = t.corners[i];
      if (c.boundary || c.texture === slot) continue;
      c.texture = slot;
      c.variation = randomVariation(random);
      changed.add(i);
    }
  }
  return [...changed];
}

export type SculptMode = "raise" | "lower" | "flatten" | "smooth" | "roughen";

/** Smooth random height, from about -1 to 1: broad swells with smaller bumps on them. */
function bumps(random: () => number) {
  const layer = (size: number) => {
    const grid = new Map<string, number>();
    const at = (x: number, y: number) => {
      const key = `${x},${y}`;
      if (!grid.has(key)) grid.set(key, random() * 2 - 1);
      return grid.get(key) as number;
    };
    const ease = (k: number) => k * k * (3 - 2 * k);
    return (x: number, y: number) => {
      const gx = Math.floor(x / size), gy = Math.floor(y / size), fx = ease(x / size - gx), fy = ease(y / size - gy);
      const bottom = at(gx, gy) + (at(gx + 1, gy) - at(gx, gy)) * fx, top = at(gx, gy + 1) + (at(gx + 1, gy + 1) - at(gx, gy + 1)) * fx;
      return bottom + (top - bottom) * fy;
    };
  };
  const wide = layer(6), middle = layer(3), small = layer(2);
  return (x: number, y: number) => wide(x, y) * 0.6 + middle(x, y) * 0.3 + small(x, y) * 0.1;
}

/** Makes ground uneven as real maps are, up to `amount` up or down, fading to nothing at the edge.
 *  Ramps and water stay: bumps there would break a way up or a ford's depth. The changed corners. */
export function roughenCorners(t: Terrain, area: Area, shape: Shape, amount: number, random: () => number) {
  const noise = bumps(random), changed: number[] = [];
  for (const { i, r } of cornersIn(t, area, shape)) {
    const c = t.corners[i];
    if (c.ramp || c.hasWater) continue;
    const before = c.rawHeight, fade = Math.min(1, (1 - r) / 0.25);
    setGroundHeight(c, groundHeight(c) + noise(i % t.width, Math.floor(i / t.width)) * amount * fade);
    if (c.rawHeight !== before) changed.push(i);
  }
  return changed;
}

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
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const i of corners) {
    const x = i % t.width, y = Math.floor(i / t.width);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  // Tiles next to a changed corner change too.
  const near = { left: t.offsetX + (x0 - 1) * TILE, right: t.offsetX + (x1 + 1) * TILE, bottom: t.offsetY + (y0 - 1) * TILE, top: t.offsetY + (y1 + 1) * TILE };
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

/** How many objects fall outside a map after adding (or cutting, negative) tiles per side:
 *  left, right, bottom, top. */
export function outsideAfterResize(list: readonly { position: readonly number[] }[], t: Terrain, change: readonly [number, number, number, number]) {
  const left = t.offsetX - change[0] * TILE, right = t.offsetX + (t.width - 1 + change[1]) * TILE;
  const bottom = t.offsetY - change[2] * TILE, top = t.offsetY + (t.height - 1 + change[3]) * TILE;
  return list.filter((p) => p.position[0] < left || p.position[0] > right || p.position[1] < bottom || p.position[1] > top).length;
}

/** The map's tile list after changing tileset, slot by slot: the old tileset's tiles become the new
 *  one's, and a tile from elsewhere, added on purpose, stays. No corner changes slot. */
export function swapTiles(current: readonly string[], oldOwn: readonly string[], newOwn: readonly string[]) {
  let next = 0;
  const kept = current.filter((tile) => !oldOwn.includes(tile));
  // A tile that stays takes its slot already: it mustn't get a second one.
  const free = newOwn.filter((tile) => !kept.includes(tile));
  const tiles = current.map((tile) => (oldOwn.includes(tile) ? free[Math.min(next++, free.length - 1)] ?? tile : tile));
  return { tiles, kept };
}

/** Swaps placed objects for other types, keeping where they stand. A variation the new type
 *  hasn't got becomes one it has. How many changed. */
export function replacePlaced(list: { id: string; position: readonly number[]; variation?: number; skinId?: string }[], swaps: Readonly<Record<string, string>>, area: Area | null, variations: (id: string) => number) {
  let changed = 0;
  for (const e of list) {
    const to = swaps[e.id];
    if (!to || (area && !inArea(e.position[0], e.position[1], area))) continue;
    e.id = to;
    if ("skinId" in e) e.skinId = to;
    if (e.variation !== undefined) e.variation = Math.min(e.variation, Math.max(0, variations(to) - 1));
    changed++;
  }
  return changed;
}

/** What a selection can become, its own kind first (the picker opens there): doodads and destructables share a
 *  file, units and items each stay what they are. */
export function replaceableKinds(kinds: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const k of kinds) for (const to of k === "w3d" ? ["w3d", "w3b"] : k === "w3b" ? ["w3b", "w3d"] : [k]) out.add(to);
  return [...out];
}

/** Whether something of kind `from` can become kind `to`. */
export const replaceableBy = (from: string, to: string) => replaceableKinds([from]).includes(to);

/** Pieces along a line, turned to run along it, each centred in its own stretch, so the row starts
 *  and ends at the line's ends and two lines meet in a corner. `facingOffset` is the facing (degrees) that makes a model follow the line. */
export function lineSpots(from: [number, number], to: [number, number], spacing: number, facingOffset: number) {
  const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
  // Rounded up: pieces overlapping a little look better than gaps.
  const count = Math.max(1, Math.ceil(length / spacing - 0.05));
  const facing = (((Math.atan2(dy, dx) * 180) / Math.PI + facingOffset) % 360 + 360) % 360;
  return Array.from({ length: count }, (_, i) => ({ x: from[0] + (dx * (i + 0.5)) / count, y: from[1] + (dy * (i + 0.5)) / count, facing }));
}

/** Rows across an area, for fields and orchards; `jitter` (units) keeps them from looking ruled. */
export function rowSpots(area: Area, spacingX: number, spacingY: number, jitter: number, random: () => number) {
  const out: { x: number; y: number }[] = [];
  for (let y = area.bottom + spacingY / 2; y < area.top; y += spacingY) {
    for (let x = area.left + spacingX / 2; x < area.right; x += spacingX) {
      out.push({ x: x + (random() - 0.5) * 2 * jitter, y: y + (random() - 0.5) * 2 * jitter });
    }
  }
  return out;
}

/** A colour for every pathing cell (rows from the south), for a picture of what stops a unit:
 *  red for cliffs and the like, orange for what stands there for good, purple for destructables,
 *  which can be destroyed, blue for water, clear for free. */
export function pathingColors(cells: Uint8Array, standing: Uint8Array, destructables: Uint8Array) {
  const rgba = new Uint8Array(cells.length * 4);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (destructables[i]) rgba.set([170, 70, 230, 170], i * 4);
    else if (standing[i]) rgba.set([255, 150, 0, 170], i * 4);
    else if (c & NO_WALK) rgba.set(c & NO_WATER ? [230, 30, 30, 170] : [30, 90, 240, 170], i * 4);
    else if (!(c & NO_WATER)) rgba.set([60, 150, 255, 90], i * 4);
  }
  return rgba;
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

const HIDEABLE = ["doodads", "units", "cliffs", "water"];

/** What a picture leaves out, as the renderer knows it. Throws for anything else. */
export function hiddenInPicture(hide: unknown) {
  const list = hide === undefined ? [] : hide;
  if (!Array.isArray(list) || !list.every((h) => HIDEABLE.includes(h))) throw new Error(`hide lists any of: ${HIDEABLE.join(", ")}.`);
  const water = list.includes("water");
  // Waves along the shore belong to the water.
  return { groups: [...list.filter((h) => h !== "water"), ...(water ? ["shoreline"] : [])] as string[], water };
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
