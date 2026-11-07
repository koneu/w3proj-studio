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
  /** Bytes after the tile points (normally none). */
  trailer: Uint8Array;
}

/** Water surfaces sit this far below their stored level. */
export const WATER_OFFSET = 89.6;
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

/** Ground variation for freshly painted (or new) corners: mostly the plain full tiles
 *  (16, 17+), sometimes one of the extended variations (0–15). Textures that
 *  have no extended part show plain tiles for all of these. */
export function randomVariation(random: () => number = Math.random): number {
  const r = random();
  if (r < 0.6) return 16;
  if (r < 0.85) return 17;
  return Math.floor(random() * 16);
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
export function waterLevelAt(z: number): number {
  return Math.max(WATER_LEVEL_MIN, Math.min(WATER_LEVEL_MAX, Math.round((z + WATER_OFFSET) * 4) + 0x2000));
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

export function setWaterLevel(c: Corner, level: number) {
  c.hasWater = true;
  c.rawWater = (c.rawWater & 0xc000) | (level & 0x3fff);
  c.water = (level - 0x2000) / 4 - WATER_OFFSET;
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
