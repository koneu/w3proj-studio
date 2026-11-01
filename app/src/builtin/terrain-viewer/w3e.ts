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
// Flags: 1 ramp, 2 blight, 4 water, 8 boundary (camera bounds edge).
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
}

export interface Terrain {
  version: number;
  tileset: string;
  customTilesets: boolean;
  groundTiles: string[];
  cliffTiles: string[];
  /** Number of corners per row / column (tiles + 1). */
  width: number;
  height: number;
  /** World position of corner (0, 0). */
  offsetX: number;
  offsetY: number;
  corners: Corner[];
}

/** Water surfaces sit this far below their stored level. */
export const WATER_OFFSET = 89.6;

export function parseW3e(buf: Uint8Array): Terrain {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const id = (p: number) => String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
  if (id(0) !== "W3E!") throw new Error("not a w3e file (missing W3E! header)");
  const version = dv.getUint32(4, true);
  if (version !== 11 && version !== 12) throw new Error(`unsupported w3e version ${version}`);
  const tileset = String.fromCharCode(buf[8]);
  const customTilesets = dv.getUint32(9, true) !== 0;
  let p = 13;
  const list = () => {
    const n = dv.getUint32(p, true);
    p += 4;
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
    const w = dv.getUint16(p + 2, true) & 0x3fff;
    let texture: number, flags: number;
    if (version === 12) {
      const t = dv.getUint16(p + 4, true);
      texture = t & 0x3f;
      flags = (t >> 6) & 0xf;
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
    };
  }
  return { version, tileset, customTilesets, groundTiles, cliffTiles, width, height, offsetX, offsetY, corners };
}
