// war3map.w3e: the terrain grid. A map of W×H tiles has (W+1)×(H+1) tile
// points ("corners"), stored row by row from the bottom-left (south-west).
//
// Version 11 (classic, 7 bytes per point) and 12 (Reforged 2.0+, 8 bytes):
//   i16  height        0x2000 = level 0; 4 units per world unit
//   u16  water         low 14 bits: water level (same scale as height); bit 14 unknown
//   v11: u8  texture (low nibble) | flags (high nibble)
//   v12: u16 texture (low 6 bits) | flags << 6
//   u8   variation     ground variation (low 5 bits) | cliff variation << 5
//   u8   cliff texture (high nibble) | layer (low nibble)
// Flags: 1 ramp, 2 blight, 4 water, 8 boundary (the World Editor's Boundary tile, painted anywhere; the
// map's outer border is a bit of the water word instead, see markMapEdge).
// The v12 bit layout was worked out from 38 maps saved by the 2.0 editor.

export interface Corner {
  /** World height of the ground (layer included). */
  height: number;
  /** World height of the water surface. */
  water: number;
  texture: number;
  /** Ground texture variation. */
  variation: number;
  cliffVariation: number;
  cliffTexture: number;
  layer: number;
  ramp: boolean;
  blight: boolean;
  hasWater: boolean;
  boundary: boolean;
  /** Stored values, written back as they are: ground height (without layer)
   *  and the whole water word (level + MAP_EDGE). `height` and
   *  `water` above are derived from them (see setGroundHeight). */
  rawHeight: number;
  rawWater: number;
  /** v12: bits 10–15 of the texture word, unused so far but kept. */
  texExtra: number;
}

export interface Terrain {
  version: number;
  tileset: string;
  customTilesets: boolean;
  /** The stored u32 behind customTilesets. */
  customTilesetsRaw: number;
  groundTiles: string[];
  cliffTiles: string[];
  /** Number of corners per row / column (tiles + 1). */
  width: number;
  height: number;
  /** World position of corner (0, 0). */
  offsetX: number;
  offsetY: number;
  corners: Corner[];
  /** How far below its stored level this tileset's water surface lies (default WATER_OFFSET): what each corner's
   *  `water` was read with. Set by setWaterOffset once the tileset's TerrainArt/Water.slk is known. */
  waterOffset?: number;
  /** Bytes after the tile points (normally none). */
  trailer: Uint8Array;
}

/** Water surfaces sit this far below their stored level. */
export const WATER_OFFSET = 89.6;

/** Every tileset's water offset from TerrainArt\Water.slk rows: the height of its "<letter>Sha" row is in tiles
 *  (128), negative below the stored level, so Ashenvale's -0.6 is 76.8. A row without a readable height has none. */
export function parseWaterOffsets(rows: Iterable<Record<string, string>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const height = Number(r.height);
    if (r.waterID?.length === 4 && r.waterID.endsWith("Sha") && r.height !== undefined && r.height !== "" && Number.isFinite(height)) out.set(r.waterID[0], -height * 128);
  }
  return out;
}

/** The offset a terrain's corner waters were read with. */
export const waterOffsetOf = (t: Pick<Terrain, "waterOffset">): number => t.waterOffset ?? WATER_OFFSET;

/** Reads every corner's water at another offset (the stored words stay as they are, so the file is unchanged). */
export function setWaterOffset(t: Terrain, offset: number | undefined) {
  const off = offset !== undefined && Number.isFinite(offset) ? offset : WATER_OFFSET;
  const was = waterOffsetOf(t);
  if (off === was) return;
  for (const c of t.corners) c.water += was - off;
  t.waterOffset = off;
}
/** The stored water level is 14 bits: these are its lowest and highest values, and no surface lies beyond. */
export const WATER_LEVEL_MIN = 0;
export const WATER_LEVEL_MAX = 0x3fff;

/** The ground tile each slot of the file's list is drawn with. With the "custom tilesets" flag 0 the World Editor
 *  ignores the file's list and takes the tileset's own one (`own`, Terrain.slk's order) by slot: a slot past its end is
 *  drawn with its first tile (we-drive 2026-11-16, Summer, lists in another order, of 3, 6 and 9 tiles). With the flag
 *  set, or the tileset's list unknown, it is the file's list. Drawing follows this (the terrain view and the minimap,
 *  the saved one too: we-compare custom-tilesets-0), painting a tile (drawnSlot) and the save (savedTerrain); cliff
 *  type numbers don't (the editor's follow the w3e's cliff list there, ct0-cliff-grass-rev6c-0). */
export function drawnGroundTiles(t: Pick<Terrain, "groundTiles" | "customTilesetsRaw">, own: readonly string[] | undefined): string[] {
  if (t.customTilesetsRaw !== 0 || !own?.length) return [...t.groundTiles];
  return t.groundTiles.map((_, i) => own[i] ?? own[0]);
}

/** The slot whose corners are drawn with `tile` (drawnGroundTiles: with the flag 0 by the tileset's own list, not the
 *  file's), -1 when no slot is. What painting a tile looks up, so the slot it paints is drawn as that tile. */
export function drawnSlot(t: Pick<Terrain, "groundTiles" | "customTilesetsRaw">, tile: string, own: readonly string[] | undefined): number {
  return drawnGroundTiles(t, own).indexOf(tile);
}

/** The slots whose corners a Replace of `tile` takes: with the flag 0 every slot drawn as it (a list of 9 draws slots 6
 *  to 8 as slot 0, and the World Editor's Replace Tiles takes them along: we-compare ct0-replace-more9-0); with the flag
 *  set, or the tileset's list unknown, the file's first slot with it, as before. Empty when none is. */
export function replaceSlots(t: Pick<Terrain, "groundTiles" | "customTilesetsRaw">, tile: string, own: readonly string[] | undefined): number[] {
  if (t.customTilesetsRaw !== 0 || !own?.length) {
    const at = t.groundTiles.indexOf(tile);
    return at < 0 ? [] : [at];
  }
  return drawnGroundTiles(t, own).flatMap((g, i) => (g === tile ? [i] : []));
}

/** The ground tiles a Replace Tiles names, each with its corner count: with the flag 0 the tiles drawn and the rest of
 *  the tileset's own list, once each in its order (the World Editor's Old Tile and New Tile boxes list the own list
 *  whole, whatever the file's: we-compare ct0-replace-*), the corners counted by the tile they are drawn with. With the
 *  flag set, or the tileset's list unknown, the file's list slot by slot. */
export function replaceTileNames(t: Pick<Terrain, "groundTiles" | "customTilesetsRaw" | "corners">, own: readonly string[] | undefined): { id: string; count: number }[] {
  const perSlot = t.groundTiles.map(() => 0);
  for (const c of t.corners) if (c.texture < perSlot.length) perSlot[c.texture]++;
  if (t.customTilesetsRaw !== 0 || !own?.length) return t.groundTiles.map((id, i) => ({ id, count: perSlot[i] }));
  const counts = new Map<string, number>();
  drawnGroundTiles(t, own).forEach((g, i) => counts.set(g, (counts.get(g) ?? 0) + perSlot[i]));
  for (const g of own) if (!counts.has(g)) counts.set(g, 0);
  return [...counts].map(([id, count]) => ({ id, count }));
}

/** Before a tile is added to the list with the flag 0: the file's list becomes the list drawn, so the flag going to 1
 *  (the list is no longer the tileset's own) leaves every slot drawn as it was. Nothing with the flag set or the
 *  tileset's list unknown. The same array is changed (callers hold it). */
/** The slot a tile is painted on with no slot drawn otherwise than before, -1 when the tile has to be added to the
 *  list. The slot drawn so (drawnSlot); with the flag 0, a tile of the tileset's own list past the end of the file's
 *  list grows the list with the own tiles up to it, the flag staying 0: the World Editor's palette has the whole own
 *  list there, and its save writes it whole (savedTerrain), so a few3 map painted with Lgrs gets slot 4. */
export function paintSlot(t: Pick<Terrain, "groundTiles" | "customTilesetsRaw">, tile: string, own: readonly string[] | undefined): number {
  const at = drawnSlot(t, tile, own);
  if (at >= 0 || t.customTilesetsRaw !== 0 || !own?.length) return at;
  // Not drawn: a tile of the own list is past the file's list's end (or not the tileset's at all: -1).
  const k = own.indexOf(tile);
  if (k < t.groundTiles.length || k >= MAX_GROUND_LIST) return -1;
  for (let i = t.groundTiles.length; i <= k; i++) t.groundTiles.push(own[i]);
  return k;
}
/** The most ground tiles a w3e's list has room for (the corner's 4 bits of a version 11 file). */
const MAX_GROUND_LIST = 16;

/** The terrain as a save writes it. With the flag 0 the World Editor's save writes the tileset's own list, whole, as
 *  the file's ground list, whatever the file's was (another order, 3 or 9 tiles), and a corner on a slot past its end
 *  gets slot 0, its first tile: what each slot was drawn with stays. The flag and the cliff list stay (we-compare
 *  custom-tilesets-0, ct0-save-*, 2026-11-16). `t` itself when nothing changes (the flag set, the tileset's list
 *  unknown, or already its list with no corner past it); `t` is never changed. */
export function savedTerrain(t: Terrain, own: readonly string[] | undefined): Terrain {
  if (t.customTilesetsRaw !== 0 || !own?.length) return t;
  const n = own.length;
  const sameList = t.groundTiles.length === n && t.groundTiles.every((g, i) => g === own[i]);
  const past = t.corners.some((c) => c.texture >= n);
  if (sameList && !past) return t;
  return { ...t, groundTiles: [...own], corners: past ? t.corners.map((c) => (c.texture >= n ? { ...c, texture: 0 } : c)) : t.corners };
}

export function settleDrawnList(t: Pick<Terrain, "groundTiles" | "customTilesetsRaw">, own: readonly string[] | undefined): void {
  if (t.customTilesetsRaw !== 0 || !own?.length) return;
  t.groundTiles.splice(0, t.groundTiles.length, ...drawnGroundTiles(t, own));
}

export function parseW3e(buf: Uint8Array): Terrain {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const id = (p: number) => String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
  if (id(0) !== "W3E!") throw new Error("not a w3e file (missing W3E! header)");
  const version = dv.getUint32(4, true);
  if (version !== 11 && version !== 12) throw new Error(`unsupported w3e version ${version}`);
  const tileset = String.fromCharCode(buf[8]);
  const customTilesetsRaw = dv.getUint32(9, true);
  const customTilesets = customTilesetsRaw !== 0;
  let p = 13;
  const list = () => {
    const n = dv.getUint32(p, true);
    p += 4;
    if (p + n * 4 > buf.length) throw new Error(`truncated: a list of ${n} tiles`);
    const out: string[] = [];
    for (let i = 0; i < n; i++, p += 4) out.push(id(p));
    return out;
  };
  const groundTiles = list();
  const cliffTiles = list();
  const width = dv.getUint32(p, true), height = dv.getUint32(p + 4, true);
  const offsetX = dv.getFloat32(p + 8, true), offsetY = dv.getFloat32(p + 12, true);
  p += 16;
  const per = version === 12 ? 8 : 7;
  if (buf.length < p + width * height * per) throw new Error(`truncated: ${width}×${height} points need ${width * height * per} bytes`);

  const corners: Corner[] = new Array(width * height);
  for (let i = 0; i < width * height; i++, p += per) {
    const h = dv.getInt16(p, true);
    const rawWater = dv.getUint16(p + 2, true), w = rawWater & 0x3fff;
    let texture: number, flags: number, texExtra = 0;
    if (version === 12) {
      const t = dv.getUint16(p + 4, true);
      texture = t & 0x3f;
      flags = (t >> 6) & 0xf;
      texExtra = t >> 10;
    } else {
      texture = buf[p + 4] & 0xf;
      flags = buf[p + 4] >> 4;
    }
    const cl = buf[p + per - 1];
    const layer = cl & 0xf;
    corners[i] = {
      height: (h - 0x2000) / 4 + (layer - 2) * 128,
      water: (w - 0x2000) / 4 - WATER_OFFSET,
      texture,
      variation: buf[p + per - 2] & 0x1f,
      cliffVariation: buf[p + per - 2] >> 5,
      cliffTexture: cl >> 4,
      layer,
      ramp: (flags & 1) !== 0,
      blight: (flags & 2) !== 0,
      hasWater: (flags & 4) !== 0,
      boundary: (flags & 8) !== 0,
      rawHeight: h,
      rawWater,
      texExtra,
    };
  }
  const trailer = buf.slice(p);
  return { version, tileset, customTilesets, customTilesetsRaw, groundTiles, cliffTiles, width, height, offsetX, offsetY, corners, trailer };
}

/** How often the World Editor gives each ground variation (0–17) to a corner it randomises, out of VARIATION_TOTAL:
 *  85 each for 0, 4, 8, 12, 16 and 17, and after each of 0, 4, 8 and 12 the next three at 10, 4 and 1. Fitted to what
 *  the World Editor wrote (we-drive, 2026-11-11): 9262 corners from Reset Texture Variations, Map Size growth and a
 *  map it made, e.g. 0 15.2 %, 1 1.8 %, 2 0.7 %, 3 0.2 %, 16 14.8 %, 17 14.2 % (these give 14.9, 1.75, 0.70, 0.18). */
export const VARIATION_WEIGHTS: readonly number[] = [85, 10, 4, 1, 85, 10, 4, 1, 85, 10, 4, 1, 85, 10, 4, 1, 85, 85];
const VARIATION_TOTAL = VARIATION_WEIGHTS.reduce((a, b) => a + b, 0);

/** Ground variation for freshly painted, new or reset corners, with the World Editor's spread (VARIATION_WEIGHTS). */
export function randomVariation(random: () => number = Math.random): number {
  let r = Math.floor(random() * VARIATION_TOTAL);
  for (let v = 0; v < VARIATION_WEIGHTS.length; v++) {
    r -= VARIATION_WEIGHTS[v];
    if (r < 0) return v;
  }
  return VARIATION_WEIGHTS.length - 1;
}

/** The stored ground word is a signed 16-bit number: the lowest and highest ground heights it holds (world units,
 *  without the cliff layer), -10240 and 6143.75. */
export const GROUND_HEIGHT_MIN = (-0x8000 - 0x2000) / 4;
export const GROUND_HEIGHT_MAX = (0x7fff - 0x2000) / 4;

/** Whether a ground height (without the cliff layer) fits the stored word as it is, with no cut-off. */
export const groundFits = (ground: number): boolean => {
  const raw = Math.round(ground * 4 + 0x2000);
  return Number.isFinite(raw) && raw >= -0x8000 && raw <= 0x7fff;
};

/** Sets a corner's ground height (world units, without the cliff layer). A height past the stored word stops at its
 *  end, as the World Editor's brushes do (Raise, Random heights: we-compare height-random-stops); the AI tools refuse such
 *  an edit first (groundFits). A height that isn't a number is refused: it would leave the corner without one. */
export function setGroundHeight(c: Corner, ground: number) {
  if (Number.isNaN(ground)) throw new Error("A ground height must be a number.");
  c.rawHeight = Math.max(-0x8000, Math.min(0x7fff, Math.round(ground * 4 + 0x2000)));
  c.height = (c.rawHeight - 0x2000) / 4 + (c.layer - 2) * 128;
}

/** Moves a corner to another cliff layer (0–15), keeping its ground height. */
export function setLayer(c: Corner, layer: number) {
  const ground = groundHeight(c);
  c.layer = Math.max(0, Math.min(15, layer));
  c.height = ground + (c.layer - 2) * 128;
}

/** The stored water level word that puts the surface at world height `z`. */
export function waterLevelAt(z: number, offset = WATER_OFFSET): number {
  return Math.max(WATER_LEVEL_MIN, Math.min(WATER_LEVEL_MAX, waterLevelWanted(z, offset)));
}

/** The level `waterLevelAt` would store without the cut-off at the 14 bits: below 0 or above 0x3fff is out of range. */
export function waterLevelWanted(z: number, offset = WATER_OFFSET): number {
  return Math.round((z + offset) * 4) + 0x2000;
}

/** Whether a point is on a tile painted as Boundary (any of its corners). Nothing walks there, though doodads can
 *  stand there. The World Editor's pathing map blocks only the tiles whose lower-left corner is painted
 *  (generatePathing). */
export function onBoundary(t: Terrain, x: number, y: number): boolean {
  const tx = Math.floor((x - t.offsetX) / 128), ty = Math.floor((y - t.offsetY) / 128);
  if (tx < 0 || ty < 0 || tx >= t.width - 1 || ty >= t.height - 1) return false;
  return [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]].some(([cx, cy]) => t.corners[cy * t.width + cx].boundary);
}

/** Bit of the water word: the tile whose lower left corner this is lies past the playable map. The World Editor
 *  writes it from the w3i's camera complements on save; it doesn't draw by it (playableEdgeTiles). Measured: 14 of
 *  14 maps carry it, saved by the World Editor among them. */
const MAP_EDGE = 0x4000;

/** Per tile (`width - 1` by `height - 1`, row 0 in the south), 1 where the tile lies past the playable map by the
 *  MAP_EDGE bit of its lower left corner, else 0. The border's shade goes by the w3i (playableEdgeTiles); these
 *  marks stand in only when the w3i can't say. */
export function mapEdgeTiles(t: Pick<Terrain, "width" | "height" | "corners">): Uint8Array {
  const tilesX = Math.max(0, t.width - 1), tilesY = Math.max(0, t.height - 1);
  const out = new Uint8Array(tilesX * tilesY);
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) {
    if ((t.corners[y * t.width + x]?.rawWater ?? 0) & MAP_EDGE) out[y * tilesX + x] = 1;
  }
  return out;
}

/** Per tile (as mapEdgeTiles), 1 where the tile lies past the playable map the w3i's camera complements leave
 *  (`complements`: left, right, bottom, top, in tiles). That is what the World Editor darkens: we-drive, 2026-11-13, on
 *  copies of AutumnLeaves_S2 (margins 15) with one thing changed each: the complements' left at 23 moved the dark edge
 *  8 tiles in; the MAP_EDGE marks' left at 23, the w3i's playable width or its camera bounds alone moved nothing. Its
 *  save writes the marks from the complements again. */
export function playableEdgeTiles(t: Pick<Terrain, "width" | "height">, complements: readonly number[]): Uint8Array {
  const [left, right, bottom, top] = complements;
  const tilesX = Math.max(0, t.width - 1), tilesY = Math.max(0, t.height - 1);
  const out = new Uint8Array(tilesX * tilesY);
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) {
    if (x < left || x >= tilesX - right || y < bottom || y >= tilesY - top) out[y * tilesX + x] = 1;
  }
  return out;
}

/** The w3i's camera complements (left, right, bottom, top) when they can stand for the playable map: four whole
 *  numbers from 0 up; else null. */
export function validComplements(c: unknown): number[] | null {
  return Array.isArray(c) && c.length === 4 && c.every((n) => Number.isInteger(n) && n >= 0) ? [...c] as number[] : null;
}

/** Marks the tiles past the playable map; `complements` are the w3i's left, right, bottom, top. `keepOuter`: the
 *  corners of the top row and right column, which no tile has as its lower left, keep their mark as they are, as the
 *  World Editor's Map Size leaves them (we-drive 2026-11-13: after a cut of the top they are marked, the old row's
 *  mark, after a growth and in a new map they aren't). */
export function markMapEdge(t: Terrain, complements: readonly number[], keepOuter = false) {
  const tilesX = t.width - 1, past = playableEdgeTiles(t, complements);
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const c = t.corners[y * t.width + x];
    if (keepOuter && (x >= tilesX || y >= t.height - 1)) continue;
    c.rawWater = x < tilesX && y < t.height - 1 && past[y * tilesX + x] ? c.rawWater | MAP_EDGE : c.rawWater & ~MAP_EDGE;
  }
}

/** Marks a corner as water with a stored level, 0 to 0x3fff (keeping the word's high bits). A level past the 14 bits is
 *  refused, not wrapped round to the other end (the World Editor wraps; a decision of 2026-11-15). */
export function setWaterLevel(c: Corner, level: number, offset = WATER_OFFSET) {
  if (!Number.isInteger(level) || level < WATER_LEVEL_MIN || level > WATER_LEVEL_MAX) throw new Error(`A water level is stored in 14 bits, ${WATER_LEVEL_MIN} to ${WATER_LEVEL_MAX}, and this would be ${level}.`);
  c.hasWater = true;
  c.rawWater = (c.rawWater & 0xc000) | (level & 0x3fff);
  c.water = (level - 0x2000) / 4 - offset;
}

/** Ground height of a corner without its cliff layer. */
export function groundHeight(c: Corner): number {
  return (c.rawHeight - 0x2000) / 4;
}

/** Extra height of a ramp's middle corner: a ramp climbs one layer over two
 *  tiles, so the ramp corner between its high and low end (on the lower
 *  layer) sits half a layer up. 0 for every other corner. */
export function rampLift(t: Terrain, x: number, y: number): number {
  const c = t.corners[y * t.width + x];
  if (!c.ramp) return 0;
  const at = (cx: number, cy: number) => (cx >= 0 && cy >= 0 && cx < t.width && cy < t.height ? t.corners[cy * t.width + cx] : null);
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    for (const s of [1, -1]) {
      const up = at(x + dx * s, y + dy * s), down = at(x - dx * s, y - dy * s);
      if (up?.ramp && down?.ramp && up.layer === c.layer + 1 && down.layer === c.layer) return 64;
    }
  }
  return 0;
}

/** Unit normal of the ground at a corner, from central differences of its neighbours.
 *  A cliff's layers (128 per step) are left out of a difference, since the ground beside a cliff is flat. A ramp
 *  really climbs from one layer to the next, so the full height (ramp lift included) is used when a ramp corner is
 *  involved, its layer is at most one off the other corner's, and the ramp runs along that axis (a ramp corner
 *  with a ramp neighbour in that direction); that leaves a ramp's sides and a cliff beside it flat. */
export function cornerNormal(t: Terrain, x: number, y: number): [number, number, number] {
  const corner = (cx: number, cy: number): Corner | undefined =>
    cx >= 0 && cy >= 0 && cx < t.width && cy < t.height ? t.corners[cy * t.width + cx] : undefined;
  const rampAlong = (cx: number, cy: number, ax: number, ay: number) =>
    [1, -1].some((s) => corner(cx + ax * s, cy + ay * s)?.ramp);
  const slope = (ax: number, ay: number) => {
    const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
    const [px, py] = [clamp(x + ax, t.width - 1), clamp(y + ay, t.height - 1)];
    const [mx, my] = [clamp(x - ax, t.width - 1), clamp(y - ay, t.height - 1)];
    const steps = Math.abs(px - mx) + Math.abs(py - my);
    if (steps === 0) return 0;
    const a = corner(px, py)!, b = corner(mx, my)!;
    const along = (c: Corner, cx: number, cy: number) => !c.ramp || rampAlong(cx, cy, ax, ay);
    const ramp = (a.ramp || b.ramp) && Math.abs(a.layer - b.layer) <= 1 && along(a, px, py) && along(b, mx, my);
    const lift = (c: Corner, cx: number, cy: number) => {
      if (!c.ramp) return 0;
      for (const s of [1, -1]) {
        const up = corner(cx + ax * s, cy + ay * s), down = corner(cx - ax * s, cy - ay * s);
        if (up && down && up.ramp && down.ramp && up.layer === c.layer + 1 && down.layer === c.layer) return 64;
      }
      return 0;
    };
    const dh = ramp
      ? a.height + lift(a, px, py) - (b.height + lift(b, mx, my))
      : groundHeight(a) - groundHeight(b);
    return dh / (128 * steps);
  };
  const sx = slope(1, 0), sy = slope(0, 1);
  const l = Math.hypot(sx, sy, 1);
  return [-sx / l, -sy / l, 1 / l];
}

/** Height of the ground at a world position: bilinear over the tile's
 *  corners (layers and ramps included). Doodads without a fixed height sit
 *  exactly there in World Editor maps (97% within half a unit). */
export function heightAt(t: Terrain, wx: number, wy: number): number {
  const fx = Math.min(Math.max((wx - t.offsetX) / 128, 0), t.width - 1.000001);
  const fy = Math.min(Math.max((wy - t.offsetY) / 128, 0), t.height - 1.000001);
  const x = Math.floor(fx), y = Math.floor(fy), u = fx - x, v = fy - y;
  const c = (i: number, j: number) => t.corners[(y + j) * t.width + x + i].height + rampLift(t, x + i, y + j);
  return (c(0, 0) * (1 - u) + c(1, 0) * u) * (1 - v) + (c(0, 1) * (1 - u) + c(1, 1) * u) * v;
}

/** The water level a floating doodad (Doodads.slk `floats` 1: lily pads, seaweed, bubbles) stands on at a world position,
 *  or null where it stands on the ground (heightAt). The World Editor looks at the one corner nearest to it (halves
 *  round up, on both axes): when that corner has water and its level is above that corner's ground (the cliff level
 *  counted), the doodad is at that corner's level, wherever the ground between the corners is. we-compare
 *  doodad-water-z (2026-11-16, SD, make-doodad-water-z.mjs; open and Select All + Numpad 6 alike): a corner without
 *  the water flag doesn't count, a level-3 corner at ground 0 under water at -49.6 doesn't, a doodad halfway between a
 *  wet and a dry corner takes the east (north) one, levels -59.6, -29.6, 0.4, 30.4 by column go by the nearest
 *  column; the 3522 doodads of (2)EchoIsles fit it, as the original and as the editor saved them. */
export function floatingLevelAt(t: Terrain, wx: number, wy: number): number | null {
  const fx = (wx - t.offsetX) / 128, fy = (wy - t.offsetY) / 128;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  const x = Math.min(Math.max(Math.round(fx), 0), t.width - 1), y = Math.min(Math.max(Math.round(fy), 0), t.height - 1);
  const c = t.corners[y * t.width + x];
  return c && c.hasWater && c.water > c.height ? c.water : null;
}

/** How far up the slope the pick looks (world units): 0.125 of a tile. */
const PICK_REACH = 16;

/** Ground height for picking with the pointer (`pickGround`): the height a little way up the slope, `reach` world
 *  units along its steepest rise. The World Editor's cliff faces stand about that far ahead of the bilinear slope
 *  between a cliff's corners, so its pick over a cliff lands nearer than the slope's; flat ground (and the foot of
 *  a hill) is left as it is. */
export function pickHeightAt(t: Terrain, wx: number, wy: number): number {
  const e = 16, reach = PICK_REACH;
  const gx = heightAt(t, wx + e, wy) - heightAt(t, wx - e, wy), gy = heightAt(t, wx, wy + e) - heightAt(t, wx, wy - e);
  const len = Math.hypot(gx, gy);
  if (len < 1e-6) return heightAt(t, wx, wy);
  return heightAt(t, wx + (gx / len) * reach, wy + (gy / len) * reach);
}

/** Where a ray meets the ground as the pointer sees it (`pickHeightAt`), or null if it misses the map: marched in
 *  steps of 32 units up to `far` along the ray, the last step halved 12 times. */
export function pickGroundOn(t: Terrain, ray: { origin: readonly number[]; dir: readonly number[] }, far: number): [number, number, number] | null {
  const { origin: o, dir: d } = ray;
  const at = (s: number): [number, number, number] => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];
  const above = (s: number) => { const p = at(s); return p[2] > pickHeightAt(t, p[0], p[1]); };
  const step = 32;
  let lo = 0;
  for (let s = step; s < far; s += step) {
    if (above(s)) { lo = s; continue; }
    let hi = s;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (above(mid)) lo = mid; else hi = mid; }
    const p = at(hi);
    const inside = p[0] >= t.offsetX && p[1] >= t.offsetY && p[0] <= t.offsetX + (t.width - 1) * 128 && p[1] <= t.offsetY + (t.height - 1) * 128;
    return inside ? p : null;
  }
  return null;
}

/** Height of the water surface at a world position, as the terrain viewer draws it: a tile with water at a
 *  corner and above the ground at one, its dry corners at the wet ones' level, bilinear between. Null where
 *  no water is drawn, or where the ground there rises through the surface. Past the edge the nearest tile counts. */
export function waterSurfaceAt(t: Terrain, wx: number, wy: number): number | null {
  const fx = Math.min(Math.max((wx - t.offsetX) / 128, 0), t.width - 1.000001);
  const fy = Math.min(Math.max((wy - t.offsetY) / 128, 0), t.height - 1.000001);
  const x = Math.floor(fx), y = Math.floor(fy), u = fx - x, v = fy - y;
  const cs = [t.corners[y * t.width + x], t.corners[y * t.width + x + 1], t.corners[(y + 1) * t.width + x], t.corners[(y + 1) * t.width + x + 1]];
  const wet = cs.filter((c) => c.hasWater);
  if (!wet.length || cs.every((c) => c.water <= c.height)) return null;
  const level = Math.max(...wet.map((c) => c.water));
  const [a, b, c, d] = cs.map((k) => (k.hasWater ? k.water : level));
  const surface = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  return surface > heightAt(t, wx, wy) ? surface : null;
}

/** Why a terrain can't be written as it is, or null: a corner field past the bits the file gives it, or not a whole
 *  number, would be cut to those bits by the writer and come back as another value. */
export function w3eWriteProblem(t: Terrain): string | null {
  if (t.width * t.height !== t.corners.length) return `${t.width} × ${t.height} corners, but ${t.corners.length} are there`;
  for (const [what, list] of [["ground tile", t.groundTiles], ["cliff tile", t.cliffTiles]] as const) {
    const bad = list.find((s) => s.length !== 4);
    if (bad !== undefined) return `the ${what} "${bad}" isn't four characters`;
  }
  const fields: [keyof Corner, number, number][] = [
    ["rawHeight", -0x8000, 0x7fff], ["rawWater", 0, 0xffff], ["texture", 0, t.version === 12 ? 0x3f : 0xf],
    ["variation", 0, 0x1f], ["cliffVariation", 0, 7], ["cliffTexture", 0, 15], ["layer", 0, 15], ["texExtra", 0, t.version === 12 ? 0x3f : 0],
  ];
  for (let i = 0; i < t.corners.length; i++) {
    const c = t.corners[i];
    for (const [k, lo, hi] of fields) {
      const v = c[k] as number;
      if (!Number.isInteger(v) || v < lo || v > hi) return `corner ${i % t.width}, ${Math.floor(i / t.width)} has ${k} ${v} (${lo} to ${hi})`;
    }
  }
  return null;
}

/** Serializes a terrain; an unedited one comes out byte for byte as it was read. A terrain with a field past its bits is
 *  refused (w3eWriteProblem), not cut to them. */
export function writeW3e(t: Terrain): Uint8Array {
  const problem = w3eWriteProblem(t);
  if (problem) throw new Error(`war3map.w3e can't be written: ${problem}.`);
  const per = t.version === 12 ? 8 : 7;
  const head = 13 + 4 + t.groundTiles.length * 4 + 4 + t.cliffTiles.length * 4 + 16;
  const out = new Uint8Array(head + t.corners.length * per + t.trailer.length);
  const dv = new DataView(out.buffer);
  const id = (p: number, s: string) => { for (let i = 0; i < 4; i++) out[p + i] = s.charCodeAt(i); };
  id(0, "W3E!");
  dv.setUint32(4, t.version, true);
  out[8] = t.tileset.charCodeAt(0);
  dv.setUint32(9, t.customTilesetsRaw, true);
  let p = 13;
  for (const list of [t.groundTiles, t.cliffTiles]) {
    dv.setUint32(p, list.length, true);
    p += 4;
    for (const s of list) { id(p, s); p += 4; }
  }
  dv.setUint32(p, t.width, true);
  dv.setUint32(p + 4, t.height, true);
  dv.setFloat32(p + 8, t.offsetX, true);
  dv.setFloat32(p + 12, t.offsetY, true);
  p += 16;
  for (const c of t.corners) {
    const flags = (c.ramp ? 1 : 0) | (c.blight ? 2 : 0) | (c.hasWater ? 4 : 0) | (c.boundary ? 8 : 0);
    dv.setInt16(p, c.rawHeight, true);
    dv.setUint16(p + 2, c.rawWater, true);
    if (t.version === 12) dv.setUint16(p + 4, (c.texture & 0x3f) | (flags << 6) | (c.texExtra << 10), true);
    else out[p + 4] = (c.texture & 0xf) | (flags << 4);
    out[p + per - 2] = (c.variation & 0x1f) | (c.cliffVariation << 5);
    out[p + per - 1] = (c.cliffTexture << 4) | (c.layer & 0xf);
    p += per;
  }
  out.set(t.trailer, p);
  return out;
}
