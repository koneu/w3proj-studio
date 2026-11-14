import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraMarkers, DEPTH_OF_FIELD, MARKER_RGB, MARKER_STRIDE, markerHandles, nameDepthOfField, segmentDistance, targetInCameraBounds, VIEW_OUTSIDE_BOUNDS, viewInCameraBounds } from "./cameras";

/** The corners of cameraMarkers' triangles as [x, y, z], their normals and their colours. */
const part = (data: number[], from: number, to: number) => Array.from({ length: data.length / MARKER_STRIDE }, (_, i) => data.slice(i * MARKER_STRIDE + from, i * MARKER_STRIDE + to));
const corners = (data: number[]) => part(data, 0, 3);
const normals = (data: number[]) => part(data, 3, 6);
const colours = (data: number[]) => part(data, 6, 10);

test("cameraMarkers: the World Editor's marker, an arrow from a small camera to the target, scaled by the distance", () => {
  // Looking west along the ground (as we-drive's flat cameras of distance 500, 1000 and 2000): the arrow's tip on the
  // target, the camera's back 0.365 of the distance east of it, nothing beyond (no footprint, no eye-to-target wedge).
  for (const distance of [500, 1000, 2000]) {
    const c = { targetX: -1200, targetY: 600, zOffset: 0, rotation: 180, angleOfAttack: 0, distance, fieldOfView: 70 };
    const data = cameraMarkers([c], () => 50);
    assert.equal(data.length % (3 * MARKER_STRIDE), 0, "whole triangles of 10 floats a corner");
    const p = corners(data);
    const xs = p.map((v) => v[0]), ys = p.map((v) => v[1]), zs = p.map((v) => v[2]);
    assert.ok(Math.abs(Math.min(...xs) + 1200) < 1e-6, `the tip is the target (${Math.min(...xs)})`);
    assert.ok(Math.abs(Math.max(...xs) - (-1200 + 0.365 * distance)) < 1e-6, `the back at 0.365 of ${distance} (${Math.max(...xs)})`);
    // Narrow: the camera is about a fortieth of the distance across, standing on the target's height (the ground's 50).
    assert.ok(Math.max(...ys.map((y) => Math.abs(y - 600))) <= 0.013 * distance + 1e-9);
    assert.ok(Math.min(...zs) > 50 - 0.012 * distance && Math.max(...zs) < 50 + 0.03 * distance);
  }
  // The same marker twice as far is the same shape twice as big: world-sized, not a fixed size on screen.
  const one = corners(cameraMarkers([{ targetX: 0, targetY: 0, rotation: 30, angleOfAttack: 304, distance: 800, fieldOfView: 70 }], () => 0));
  const two = corners(cameraMarkers([{ targetX: 0, targetY: 0, rotation: 30, angleOfAttack: 304, distance: 1600, fieldOfView: 70 }], () => 0));
  assert.equal(one.length, two.length);
  one.forEach((v, i) => v.forEach((x, k) => assert.ok(Math.abs(x * 2 - two[i][k]) < 1e-6)));
});

test("cameraMarkers: the camera leans back up toward its eye, the target stands its height offset over the ground", () => {
  // Rotation 90 and angle of attack 304 (the game camera, looking north and 56 degrees down): the camera lies south of
  // the target and above it, as the eye.
  const c = { targetX: 100, targetY: 200, zOffset: 30, rotation: 90, angleOfAttack: 304, distance: 1000, fieldOfView: 70 };
  const p = corners(cameraMarkers([c], (x, y) => (x === 100 && y === 200 ? 64 : NaN)));
  const top = p.reduce((a, b) => (b[2] > a[2] ? b : a)), tip = p.reduce((a, b) => (b[2] < a[2] ? b : a));
  assert.ok(Math.hypot(tip[0] - 100, tip[1] - 200, tip[2] - 94) < 0.01 * 1000, `the lowest point is at the target, 64 + 30 high: ${tip}`);
  assert.ok(top[1] < 200 - 150 && top[2] > 94 + 250, `the camera is south of the target and over it: ${top}`);
  assert.ok(p.every((v) => Math.abs(v[0] - 100) < 15), "it stays in the camera's vertical plane, give or take its width");
});

test("cameraMarkers: one colour before light, unit normals pointing out of each part; a broken camera is left out", () => {
  const c = { targetX: 0, targetY: 0, rotation: 0, angleOfAttack: 0, distance: 1000, fieldOfView: 70 };
  const data = cameraMarkers([c], () => 0);
  for (const col of colours(data)) assert.deepEqual(col, [...MARKER_RGB.map((v) => v / 255), 1], "the light is the renderer's, not baked in");
  for (const n of normals(data)) assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-9, `a unit normal: ${n}`);
  // Looking east along the ground: the arrowhead's base faces back (west of it is the tip, east the camera), the box's
  // top faces up and its bottom down.
  const ns = normals(data);
  assert.ok(ns.some((n) => n[2] > 0.99) && ns.some((n) => n[2] < -0.99), "faces up and faces down");
  assert.ok(ns.some((n) => n[1] > 0.99) && ns.some((n) => n[1] < -0.99), "faces to both sides");
  // Every face points away from the inside of its part: the box's top corners (highest) have normals facing up.
  const p = corners(data), top = Math.max(...p.map((v) => v[2]));
  assert.ok(p.every((v, i) => v[2] < top - 1e-6 || ns[i][2] >= -1e-9), "no face at the very top points down");
  assert.deepEqual(cameraMarkers([{ ...c, distance: NaN }, { ...c, distance: 0 }, { ...c, rotation: Infinity }, { ...c, zOffset: NaN }], () => 0), []);
  assert.deepEqual(cameraMarkers([c], () => NaN), [], "a target off the ground's numbers");
  assert.equal(cameraMarkers([c, { ...c, targetX: 500 }], () => 0).length, 2 * cameraMarkers([c], () => 0).length, "one marker per camera");
});

test("markerHandles: the arrow's tip on the target, the camera's box from its lens to its back, as drawn", () => {
  const c = { targetX: -1200, targetY: 600, zOffset: 20, rotation: 180, angleOfAttack: 0, distance: 1000, fieldOfView: 70 };
  const m = markerHandles(c, () => 50)!;
  assert.deepEqual(m.target.map((v) => Math.round(v * 1e6) / 1e6), [-1200, 600, 70]);
  // Looking west: the box lies east of the target, its back where the marker ends.
  const xs = corners(cameraMarkers([c], () => 50)).map((v) => v[0]);
  assert.ok(Math.abs(m.back[0] - Math.max(...xs)) < 1e-6, `${m.back[0]} against ${Math.max(...xs)}`);
  assert.ok(m.front[0] > -1200 + 200 && m.front[0] < m.back[0], `the lens between: ${m.front[0]}`);
  assert.ok(m.width > 10 && m.width < 40, `about a fortieth of the distance across: ${m.width}`);
  assert.equal(markerHandles({ ...c, distance: 0 }, () => 0), null);
  assert.equal(markerHandles(c, () => NaN), null);
});

test("segmentDistance: to the nearest point of the segment, its ends included", () => {
  assert.equal(segmentDistance(5, 3, [0, 0], [10, 0]), 3);
  assert.equal(segmentDistance(-4, 3, [0, 0], [10, 0]), 5);
  assert.equal(segmentDistance(13, 4, [0, 0], [10, 0]), 5);
  assert.equal(segmentDistance(3, 4, [0, 0], [0, 0]), 5, "a segment of no length is its point");
});

test("nameDepthOfField: older JSON's unknown becomes DoF Distance, DoF Scale and Pos Absolute Z", () => {
  // The World Editor's camera dialog: 0, 123 and 2.5 typed there are the three floats in this order (2026-11-12).
  const old: Record<string, unknown> = { name: "look", unknown: [0, 123, 2.5] };
  nameDepthOfField(old);
  assert.deepEqual(old, { name: "look", dofDistance: 0, dofScale: 123, posAbsoluteZ: 2.5 });
  // A named value wins, as the codec reads it.
  const both: Record<string, unknown> = { dofScale: 7, unknown: [1, 2, 3] };
  nameDepthOfField(both);
  assert.deepEqual(both, { dofScale: 7, dofDistance: 1, posAbsoluteZ: 3 });
  // A classic camera stays without them, unless a version 3 save fills them.
  const classic: Record<string, unknown> = { name: "c" };
  nameDepthOfField(classic);
  assert.deepEqual(classic, { name: "c" });
  nameDepthOfField(classic as Record<string, unknown>, true); // (deepEqual narrowed its type)
  assert.deepEqual(classic, { name: "c", dofDistance: 0, dofScale: 0, posAbsoluteZ: 0 });
  assert.deepEqual(DEPTH_OF_FIELD, ["dofDistance", "dofScale", "posAbsoluteZ"]);
});

test("viewInCameraBounds: Enforce Camera Bounds refuses a view whose target is outside the camera bounds, as the World Editor", () => {
  // The empty 64x64 map's w3i: left, bottom; right, top; left, top; right, bottom.
  const bounds = [-2816, -3328, 2816, 2816, -2816, 2816, 2816, -3328];
  // The World Editor made these cameras (we-drive 2026-11-14)...
  for (const [x, y] of [[2816, 0], [2700, 0], [0, 0], [0, -3000], [2700, 300]]) assert.ok(viewInCameraBounds(bounds, x, y), `${x}, ${y} is inside`);
  // ...and refused these: inside the playable part (3328) and the map (4096), but past the camera bounds.
  for (const [x, y] of [[3000, 0], [2820, 0], [4096, 0], [0, 2900]]) assert.ok(!viewInCameraBounds(bounds, x, y), `${x}, ${y} is outside`);
  // Every edge is inside, a step past it isn't.
  assert.ok(viewInCameraBounds(bounds, -2816, -3328) && viewInCameraBounds(bounds, 2816, 2816));
  assert.ok(!viewInCameraBounds(bounds, -2816.5, 0) && !viewInCameraBounds(bounds, 0, -3328.5) && !viewInCameraBounds(bounds, 0, 2816.5));
  // The corners in another order give the same rectangle.
  assert.ok(!viewInCameraBounds([2816, 2816, -2816, -3328, 2816, -3328, -2816, 2816], 3000, 0));
  // Only the first two corners (left, bottom, right, top).
  assert.ok(!viewInCameraBounds([-100, -100, 100, 100], 101, 0) && viewInCameraBounds([-100, -100, 100, 100], 100, 0));
  // No bounds to go by: nothing is refused.
  for (const none of [null, undefined, [], [1, 2, 3], [0, 0, NaN, 5], [5, 5, 5, 5], "x" as unknown as number[]]) assert.ok(viewInCameraBounds(none, 1e9, -1e9));
  assert.match(VIEW_OUTSIDE_BOUNDS, /outside of the world camera bounds/);
});

test("targetInCameraBounds: a typed target past the camera bounds lands on the bound, as in the World Editor's Camera Properties", () => {
  const bounds = [-2816, -3328, 2816, 2816, -2816, 2816, 2816, -3328];
  // The World Editor: Target X 3100 of a camera at 2700, -600 became 2816 with Enforce Camera Bounds on.
  assert.deepEqual(targetInCameraBounds(bounds, 3100, -600), [2816, -600]);
  // Inside, and on the bound, a target stays.
  assert.deepEqual(targetInCameraBounds(bounds, 2700, -600), [2700, -600]);
  assert.deepEqual(targetInCameraBounds(bounds, 2816, 2816), [2816, 2816]);
  // Each side, and a corner: the bottom bound (-3328) isn't the top one (2816).
  assert.deepEqual(targetInCameraBounds(bounds, -9000, 0), [-2816, 0]);
  assert.deepEqual(targetInCameraBounds(bounds, 0, 3000), [0, 2816]);
  assert.deepEqual(targetInCameraBounds(bounds, 0, -3000), [0, -3000]);
  assert.deepEqual(targetInCameraBounds(bounds, 5000, -5000), [2816, -3328]);
  // What it holds is what viewInCameraBounds lets through.
  assert.ok(viewInCameraBounds(bounds, ...targetInCameraBounds(bounds, 1e6, -1e6)));
  // The switch off (no bounds passed), a map without bounds, or no number: as typed.
  assert.deepEqual(targetInCameraBounds(null, 3100, -600), [3100, -600]);
  assert.deepEqual(targetInCameraBounds([1, 2, 3], 3100, -600), [3100, -600]);
  assert.deepEqual(targetInCameraBounds(bounds, NaN, 5), [NaN, 5]);
});
