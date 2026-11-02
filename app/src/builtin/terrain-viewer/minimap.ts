// war3mapMap.blp: the 256×256 minimap picture. The World Editor renders the
// playable area (inside the camera margins) top-down, scaled to fit with its
// aspect ratio kept, centred on black. We approximate that render; the
// constants were fitted against 61 sample maps (mean colour error ≈ 15/255
// per channel, against the JPEG-compressed originals).

import type { Terrain } from "../../lib/terrain/w3e";

export type Rgb = [number, number, number];

export interface MinimapInput {
  terrain: Terrain;
  /** Unplayable border in tiles: left, right, bottom, top (w3i). */
  margins: [number, number, number, number];
  /** Average colour of a ground tile type's texture. */
  tileColor: (tileId: string) => Rgb;
  /** The tileset's minimap water colour (Water.slk mmRed/Green/Blue). */
  waterColor: Rgb;
  /** Doodads/destructables shown on the minimap, in their minimap colour. */
  objects: { x: number; y: number; rgb: Rgb }[];
  /** Look of the render (settings "terrain.minimap.*"). */
  params?: Partial<MinimapParams>;
}

export interface MinimapParams {
  /** Ground colours relative to the texture average. */
  groundBrightness: number;
  /** Water colour over the ground, shallow and at full depth (fitted for
   *  Lordaeron water; other tilesets shift the hue toward their minimap colour). */
  waterShallowColor: Rgb;
  waterDeepColor: Rgb;
  waterOpacityShallow: number;
  waterOpacityDeep: number;
  /** Depth (world units) at which water reaches the deep colour. */
  waterFullDepth: number;
  /** Radius of object dots in tiles. */
  objectRadius: number;
  blurPasses: number;
}

/** Fitted against 61 sample maps. */
export const DEFAULT_MINIMAP: MinimapParams = {
  groundBrightness: 0.9,
  waterShallowColor: [57, 55, 115],
  waterDeepColor: [32, 38, 148],
  waterOpacityShallow: 0.5,
  waterOpacityDeep: 0.62,
  waterFullDepth: 96,
  objectRadius: 0.6,
  blurPasses: 2,
};

export const MINIMAP_SIZE = 256;
/** Minimap colour of the water the fit was made for (Lordaeron). */
const LORDAERON_WATER: Rgb = [0, 0, 192];
const HUE_OFFSET = 64;

/** RGBA pixels, rows top to bottom (north up). */
export function renderMinimap(input: MinimapInput): Uint8ClampedArray {
  const { terrain: t, margins: [ml, mr, mb, mt], tileColor, waterColor } = input;
  const P = { ...DEFAULT_MINIMAP, ...input.params };
  const N = MINIMAP_SIZE;
  const pw = t.width - 1 - ml - mr, ph = t.height - 1 - mb - mt;
  const scale = N / Math.max(pw, ph); // pixels per tile
  const ox = (N - pw * scale) / 2, oy = (N - ph * scale) / 2;
  const C = (x: number, y: number) => t.corners[Math.min(t.height - 1, Math.max(0, y)) * t.width + Math.min(t.width - 1, Math.max(0, x))];
  const hue = [0, 1, 2].map((k) => (waterColor[k] + HUE_OFFSET) / (LORDAERON_WATER[k] + HUE_OFFSET));
  const img = new Float32Array(N * N * 3);

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      // Tiles from the playable area's bottom-left.
      const fx = (px + 0.5 - ox) / scale, fy = (N - (py + 0.5) - oy) / scale;
      if (fx < 0 || fy < 0 || fx >= pw || fy >= ph) continue;
      const gx = fx + ml, gy = fy + mb;
      const x0 = Math.floor(gx), y0 = Math.floor(gy), u = gx - x0, v = gy - y0;
      const q = [C(x0, y0), C(x0 + 1, y0), C(x0, y0 + 1), C(x0 + 1, y0 + 1)];
      const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
      const col = [0, 0, 0];
      let depth = 0;
      q.forEach((c, i) => {
        const tc = tileColor(t.groundTiles[c.texture]);
        for (let k = 0; k < 3; k++) col[k] += tc[k] * w[i] * P.groundBrightness;
        depth += (c.hasWater ? c.water - c.height : -64) * w[i];
      });
      if (depth > 0) {
        const f = Math.min(1, depth / P.waterFullDepth);
        const a = P.waterOpacityShallow + (P.waterOpacityDeep - P.waterOpacityShallow) * f;
        for (let k = 0; k < 3; k++) {
          const wc = Math.min(255, (P.waterShallowColor[k] * (1 - f) + P.waterDeepColor[k] * f) * hue[k]);
          col[k] = col[k] * (1 - a) + wc * a;
        }
      }
      img.set(col, (py * N + px) * 3);
    }
  }

  const rad = P.objectRadius * scale;
  for (const o of input.objects) {
    const cx = ((o.x - t.offsetX) / 128 - ml) * scale + ox, cy = N - (((o.y - t.offsetY) / 128 - mb) * scale + oy);
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
        if (x < 0 || y < 0 || x >= N || y >= N || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > rad) continue;
        img.set(o.rgb, (y * N + x) * 3);
      }
    }
  }

  // Soften like the World Editor's render (3×3 tent filter).
  for (let pass = 0; pass < P.blurPasses; pass++) {
    const src = img.slice();
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        for (let k = 0; k < 3; k++) {
          let sum = 0, weight = 0;
          for (let j = -1; j <= 1; j++) {
            for (let i = -1; i <= 1; i++) {
              const xx = x + i, yy = y + j;
              if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
              const wt = (i ? 1 : 2) * (j ? 1 : 2);
              sum += src[(yy * N + xx) * 3 + k] * wt;
              weight += wt;
            }
          }
          img[(y * N + x) * 3 + k] = sum / weight;
        }
      }
    }
  }

  const out = new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = img[i * 3];
    out[i * 4 + 1] = img[i * 3 + 1];
    out[i * 4 + 2] = img[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}
