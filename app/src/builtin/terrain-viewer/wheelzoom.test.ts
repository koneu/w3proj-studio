import assert from "node:assert/strict";
import { test } from "node:test";
import type { Vec3 } from "../../lib/model/renderer";
import { TerrainRenderer } from "./renderer";
import { WHEEL_PIVOT_ROW, wheelPivot, wheelZoomDistance, wheelZoomTarget } from "./wheelzoom";

test("one wheel notch changes the distance by 1.1", () => {
  assert.ok(Math.abs(wheelZoomDistance(1000, true, 200, 1e6) - 1100) < 1e-9);
  assert.ok(Math.abs(wheelZoomDistance(1100, false, 200, 1e6) - 1000) < 1e-9);
});

test("a notch in and a notch out cancel", () => {
  const d = wheelZoomDistance(wheelZoomDistance(2345, false, 200, 1e6), true, 200, 1e6);
  assert.ok(Math.abs(d - 2345) < 1e-9);
});

test("the distance stays within its limits", () => {
  assert.equal(wheelZoomDistance(205, false, 200, 1000), 200);
  assert.equal(wheelZoomDistance(990, true, 200, 1000), 1000);
});

// The renderer's own camera (eye, ray, project) on a stand-in for its canvas: the World Editor's view size, and its
// opening camera in Studio's terms (TESTING.md "The default camera when a map opens": target y - 0.0993 d, distance
// 0.9127 d, pitch 57.2°, field of view 41.06°, for the editor's distance d = 3000 around the origin).
const W = 1184, H = 844;
const camera = (target: Vec3, distance: number) => {
  const cam = {
    canvas: { clientWidth: W, clientHeight: H }, target, distance, yaw: -Math.PI / 2, pitch: (57.2 * Math.PI) / 180,
    fov: (41.06 * Math.PI) / 180, eye: TerrainRenderer.prototype.eye,
  } as unknown as TerrainRenderer;
  return {
    ray: (x: number, y: number) => TerrainRenderer.prototype.ray.call(cam, x, y),
    project: (p: Vec3) => TerrainRenderer.prototype.project.call(cam, p)!,
  };
};
const WE_D = 3000;
const start: Vec3 = [0, -0.0993 * WE_D, 0];
const startD = 0.9127 * WE_D;
/** One wheel notch the way the view's wheel handler does it. */
const notch = (target: Vec3, distance: number, out: boolean) => {
  const next = wheelZoomDistance(distance, out, 200, 1e6);
  const pivot = wheelPivot(camera(target, distance).ray(W / 2, H * WHEEL_PIVOT_ROW), target, distance * 20);
  return { target: wheelZoomTarget(target, pivot, distance, next), distance: next, pivot };
};
const px = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test("the wheel zooms about the World Editor's camera target: the point at row 325.5 of 844 stays put", () => {
  const { target, distance, pivot } = notch(start, startD, false);
  const fixed: [number, number] = [W / 2, H * WHEEL_PIVOT_ROW];
  assert.ok(px(camera(start, startD).project(pivot), fixed) < 0.01);
  assert.ok(px(camera(target, distance).project(pivot), fixed) < 0.01, "the pivot moved on the view");
  // Control: the old zoom about the middle of the view (target kept) moves that point by pixels (it's 97 above it).
  const old = px(camera(start, distance).project(pivot), fixed);
  assert.ok(old > 5, `the zoom about the middle moved it ${old} px`);
  // Other ground moves away from the pivot (radially), as the editor's picture does.
  const other: Vec3 = [600, -600, 0];
  const before = camera(start, startD).project(other), after = camera(target, distance).project(other);
  const along = ((after[0] - fixed[0]) * (before[1] - fixed[1]) - (after[1] - fixed[1]) * (before[0] - fixed[0])) / px(before, fixed);
  assert.ok(Math.abs(along) < 0.01 && px(after, fixed) > px(before, fixed));
});

test("the editor's zoom (its target fixed, its distance times 1.1) in Studio's terms of its camera", () => {
  // Three notches in from the opening camera land where Studio's terms of the editor's camera at d / 1.1³ are.
  let cam = { target: start, distance: startD };
  for (let i = 0; i < 3; i++) cam = notch(cam.target, cam.distance, false);
  const d = WE_D / 1.1 ** 3;
  assert.ok(Math.abs(cam.distance - 0.9127 * d) < 1e-6);
  assert.ok(Math.abs(cam.target[0]) < 1e-6);
  assert.ok(Math.abs(cam.target[1] - -0.0993 * d) < 3, `target y ${cam.target[1]}, the editor's ${-0.0993 * d}`);
});

test("a notch in and a notch out bring back the same camera", () => {
  const t0: Vec3 = [1234, -567, 89];
  const a = notch(t0, 2000, false), b = notch(a.target, a.distance, true);
  assert.ok(Math.abs(b.distance - 2000) < 1e-9);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(b.target[i] - t0[i]) < 1e-6, `target ${b.target} vs ${t0}`);
});

test("a camera looking nearly level zooms about its target", () => {
  const t: Vec3 = [10, 20, 30];
  assert.deepEqual(wheelPivot({ origin: [0, 0, 100], dir: [0, 1, 0.1] }, t, 1e4), t, "the ray goes up");
  assert.deepEqual(wheelPivot({ origin: [0, 0, 100], dir: [0, 1, -1e-4] }, t, 1e4), t, "the ray meets the level too far away");
  assert.deepEqual(wheelZoomTarget(t, t, 1000, 1100), t);
});
