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

/** Sets a corner's ground height (world units, without the cliff layer). */
export function setGroundHeight(c: Corner, ground: number) {
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
  return Math.max(WATER_LEVEL_MIN, Math.min(WATER_LEVEL_MAX, Math.round((z + offset) * 4) + 0x2000));
}

/** Marks a corner as water with a stored level (keeping the word's unknown high bits). */
/** Whether a point is on a tile painted as Boundary. Nothing walks there, though doodads can stand there:
 *  the game goes by the terrain, as the World Editor's pathing map leaves such tiles walkable. */
export function onBoundary(t: Terrain, x: number, y: number): boolean {
  const tx = Math.floor((x - t.offsetX) / 128), ty = Math.floor((y - t.offsetY) / 128);
  if (tx < 0 || ty < 0 || tx >= t.width - 1 || ty >= t.height - 1) return false;
  return [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]].some(([cx, cy]) => t.corners[cy * t.width + cx].boundary);
}

/** Bit of the water word: the tile whose lower left corner this is lies past the playable map. The game
 *  and the World Editor darken those tiles. Measured: 14 of 14 maps, saved by the World Editor among them. */
const MAP_EDGE = 0x4000;

/** Per tile (`width - 1` by `height - 1`, row 0 in the south), 1 where the tile lies past the playable map by the
 *  MAP_EDGE bit of its lower left corner, else 0: what the game and the World Editor darken (and the editor's naval
 *  view draws brown), whatever the w3i says. */
export function mapEdgeTiles(t: Pick<Terrain, "width" | "height" | "corners">): Uint8Array {
  const tilesX = Math.max(0, t.width - 1), tilesY = Math.max(0, t.height - 1);
  const out = new Uint8Array(tilesX * tilesY);
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) {
    if ((t.corners[y * t.width + x]?.rawWater ?? 0) & MAP_EDGE) out[y * tilesX + x] = 1;
  }
  return out;
}

/** Marks the tiles past the playable map; `complements` are the w3i's left, right, bottom, top. */
export function markMapEdge(t: Terrain, complements: readonly number[]) {
  const [left, right, bottom, top] = complements;
  const tilesX = t.width - 1, tilesY = t.height - 1;
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const c = t.corners[y * t.width + x];
    const past = x < tilesX && y < tilesY && (x < left || x >= tilesX - right || y < bottom || y >= tilesY - top);
    c.rawWater = past ? c.rawWater | MAP_EDGE : c.rawWater & ~MAP_EDGE;
  }
}

export function setWaterLevel(c: Corner, level: number, offset = WATER_OFFSET) {
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

/** Serializes a terrain; an unedited one comes out byte for byte as it was read. */
export function writeW3e(t: Terrain): Uint8Array {
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
