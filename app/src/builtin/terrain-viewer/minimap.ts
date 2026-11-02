// war3mapMap.blp: the 256×256 minimap picture. The World Editor renders the
// playable area (inside the camera margins) top-down, scaled to fit with its
// aspect ratio kept, centred on black. We approximate that render; the
// constants were fitted against 61 sample maps (mean colour error ≈ 15/255
// per channel, against the JPEG-compressed originals).

import type { Terrain } from "./w3e";

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
}

export const MINIMAP_SIZE = 256;
/** Ground colours come out slightly darker than the texture average. */
const GROUND_GAIN = 0.9;
/** Water over the ground: colour and opacity from shallow to 96+ deep
 *  (fitted for Lordaeron water, whose minimap colour is 0,0,192). */
const WATER_SHALLOW: Rgb = [57, 55, 115], WATER_DEEP: Rgb = [32, 38, 148], LORDAERON_WATER: Rgb = [0, 0, 192];
const WATER_ALPHA = [0.5, 0.62], WATER_FULL_DEPTH = 96, HUE_OFFSET = 64;
/** Object dots: radius in tiles. */
const OBJECT_RADIUS = 0.6;
const BLUR_PASSES = 2;

/** RGBA pixels, rows top to bottom (north up). */
export function renderMinimap(input: MinimapInput): Uint8ClampedArray {
  const { terrain: t, margins: [ml, mr, mb, mt], tileColor, waterColor } = input;
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
        for (let k = 0; k < 3; k++) col[k] += tc[k] * w[i] * GROUND_GAIN;
        depth += (c.hasWater ? c.water - c.height : -64) * w[i];
      });
      if (depth > 0) {
        const f = Math.min(1, depth / WATER_FULL_DEPTH);
        const a = WATER_ALPHA[0] + (WATER_ALPHA[1] - WATER_ALPHA[0]) * f;
        for (let k = 0; k < 3; k++) {
          const wc = Math.min(255, (WATER_SHALLOW[k] * (1 - f) + WATER_DEEP[k] * f) * hue[k]);
          col[k] = col[k] * (1 - a) + wc * a;
        }
      }
      img.set(col, (py * N + px) * 3);
    }
  }

  const rad = OBJECT_RADIUS * scale;
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
  for (let pass = 0; pass < BLUR_PASSES; pass++) {
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
