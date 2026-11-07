import assert from "node:assert/strict";
import { test } from "node:test";
import { boxOf, cameraColors, cameraEye, composeLayers, GRID_STEP, navalColors, toggleGrid, viewOfBox, type Angle, type Box } from "./viewcmds";

/** The oracle: a real perspective projection of a point, written out here from the camera's position. */
function project(p: number[], target: number[], distance: number, a: Angle, aspect: number): { x: number; y: number } | null {
  const eye = [target[0] + distance * Math.cos(a.pitch) * Math.cos(a.yaw), target[1] + distance * Math.cos(a.pitch) * Math.sin(a.yaw), target[2] + distance * Math.sin(a.pitch)];
  const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]], fl = Math.hypot(...f);
  const fw = f.map((v) => v / fl);
  // Right = forward x world up, up = right x forward.
  const r = [fw[1], -fw[0], 0], rl = Math.hypot(r[0], r[1]);
  const right = r.map((v) => v / rl);
  const up = [right[1] * fw[2] - right[2] * fw[1], right[2] * fw[0] - right[0] * fw[2], right[0] * fw[1] - right[1] * fw[0]];
  const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const depth = d[0] * fw[0] + d[1] * fw[1] + d[2] * fw[2];
  if (depth <= 0) return null;
  const t = Math.tan(a.fov / 2);
  return { x: (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / depth / (t * aspect), y: (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / depth / t };
}
const corners = (b: Box) => [b.minX, b.maxX].flatMap((x) => [b.minY, b.maxY].flatMap((y) => [b.minZ, b.maxZ].map((z) => [x, y, z])));
const extent = (b: Box, target: number[], distance: number, a: Angle, aspect: number) =>
  Math.max(...corners(b).map((c) => { const q = project(c, target, distance, a, aspect); return q ? Math.max(Math.abs(q.x), Math.abs(q.y)) : Infinity; }));

const angles: Angle[] = [
  { yaw: -Math.PI / 2, pitch: 0.95, fov: Math.PI / 4 },
  { yaw: 0.7, pitch: 0.3, fov: Math.PI / 4 },
  { yaw: 2.4, pitch: 1.5, fov: 1 },
];

test("viewOfBox: the box fills the picture exactly, from any angle", () => {
  const box: Box = { minX: -3000, maxX: 4000, minY: -500, maxY: 1500, minZ: 0, maxZ: 400 };
  for (const a of angles) for (const aspect of [0.7, 1.6, 2.4]) {
    const v = viewOfBox(box, a, aspect, { margin: 1 });
    const e = extent(box, v.target, v.distance, a, aspect);
    assert.ok(Math.abs(e - 1) < 1e-6, `touches the edge: ${e}`);
  }
});

test("viewOfBox: the margin leaves room, and the target is the box's middle", () => {
  const box: Box = { minX: 0, maxX: 1000, minY: 200, maxY: 800, minZ: 10, maxZ: 50 };
  const a = angles[0];
  const tight = viewOfBox(box, a, 1.5, { margin: 1 }), loose = viewOfBox(box, a, 1.5);
  assert.deepEqual(loose.target, [500, 500, 30]);
  assert.ok(Math.abs(loose.distance / tight.distance - 1.1) < 1e-9);
  assert.ok(extent(box, loose.target, loose.distance, a, 1.5) < 0.92);
});

test("viewOfBox: a wider window needs less distance for a wide box, and a point stays at the minimum", () => {
  const wide: Box = { minX: 0, maxX: 8000, minY: 0, maxY: 500, minZ: 0, maxZ: 0 };
  const a = angles[0];
  assert.ok(viewOfBox(wide, a, 2.5).distance < viewOfBox(wide, a, 1).distance);
  const point = boxOf([[100, 100, 5]])!;
  assert.equal(viewOfBox(point, a, 1.5, { minDistance: 600 }).distance, 600);
  assert.equal(viewOfBox(wide, a, 1, { maxDistance: 1000 }).distance, 1000);
});

test("boxOf: the points' extent plus the padding; nothing and non-numbers give null", () => {
  assert.deepEqual(boxOf([[0, 10, 1], [100, -20, 7]], 5), { minX: -5, maxX: 105, minY: -25, maxY: 15, minZ: 1, maxZ: 7 });
  assert.equal(boxOf([]), null);
  assert.equal(boxOf([[NaN, 1, 1]]), null);
  assert.deepEqual(boxOf([[NaN, 1, 1], [2, 3, 4]]), { minX: 2, maxX: 2, minY: 3, maxY: 3, minZ: 4, maxZ: 4 });
});

test("grids: the three sizes and what the toggles do", () => {
  assert.deepEqual([GRID_STEP.small, GRID_STEP.medium, GRID_STEP.large, GRID_STEP.none], [32, 128, 512, 0]);
  assert.equal(toggleGrid("none", "medium"), "medium");
  assert.equal(toggleGrid("medium", "medium"), "none");
  assert.equal(toggleGrid("small", "large"), "large");
});

test("navalColors: water shows, deep stronger than shallow, land and blocked cells don't", () => {
  const land = 0x40 | 0x08, shallow = 0, deep = 0x02, border = 0x80 | 0x40 | 0x02;
  const rgba = navalColors([land, shallow, deep, border]);
  const px = (i: number) => [...rgba.subarray(i * 4, i * 4 + 4)];
  assert.equal(px(0)[3], 0);
  assert.equal(px(3)[3], 0);
  assert.ok(px(1)[3] > 0 && px(2)[3] > px(1)[3]);
  assert.notDeepEqual(px(1).slice(0, 3), px(2).slice(0, 3));
});

test("cameraColors: the target and the eye are drawn where the camera is, nothing elsewhere", () => {
  const cam = { targetX: 640, targetY: 640, rotation: 0, distance: 640, angleOfAttack: 0, fieldOfView: 60 };
  assert.deepEqual(cameraEye(cam), [0, 640]);
  const W = 40, H = 40, rgba = cameraColors([cam], W, H, 0, 0);
  const at = (x: number, y: number) => rgba[((Math.floor(y / 32)) * W + Math.floor(x / 32)) * 4 + 3];
  assert.equal(at(640, 640), 255);
  assert.equal(at(16, 656), 255);
  assert.ok(at(320, 656) > 0, "the line between them");
  assert.equal(at(1200, 100), 0);
  assert.equal(cameraColors([{ ...cam, fieldOfView: NaN }], W, H, 0, 0).every((v) => v === 0), true, "a camera with a broken value is left out whole");
});

test("composeLayers: the later layer lies over the earlier; none gives null; one stays as it is", () => {
  const a = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]), b = new Uint8Array([0, 255, 0, 255, 0, 255, 0, 0]);
  assert.equal(composeLayers([null, null]), null);
  assert.equal(composeLayers([a, null]), a);
  assert.deepEqual([...composeLayers([a, b])!], [0, 255, 0, 255, 0, 0, 255, 128]);
  const half = new Uint8Array([0, 255, 0, 128, 0, 0, 0, 0]);
  const mix = composeLayers([a, half])!;
  assert.ok(mix[3] === 255 && mix[0] > 100 && mix[0] < 140 && mix[1] > 100 && mix[1] < 140);
});
