import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraColors, cameraEye, cameraMarkers, DEPTH_OF_FIELD, LAYER_LOOK, MARKER_RGB, nameDepthOfField, type CameraLook } from "./cameras";

const cam = { targetX: 640, targetY: 640, rotation: 0, distance: 640, angleOfAttack: 0, fieldOfView: 60 };
const W = 40, H = 40;
const texel = (rgba: Uint8Array, x: number, y: number) => [...rgba.slice(((Math.floor(y / 32)) * W + Math.floor(x / 32)) * 4, ((Math.floor(y / 32)) * W + Math.floor(x / 32)) * 4 + 4)];

test("cameraColors: the target and the eye are drawn where the camera is, nothing elsewhere", () => {
  assert.deepEqual(cameraEye(cam), [0, 640]);
  const rgba = cameraColors([cam], W, H, 0, 0);
  const at = (x: number, y: number) => texel(rgba, x, y)[3];
  assert.equal(at(640, 640), 255);
  assert.equal(at(16, 656), 255);
  assert.ok(at(320, 656) > 0, "the line between them");
  assert.equal(at(1200, 100), 0);
  assert.equal(cameraColors([{ ...cam, fieldOfView: NaN }], W, H, 0, 0).every((v) => v === 0), true, "a camera with a broken value is left out whole");
});

test("cameraColors: each camera takes the look it is given, and the later one is drawn over the earlier", () => {
  const blue: CameraLook = { fov: [0, 0, 200, 100], line: [0, 0, 200, 200], target: [0, 0, 255, 255], eye: [0, 0, 255, 255], targetRadius: 3, eyeRadius: 2 };
  const other = { ...cam, name: "other" };
  const rgba = cameraColors([cam, other], W, H, 0, 0, (c) => (c === other ? blue : LAYER_LOOK));
  assert.deepEqual(texel(rgba, 640, 640), blue.target, "the second camera's target lies over the first's");
  // A target radius of 3 reaches three cells out; the layer's own 2 doesn't.
  assert.deepEqual(texel(rgba, 640 + 3 * 32, 640), blue.target);
  assert.deepEqual(texel(cameraColors([cam], W, H, 0, 0), 640 + 3 * 32, 640), [0, 0, 0, 0]);
});

/** The corners of cameraMarkers' triangles as [x, y, z], and their colours. */
const corners = (data: number[]) => Array.from({ length: data.length / 7 }, (_, i) => data.slice(i * 7, i * 7 + 3));
const colours = (data: number[]) => Array.from({ length: data.length / 7 }, (_, i) => data.slice(i * 7 + 3, i * 7 + 7));

test("cameraMarkers: the World Editor's marker, an arrow from a small camera to the target, scaled by the distance", () => {
  // Looking west along the ground (as we-drive's flat cameras of distance 500, 1000 and 2000): the arrow's tip on the
  // target, the camera's back 0.365 of the distance east of it, nothing beyond (no footprint, no eye-to-target wedge).
  for (const distance of [500, 1000, 2000]) {
    const c = { targetX: -1200, targetY: 600, zOffset: 0, rotation: 180, angleOfAttack: 0, distance, fieldOfView: 70 };
    const data = cameraMarkers([c], () => 50);
    assert.equal(data.length % 21, 0, "whole triangles of 7 floats a corner");
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

test("cameraMarkers: blue faces, shaded; a camera with a broken value or no distance is left out", () => {
  const c = { targetX: 0, targetY: 0, rotation: 0, angleOfAttack: 0, distance: 1000, fieldOfView: 70 };
  const cols = colours(cameraMarkers([c], () => 0));
  for (const [r, g, b, a] of cols) {
    assert.equal(a, 1);
    assert.ok(b > r && b > g, `blue: ${[r, g, b]}`);
    for (const [v, base] of [[r, MARKER_RGB[0]], [g, MARKER_RGB[1]], [b, MARKER_RGB[2]]]) assert.ok(v <= base / 255 + 1e-6 && v >= 0.72 * base / 255 - 1e-6);
  }
  assert.ok(new Set(cols.map((v) => v[2].toFixed(3))).size > 2, "the faces are shaded apart");
  assert.deepEqual(cameraMarkers([{ ...c, distance: NaN }, { ...c, distance: 0 }, { ...c, rotation: Infinity }, { ...c, zOffset: NaN }], () => 0), []);
  assert.deepEqual(cameraMarkers([c], () => NaN), [], "a target off the ground's numbers");
  assert.equal(cameraMarkers([c, { ...c, targetX: 500 }], () => 0).length, 2 * cameraMarkers([c], () => 0).length, "one marker per camera");
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
