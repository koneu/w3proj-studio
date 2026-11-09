import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Terrain } from "../../lib/terrain/w3e";
import { minimapFrame, renderMinimap, type MinimapInput } from "./minimap";
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
  // Taken from renderMinimap before Export Minimap had options; the saved minimap must not change with them.
  assert.equal(digest(renderMinimap(base())), "192897112b637406");
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
