import assert from "node:assert/strict";
import { test } from "node:test";
import type { Vec3 } from "../../lib/model/renderer";
import { TerrainRenderer } from "./renderer";
import { heldPan, wheelPivot,wheelZoomDistance, wheelZoomTarget, zoomPivotRow, zoomStep } from "./wheelzoom";

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
/** One wheel notch (or zoom key) the way the view does it (zoomStep), and the point it kept in place. */
const notch = (target: Vec3, distance: number, out: boolean) => {
  const ray = camera(target, distance).ray;
  const pivot = wheelPivot(ray(W / 2, zoomPivotRow(H)), target, distance * 20);
  return { ...zoomStep({ width: W, height: H, target, distance, ray }, out, 200, 1e6), pivot };
};
const px = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test("the zoom's row is the World Editor's at every view height we-drive measured, not a share of the height", () => {
  // [height, row]: the focus of expansion of a notch or key press at views of 1184, 1184, 1036 and 784 wide.
  for (const [h, row] of [[844, 325.0], [592, 222.6], [585, 220.2], [565, 211.7]]) {
    assert.ok(Math.abs(zoomPivotRow(h) - row) < 0.5, `row ${zoomPivotRow(h)} of ${h}, the editor's ${row}`);
  }
  // Control: the share of the height measured at 844 alone misses the small view by 6 pixels.
  assert.ok(Math.abs((325.5 / 844) * 565 - 211.7) > 5);
  // Within the view, however small.
  assert.equal(zoomPivotRow(10), 0);
  assert.ok(zoomPivotRow(2000) < 2000);
});

test("the view's zoom step keeps the point at the middle column's zoom row in place, at another view size too", () => {
  for (const [w, h] of [[784, 565], [1600, 900]]) {
    const cam = (target: Vec3, distance: number) => {
      const c = { canvas: { clientWidth: w, clientHeight: h }, target, distance, yaw: -Math.PI / 2, pitch: (57.2 * Math.PI) / 180, fov: (41.06 * Math.PI) / 180, eye: TerrainRenderer.prototype.eye } as unknown as TerrainRenderer;
      return { ray: (x: number, y: number) => TerrainRenderer.prototype.ray.call(c, x, y), project: (p: Vec3) => TerrainRenderer.prototype.project.call(c, p)! };
    };
    const t0: Vec3 = [100, -300, 0];
    const fixed: [number, number] = [w / 2, zoomPivotRow(h)];
    const ground = wheelPivot(cam(t0, 2500).ray(...fixed), t0, 1e5);
    const next = zoomStep({ width: w, height: h, target: t0, distance: 2500, ray: cam(t0, 2500).ray }, false, 200, 1e6);
    assert.ok(Math.abs(next.distance - 2500 / 1.1) < 1e-9);
    assert.ok(px(cam(next.target, next.distance).project(ground), fixed) < 0.01, `${w}x${h}: the zoom's point moved on the view`);
  }
});

test("the wheel zooms about the World Editor's camera target: the point at its row of the 844 high view stays put", () => {
  const { target, distance, pivot } = notch(start, startD, false);
  const fixed: [number, number] = [W / 2, zoomPivotRow(H)];
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

test("a pan stops with the World Editor's camera target on the map's edge, past the camera bounds and the playable part", () => {
  // The empty 64x64 map of the measurement: its edge at 4096 (camera bounds 2816, playable part 3328).
  const map = { left: -4096, bottom: -4096, right: 4096, top: 4096 };
  const pivotOf = (target: Vec3) => wheelPivot(camera(target, startD).ray(W / 2, zoomPivotRow(H)), target, startD * 20);
  // The editor's camera at 3456, 0 (past the camera bounds and the playable part): nothing holds it.
  const inside: Vec3 = [3456, -0.0993 * WE_D, 0];
  assert.deepEqual(heldPan(inside, pivotOf(inside), map), inside);
  // Panned far right and up: the editor's target (the pivot) stands on 4096, 4096, as the editor's status bar read.
  const far: Vec3 = [9000, 7000, 0];
  const held = heldPan(far, pivotOf(far), map);
  const at = pivotOf(held);
  assert.ok(Math.abs(at[0] - 4096) < 1e-6 && Math.abs(at[1] - 4096) < 1e-6, `the editor's target at ${at}`);
  // Studio's own target is the middle of the view, south of the editor's by 0.0993 of its distance.
  assert.ok(Math.abs(held[0] - 4096) < 1e-6 && Math.abs(held[1] - (4096 - 0.0993 * WE_D)) < 3, `Studio's target at ${held}`);
  // The other two edges, and the height kept.
  const low: Vec3 = [-9000, -7000, 12];
  const heldLow = heldPan(low, pivotOf(low), map), atLow = pivotOf(heldLow);
  assert.ok(Math.abs(atLow[0] - -4096) < 1e-6 && Math.abs(atLow[1] - -4096) < 1e-6 && heldLow[2] === 12);
  // One axis past the edge leaves the other alone.
  const side: Vec3 = [5000, 100, 0];
  assert.equal(heldPan(side, pivotOf(side), map)[1], 100);
  // A pivot that is no number moves nothing.
  assert.deepEqual(heldPan(far, [NaN, 0, 0], map), far);
});
