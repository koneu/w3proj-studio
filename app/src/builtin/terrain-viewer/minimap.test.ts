import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DecodedImage } from "../../lib/image/index.ts";
import type { Terrain } from "../../lib/terrain/w3e";
import { grainAt, groundColors, minimapFrame, renderMinimap, type MinimapInput, type Rgb } from "./minimap";
import { smallestMipColor } from "./minimapgen";
import { viewOutline } from "./minimappanel";

/** A made-up 33×25 corner map: two ground tiles in stripes, a lake in the middle, hills. */
function terrain(): Terrain {
  const width = 33, height = 25;
  const corners = Array.from({ length: width * height }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    const lake = Math.hypot(x - 16, y - 12) < 5;
    return { texture: (x >> 2) & 1, hasWater: lake, water: 0, height: lake ? -80 + Math.hypot(x - 16, y - 12) * 10 : (x * y) % 7, layer: 2, boundary: false };
  });
  return { width, height, offsetX: -2048, offsetY: -1536, corners, groundTiles: ["Ldrt", "Lgrs"], tileset: "L" } as unknown as Terrain;
}

const base = (): MinimapInput => ({
  terrain: terrain(), margins: [2, 3, 1, 2],
  tileColor: (id) => (id === "Ldrt" ? [120, 90, 60] : [40, 140, 50]),
  waterColor: [0, 0, 192],
  objects: [{ x: -1000, y: 0, rgb: [10, 200, 10] }, { x: 500, y: 300, rgb: [200, 10, 10] }],
});
const digest = (rgba: Uint8ClampedArray) => createHash("sha256").update(rgba).digest("hex").slice(0, 16);

test("minimapFrame: a unit drawn at a world point is at its pixel, and the pixel leads back to the point", () => {
  const input = base();
  for (const wholeMap of [false, true]) {
    const frame = minimapFrame(input.terrain, input.margins, 256, wholeMap);
    for (const [wx, wy] of [[-1000, 0], [500, 300], [-1700, -1200]]) {
      const rgba = renderMinimap({ ...input, objects: [], units: [{ x: wx, y: wy, rgb: [255, 0, 255] }], params: { blurPasses: 0 }, wholeMap });
      const [px, py] = frame.toPixel(wx, wy);
      const i = (Math.floor(py) * 256 + Math.floor(px)) * 4;
      assert.deepEqual([...rgba.slice(i, i + 3)], [255, 0, 255], `${wx}, ${wy} (whole map ${wholeMap}) at ${px}, ${py}`);
      const [bx, by] = frame.toWorld(px, py);
      assert.ok(Math.abs(bx - wx) < 1e-6 && Math.abs(by - wy) < 1e-6, `${bx}, ${by}`);
    }
  }
  // North is up: a point further north is higher in the picture.
  const f = minimapFrame(input.terrain, input.margins, 256);
  assert.ok(f.toPixel(0, 500)[1] < f.toPixel(0, -500)[1]);
});

test("war3mapMap.blp's picture: what the map's minimap was before the export options came", () => {
  // Taken from renderMinimap before Export Minimap had options; the saved minimap must not change with them. Taken
  // again when the ground got the World Editor's colours, cliffs and grain (2026-11-11).
  assert.equal(digest(renderMinimap(base())), "08855e9a893ec8e8");
});

test("groundColors: a tile point colours its tile, a point next to a cliff its cliff type, no cliff type its ground", () => {
  // 4 × 3 points: texture 1 in the east column, layer 3 at point (1, 1), cliff type 0 except at point (2, 0) (none)
  // and (0, 2) (type 1, whose colour isn't known).
  const width = 4, height = 3;
  const corners = Array.from({ length: width * height }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    return { texture: x === 3 ? 1 : 0, layer: x === 1 && y === 1 ? 3 : 2, cliffTexture: x === 2 && y === 0 ? 15 : x === 0 && y === 2 ? 1 : 0 };
  });
  const t = { width, height, corners, groundTiles: ["Ldrt", "Lgrs"], cliffTiles: ["CLdi", "CLgr"] } as unknown as Terrain;
  const tile = (id: string): Rgb => (id === "Ldrt" ? [1, 1, 1] : [2, 2, 2]);
  const colors = groundColors(t, tile, (id) => (id === "CLdi" ? [9, 9, 9] : null));
  const at = (x: number, y: number) => colors[(y * width + x) * 3];
  // Every point within one of (1, 1) is next to the cliff; (2, 0) and (0, 2) keep their ground.
  assert.deepEqual([0, 1, 2].map((y) => [0, 1, 2, 3].map((x) => at(x, y))), [[9, 9, 1, 2], [9, 9, 9, 2], [1, 9, 9, 2]]);
  // Without cliff colours (as before them) every point shows its ground.
  const plain = groundColors(t, tile);
  assert.deepEqual([...Array(width * height).keys()].map((i) => plain[i * 3]), corners.map((c) => (c.texture ? 2 : 1)));
});

test("the grain: even between 0 and 1, the same on every drawing, different from pixel to pixel", () => {
  const values = [...Array(256 * 64).keys()].map((i) => grainAt(i % 256, Math.floor(i / 256)));
  assert.ok(values.every((v) => v >= 0 && v < 1));
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.01, String(mean));
  const low = values.filter((v) => v < 0.1).length / values.length;
  assert.ok(Math.abs(low - 0.1) < 0.01, String(low));
  assert.equal(grainAt(17, 33), grainAt(17, 33));
  assert.ok(new Set(values.slice(0, 1000)).size > 990);
  // Two drawings of a map are the same picture (a saved minimap doesn't change without an edit).
  assert.equal(digest(renderMinimap(base())), digest(renderMinimap(base())));
});

test("smallestMipColor: the file's smallest mip level, averaged by alpha, not the full-size picture's average", () => {
  const level = (w: number, h: number, px: number[][]) => ({ width: w, height: h, rgba: Uint8ClampedArray.from(px.flat()) });
  const mips = [level(2, 1, [[0, 0, 0, 255], [100, 100, 100, 255]]), level(1, 1, [[40, 108, 27, 200]])];
  const image = { mipCount: 2, mip: (l: number) => mips[l] } as unknown as DecodedImage;
  assert.deepEqual(smallestMipColor(image), [40, 108, 27]);
  // A file whose smallest level isn't 1 × 1: averaged, transparent pixels left out; all transparent: none.
  const two = { mipCount: 1, mip: () => level(2, 1, [[10, 20, 30, 255], [250, 250, 250, 0]]) } as unknown as DecodedImage;
  assert.deepEqual(smallestMipColor(two), [10, 20, 30]);
  const clear = { mipCount: 1, mip: () => level(1, 1, [[10, 20, 30, 0]]) } as unknown as DecodedImage;
  assert.equal(smallestMipColor(clear), null);
});

test("viewOutline: the view's corners on the ground, and far along a ray over the horizon", () => {
  type V = [number, number, number];
  const norm = (v: V): V => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  // Straight down from 1000 over (100, 200), 90° across a 2:1 view: the ground 2000 × 1000 below.
  const down = (px: number, py: number) => ({ origin: [100, 200, 1000] as V, dir: norm([(px / 400 * 2 - 1) * 2, 1 - py / 200 * 2, -1]) });
  const pts = viewOutline(down, 400, 200, 0, 1e5);
  const want = [[-1900, 1200], [2100, 1200], [2100, -800], [-1900, -800]];
  pts.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 1e-6, `${i}: ${p}`));
  // Looking level: the top corners look over the horizon and go to the far distance; the bottom ones meet the ground.
  const level = (px: number, py: number) => ({ origin: [0, 0, 100] as V, dir: norm([px / 400 * 2 - 1, 1, (1 - py / 200 * 2) * 0.5]) });
  const far = viewOutline(level, 400, 200, 0, 5000);
  assert.ok(Math.abs(Math.hypot(far[0][0], far[0][1]) - 5000 * Math.hypot(1, 1) / Math.hypot(1, 1, 0.5)) < 1e-6);
  assert.ok(far[2][1] > 0 && far[2][1] < 5000, "a bottom corner meets the ground in front");
});
