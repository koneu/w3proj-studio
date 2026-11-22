// The Terrain Layout editor's background: one pixel per corner in its ground tile's colour, shaded by the slope and
// tinted where there is water, so the subterrains' rectangles lie over a picture of the map (north up).

import type { Terrain } from "./w3e";

export type Rgb = [number, number, number];

/** A colour for ground slot `i` when its texture's isn't known (no game files): far apart hues, the same every time. */
export function slotColor(i: number): Rgb {
  const hue = (i * 137.508) % 360, s = 0.45, l = 0.45;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

/** RGBA pixels, `width` × `height` (the terrain's corners), rows from the north: each corner its ground slot's colour
 *  (`tileColor`), lighter on slopes facing north-west and darker facing south-east, blended with `water` where the
 *  water lies above the ground; boundary corners darkened. */
export function layoutPicture(t: Pick<Terrain, "width" | "height" | "corners">, tileColor: (slot: number) => Rgb, water: Rgb = [40, 80, 170]): Uint8ClampedArray {
  const { width: W, height: H, corners } = t;
  const out = new Uint8ClampedArray(W * H * 4);
  const hAt = (x: number, y: number) => corners[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))].height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = corners[y * W + x];
      let rgb = tileColor(c.texture);
      // Light from the north-west: a slope rising to the south-east is darker (128 world units per corner).
      const slope = (hAt(x - 1, y + 1) - hAt(x + 1, y - 1)) / 256;
      const shade = Math.max(0.55, Math.min(1.35, 1 + slope * 0.6));
      rgb = rgb.map((v) => v * shade) as Rgb;
      if (c.hasWater && c.water > c.height) {
        const depth = Math.min(1, 0.45 + (c.water - c.height) / 256);
        rgb = rgb.map((v, k) => v * (1 - depth) + water[k] * depth) as Rgb;
      }
      if (c.boundary) rgb = rgb.map((v) => v * 0.45) as Rgb;
      const at = ((H - 1 - y) * W + x) * 4;
      out[at] = rgb[0];
      out[at + 1] = rgb[1];
      out[at + 2] = rgb[2];
      out[at + 3] = 255;
    }
  }
  return out;
}
