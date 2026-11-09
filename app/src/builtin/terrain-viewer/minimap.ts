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
  // Export Minimap's options; left out, the picture is war3mapMap.blp's.
  /** Side of the square picture in pixels (MINIMAP_SIZE). */
  size?: number;
  /** The ground's colours and the water (both on by default); without the ground it is black. */
  show?: { terrain?: boolean; water?: boolean };
  /** The whole map, unplayable border included, instead of the playable area. */
  wholeMap?: boolean;
  /** Per pathing cell over the whole map (4 per tile, rows from the south), RGBA blended over the ground. */
  overlay?: { rgba: Uint8Array; width: number; height: number };
  /** Units and items, as squares in their owner's colour. */
  units?: { x: number; y: number; rgb: Rgb }[];
  /** Regions (world rectangles), filled see-through and outlined, over the smoothed picture. */
  regions?: { left: number; bottom: number; right: number; top: number; rgb: Rgb }[];
  /** Preview icons (gold mines, neutral buildings, start locations) at world points, `tint` multiplied in. */
  icons?: { x: number; y: number; image: { width: number; height: number; rgba: ArrayLike<number> }; tint?: Rgb }[];
}

/** How big a preview icon is on a 256 pixel minimap. */
export const ICON_SIZE = 16;

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

/** Where world points are on a minimap picture of `size` pixels, and back (the terrain view's minimap panel: a click
 *  moves the camera there, the view's outline is drawn on it). The same mapping renderMinimap draws with. */
export function minimapFrame(t: Pick<Terrain, "width" | "height" | "offsetX" | "offsetY">, margins: [number, number, number, number], size: number, wholeMap = false) {
  const [ml, mr, mb, mt] = wholeMap ? [0, 0, 0, 0] : margins;
  const N = Math.max(1, Math.round(size));
  const pw = t.width - 1 - ml - mr, ph = t.height - 1 - mb - mt;
  const scale = N / Math.max(1, pw, ph);
  const ox = (N - pw * scale) / 2, oy = (N - ph * scale) / 2;
  return {
    toPixel: (wx: number, wy: number): [number, number] => [((wx - t.offsetX) / 128 - ml) * scale + ox, N - (((wy - t.offsetY) / 128 - mb) * scale + oy)],
    toWorld: (px: number, py: number): [number, number] => [((px - ox) / scale + ml) * 128 + t.offsetX, ((N - py - oy) / scale + mb) * 128 + t.offsetY],
  };
}

/** RGBA pixels, rows top to bottom (north up). */
export function renderMinimap(input: MinimapInput): Uint8ClampedArray {
  const { terrain: t, tileColor, waterColor } = input;
  const [ml, mr, mb, mt] = input.wholeMap ? [0, 0, 0, 0] : input.margins;
  const P = { ...DEFAULT_MINIMAP, ...input.params };
  const N = Math.max(1, Math.round(input.size ?? MINIMAP_SIZE));
  const showGround = input.show?.terrain !== false, showWater = input.show?.water !== false;
  const overlay = input.overlay;
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
        if (showGround) {
          const tc = tileColor(t.groundTiles[c.texture]);
          for (let k = 0; k < 3; k++) col[k] += tc[k] * w[i] * P.groundBrightness;
        }
        depth += (c.hasWater ? c.water - c.height : -64) * w[i];
      });
      if (showWater && depth > 0) {
        const f = Math.min(1, depth / P.waterFullDepth);
        const a = P.waterOpacityShallow + (P.waterOpacityDeep - P.waterOpacityShallow) * f;
        for (let k = 0; k < 3; k++) {
          const wc = Math.min(255, (P.waterShallowColor[k] * (1 - f) + P.waterDeepColor[k] * f) * hue[k]);
          col[k] = col[k] * (1 - a) + wc * a;
        }
      }
      if (overlay) {
        const cx = Math.floor(gx * 4), cy = Math.floor(gy * 4);
        if (cx >= 0 && cy >= 0 && cx < overlay.width && cy < overlay.height) {
          const o = (cy * overlay.width + cx) * 4, a = overlay.rgba[o + 3] / 255;
          for (let k = 0; k < 3; k++) col[k] = col[k] * (1 - a) + overlay.rgba[o + k] * a;
        }
      }
      img.set(col, (py * N + px) * 3);
    }
  }

  /** Pixel of a world point. */
  const at = minimapFrame(t, input.margins, N, input.wholeMap).toPixel;
  const rad = P.objectRadius * scale;
  for (const o of input.objects) {
    const [cx, cy] = at(o.x, o.y);
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
        if (x < 0 || y < 0 || x >= N || y >= N || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > rad) continue;
        img.set(o.rgb, (y * N + x) * 3);
      }
    }
  }
  // Units: squares a little wider than the doodads' dots, at least a pixel.
  const half = Math.max(0.5, rad * 1.2);
  for (const u of input.units ?? []) {
    const [cx, cy] = at(u.x, u.y);
    for (let y = Math.floor(cy - half); y < Math.ceil(cy + half); y++) {
      for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) if (x >= 0 && y >= 0 && x < N && y < N) img.set(u.rgb, (y * N + x) * 3);
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

  // Regions and icons stay sharp: drawn over the smoothed picture.
  const blend = (x: number, y: number, rgb: ArrayLike<number>, a: number) => {
    if (x < 0 || y < 0 || x >= N || y >= N || a <= 0) return;
    const i = (y * N + x) * 3;
    for (let k = 0; k < 3; k++) img[i + k] = img[i + k] * (1 - a) + rgb[k] * a;
  };
  for (const r of input.regions ?? []) {
    const [x0f, y1f] = at(r.left, r.bottom), [x1f, y0f] = at(r.right, r.top);
    const x0 = Math.round(x0f), x1 = Math.max(x0 + 1, Math.round(x1f)), y0 = Math.round(y0f), y1 = Math.max(y0 + 1, Math.round(y1f));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) blend(x, y, r.rgb, x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1 ? 1 : 0.35);
    }
  }
  const iconSide = Math.max(4, Math.round((ICON_SIZE * N) / MINIMAP_SIZE));
  for (const icon of input.icons ?? []) {
    const [cx, cy] = at(icon.x, icon.y), { width: iw, height: ih, rgba } = icon.image;
    const left = Math.round(cx - iconSide / 2), top = Math.round(cy - iconSide / 2);
    for (let y = 0; y < iconSide; y++) {
      for (let x = 0; x < iconSide; x++) {
        // Nearest texel of the icon's picture.
        const s = (Math.min(ih - 1, Math.floor(((y + 0.5) * ih) / iconSide)) * iw + Math.min(iw - 1, Math.floor(((x + 0.5) * iw) / iconSide))) * 4;
        const tint = icon.tint ?? [255, 255, 255];
        blend(left + x, top + y, [rgba[s] * tint[0] / 255, rgba[s + 1] * tint[1] / 255, rgba[s + 2] * tint[2] / 255], rgba[s + 3] / 255);
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
