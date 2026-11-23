import assert from "node:assert/strict";
import { test } from "node:test";
import { readFixture } from "../testhelpers/testutil";
import { CAMERA_FIELDS, CAMERA_RANGES, type CameraField, cameraFieldName, cameraMarkers, DEPTH_OF_FIELD, typedCameraValue, EDITOR_VIEW_CLIP, FAR_CLIP, MARKER_RGB, MARKER_STRIDE, markerHandles, nameDepthOfField, segmentDistance, stepFarClip, targetInCameraBounds, VIEW_OUTSIDE_BOUNDS, ViewClipping, viewDepthRange, viewInCameraBounds } from "./cameras";

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

test("ViewClipping: a camera from the view takes the view's clipping, the World Editor's own until a camera is looked through", () => {
  // we-compare camera-farz (2026-11-15): the opening view gives far 50000, near 16, at any distance; looking through
  // cameras of distance 500 to 5000 with far 5000 / near 100 or far 9000 / near 50 gave exactly those, not distance + 3000.
  const clip = new ViewClipping();
  assert.deepEqual(clip.current(), { farZ: 50000, nearZ: 16 });
  assert.deepEqual(EDITOR_VIEW_CLIP, { farZ: 50000, nearZ: 16 });
  for (const [distance, farZ, nearZ] of [[500, 5000, 100], [1000, 9000, 50], [1650, 5000, 100], [2000, 9000, 50], [2500, 5000, 100], [3000, 9000, 50], [4000, 5000, 100], [5000, 9000, 50]]) {
    clip.lookThrough({ distance, farZ, nearZ } as { farZ: number; nearZ: number });
    assert.deepEqual(clip.current(), { farZ, nearZ }, `a camera of distance ${distance}`);
  }
  // A camera without numbers there leaves the view's clipping; what current() gives is a copy.
  clip.lookThrough({ farZ: NaN });
  assert.deepEqual(clip.current(), { farZ: 9000, nearZ: 50 });
  clip.current().farZ = 1;
  assert.equal(clip.current().farZ, 9000);
  // Each view starts with the editor's own clipping.
  assert.deepEqual(new ViewClipping().current(), { farZ: 50000, nearZ: 16 });
});

test("stepFarClip: Adjust Clipping steps the far clipping by 1.1 a notch in single precision, within 101 and 100000", () => {
  // we-drive 2026-11-23 (branch feat/camera-cutoff): Create Camera after each run of Ctrl+wheel notches from the
  // opening view (far 50000), the cameras' far as saved (war3map.w3c floats). Negative: Wheel Down (farther).
  const run = (start: number, notches: number[]) => {
    const out: number[] = [];
    let far = start;
    for (const n of notches) {
      for (let i = 0; i < Math.abs(n); i++) far = stepFarClip(far, n < 0);
      out.push(far);
    }
    return out;
  };
  const seen = [55000, 60500, 80525.5, 50000, 45454.543, 34150.67, 100000, 101].map(Math.fround);
  assert.deepEqual(run(50000, [-1, -1, -3, 5, 1, 3, -60, 120]), seen);
  // From a looked-through camera's far 5000 (near 100): two notches nearer 4132.23, two more 3415.07, six farther
  // 6050, sixty nearer 101 (the floor doesn't follow the near clipping), then one farther 111.100006.
  assert.deepEqual(run(5000, [2, 2, -6, 60, -1]), [4132.2314, 3415.0671, 6050, 101, 111.100006].map(Math.fround));
  assert.deepEqual(FAR_CLIP, { step: 1.1, min: 101, max: 100000 });
  // The ends hold: a step past either stays there, and a far beyond them comes back within at the next step.
  assert.equal(stepFarClip(100000, true), 100000);
  assert.equal(stepFarClip(101, false), 101);
  assert.equal(stepFarClip(1e9, false), 100000);
  assert.equal(stepFarClip(1, true), 101);
  assert.equal(stepFarClip(NaN, true), Math.fround(55000));
  // Control: plain double arithmetic gives another 50000 / 1.1 (the editor's is the float's).
  assert.notEqual(Math.fround(50000 / 1.1), stepFarClip(50000, false));
  // ViewClipping keeps the near clipping and a camera made afterwards takes the stepped far.
  const clip = new ViewClipping();
  clip.lookThrough({ farZ: 5000, nearZ: 100 });
  clip.stepFar(false);
  clip.stepFar(false);
  assert.deepEqual(clip.current(), { farZ: Math.fround(4132.2314), nearZ: 100 });
});

test("viewDepthRange: the far plane is the view's far clipping whatever the zoom, the near one stays short of it", () => {
  // The World Editor zoomed out to 100000 with far 40960 shows nothing: the far plane doesn't follow the distance.
  assert.deepEqual(viewDepthRange(3000, 50000), { near: 60, far: 50000 });
  assert.deepEqual(viewDepthRange(100000, 40960), { near: 2000, far: 40960 });
  assert.deepEqual(viewDepthRange(200, 3415), { near: 10, far: 3415 });
  // At the floor (101) from far out the near plane comes in to keep the projection whole.
  const low = viewDepthRange(20000, 101);
  assert.ok(low.near > 0 && low.near < low.far, JSON.stringify(low));
  // A camera's far that is no use (0, negative, not a number) draws with the editor's own.
  for (const bad of [0, -5, NaN, Infinity]) assert.equal(viewDepthRange(3000, bad).far, 50000, String(bad));
  // Control: the old rule followed the zoom (ten times the distance).
  assert.notEqual(viewDepthRange(3000, 50000).far, 3000 * 10);
});

test("typedCameraValue: a value war3map.w3c's float can't hold is refused for every field, and the cameras stay as they were", () => {
  const camera = () => ({ targetX: 1, targetY: 2, zOffset: 3, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70,
    farZ: 5000, nearZ: 16, dofDistance: 0, dofScale: 0, posAbsoluteZ: 0, name: "Look" });
  assert.equal(CAMERA_FIELDS.length, 13);
  for (const [key] of CAMERA_FIELDS) {
    const title = cameraFieldName(key);
    assert.ok(title && !title.includes("("), title);
    const cams = [camera(), camera()];
    const before = structuredClone(cams);
    for (const typed of ["1e39", "-1e39", "Infinity", "NaN", "", "  ", "abc"]) {
      const got = typedCameraValue(cams, cams, key, typed);
      assert.ok("refused" in got, `${key} = ${JSON.stringify(typed)} was taken`);
      assert.ok(got.refused.startsWith(`${title} must be a number`), got.refused);
      assert.deepEqual(cams, before, `${key} = ${typed} changed a camera`);
    }
    // Controls: a plain value goes through (and the float's ends where the field has no narrower range), for the cameras whose value it changes.
    const ends = CAMERA_RANGES[key] ? [] : ["3.4028234663852886e38", "-3.4028234663852886e38"];
    for (const typed of [...ends, key === "farZ" ? "6000" : "100"]) {
      const got = typedCameraValue(cams, cams, key, typed);
      assert.ok(!("refused" in got), `${key} = ${typed} was refused (control)`);
      assert.equal(got.value, Number(typed));
      assert.equal(got.changing.length, 2);
    }
    const same = typedCameraValue(cams, [cams[0]], key, String(cams[0][key]));
    assert.ok(!("refused" in same) && same.changing.length === 0, `${key}: its own value is no change`);
  }
  // A camera no longer in the list (deleted while the value was typed) isn't changed.
  const [a, b] = [camera(), camera()];
  const got = typedCameraValue([a], [a, b], "distance", "2000");
  assert.ok(!("refused" in got) && got.changing.length === 1 && got.changing[0] === a);
});

test("typedCameraValue: what the World Editor's Camera Properties would move (we-drive 2026-11-16) is refused, its own limits go through", () => {
  const camera = () => ({ targetX: 0, targetY: 0, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70,
    farZ: 5000, nearZ: 100 });
  const refused = (key: CameraField, typed: string, c = camera()) => {
    const got = typedCameraValue([c], [c], key, typed);
    assert.ok("refused" in got, `${key} = ${typed} was taken`);
    return got.refused;
  };
  const taken = (key: CameraField, typed: string, c = camera()) => {
    const got = typedCameraValue([c], [c], key, typed);
    assert.ok(!("refused" in got), `${key} = ${typed} was refused: ${"refused" in got ? got.refused : ""}`);
    assert.equal(got.value, Number(typed));
  };
  // [field, the refused values (editor's results), the accepted ones (the ends, and a value inside)]
  const table: [CameraField, string[], string[]][] = [
    ["distance", ["0", "-100", "0.3", "0.49", "100000.5", "1000000"], ["0.5", "1", "100000"]],
    ["rotation", ["-50", "-0.5", "360.5", "400"], ["0", "90", "360"]],
    ["angleOfAttack", ["-100", "360.5", "500"], ["0", "304", "360"]],
    ["roll", ["-1", "360.5", "500"], ["0", "180", "360"]],
    ["fieldOfView", ["0", "4.5", "120.5", "180", "200"], ["5", "70", "119.9", "120"]],
    ["zOffset", ["-4096.5", "4097", "10000000", "-10000000"], ["-4096", "-300", "4096"]],
    ["nearZ", ["-5", "9500.5", "10000000", "4999.5", "5000", "6000"], ["0", "0.5", "4999", "100"]],
    ["farZ", ["0", "1", "10", "50", "-50", "100.5", "100", "100000.5", "10000000"], ["101", "5000", "100000"]],
    // we-drive 2026-11-18 (branch we-compare-4): DoF Distance 0 to 10000, DoF Scale 0 to 1000, Pos Absolute Z ±4096.
    ["dofDistance", ["-100", "-0.5", "10000.5", "10000000"], ["0", "0.3", "10000"]],
    ["dofScale", ["-5", "1000.5", "10000000"], ["0", "0.25", "1000"]],
    ["posAbsoluteZ", ["-4096.5", "4097", "123456", "-10000000"], ["-4096", "-300", "4096"]],
  ];
  for (const [key, bad, good] of table) {
    for (const typed of bad) refused(key, typed);
    for (const typed of good) taken(key, typed);
  }
  // The gap between near and far: far 150 with near 149 and near 100 with far 101 stay, a gap under 1 doesn't.
  taken("farZ", "150", { ...camera(), nearZ: 149 });
  refused("farZ", "150", { ...camera(), nearZ: 149.5 });
  taken("nearZ", "4999", camera());
  assert.match(refused("nearZ", "5000"), /below the far clipping \(5000\)/);
  assert.match(refused("farZ", "101", { ...camera(), nearZ: 100.5 }), /above the near clipping \(100.5\)/);
  assert.match(refused("distance", "0"), /must be from 0\.5 to 100000\./);
  // A camera that already holds an out-of-range value keeps it: typing its own value is no change, no refusal.
  const odd = { ...camera(), distance: 0, fieldOfView: 200 };
  const same = typedCameraValue([odd], [odd], "distance", "0");
  assert.ok(!("refused" in same) && same.changing.length === 0);
});

test("typedCameraValue agrees with every Camera Properties value recorded from the World Editor (camera-region-limits-we.json)", () => {
  const rec = JSON.parse(readFixture("we-specs", "camera-region-limits-we.json")) as { cameras: { field: CameraField; typed: number; we: number; moved?: boolean }[] };
  assert.equal(rec.cameras.length, 51, "the recording's rows");
  // Every row names a field Studio has, and the recording covers the fields it can type (not targetX/targetY).
  for (const row of rec.cameras) assert.ok(CAMERA_FIELDS.some(([k]) => k === row.field), `unknown field ${row.field}`);
  assert.deepEqual([...new Set(rec.cameras.map((r) => r.field))].sort(),
    ["angleOfAttack", "distance", "dofDistance", "dofScale", "farZ", "fieldOfView", "nearZ", "posAbsoluteZ", "roll", "rotation", "zOffset"]);
  let kept = 0, changed = 0;
  for (const row of rec.cameras) {
    const c = { targetX: 0, targetY: 0, zOffset: 1, rotation: 91, angleOfAttack: 305, distance: 1650, roll: 1, fieldOfView: 71, farZ: 5000, nearZ: 100, dofDistance: 1, dofScale: 1, posAbsoluteZ: 1 };
    const got = typedCameraValue([c], [c], row.field, String(row.typed));
    const editorKept = row.we === row.typed && !row.moved;
    if (editorKept) { kept++; assert.ok(!("refused" in got), `${row.field} = ${row.typed}: the editor kept it, Studio refused: ${"refused" in got ? got.refused : ""}`); }
    else { changed++; assert.ok("refused" in got, `${row.field} = ${row.typed}: the editor changed it (to ${row.we}), Studio took it`); }
  }
  assert.deepEqual({ kept, changed }, { kept: 15, changed: 36 });
});
