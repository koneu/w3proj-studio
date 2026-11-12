import assert from "node:assert/strict";
import { test } from "node:test";
import { boxOf, composeLayers, cycleIndex, GRID_STEP, groundPathingColors, layerCameras, layerRegions, MAX_PITCH, navalColors, nextGrid, regionColors, toggleGrid, viewOfBox, viewOfMap, type Angle, type Box, type GridSize } from "./viewcmds";
import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";

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

test("viewOfMap: as the World Editor, straight down, north up, framed by the playable part's larger side, its south kept", () => {
  // The World Editor's pictures in its 1184x844 view (we-drive, 2026-11-11), new maps with the usual border (6 tiles
  // left and right, 4 below, 8 above): the whole map's sides and its south edge, in pixels.
  const W = 1184, H = 844, aspect = W / H;
  const seen = [
    { tiles: [64, 64], left: 18, right: 1165, south: 734 },
    { tiles: [128, 64], left: 77, right: 1106, south: 450 },
    { tiles: [64, 128], left: 334, right: 849, south: 696 },
  ];
  for (const fov of [Math.PI / 4, 1.2]) {
    for (const { tiles: [tw, th], left, right, south } of seen) {
      const map: Box = { minX: -tw * 64, maxX: tw * 64, minY: -th * 64, maxY: th * 64, minZ: 0, maxZ: 0 };
      const playable: Box = { minX: map.minX + 6 * 128, maxX: map.maxX - 6 * 128, minY: map.minY + 4 * 128, maxY: map.maxY - 8 * 128, minZ: 0, maxZ: 0 };
      const v = viewOfMap(map, playable, fov, aspect);
      const name = `${tw}x${th} (fov ${fov.toFixed(2)})`;
      assert.ok(v.pitch >= MAX_PITCH && v.pitch < Math.PI / 2, "looks (almost) straight down, within what the mouse can rotate to");
      assert.equal(v.yaw, -Math.PI / 2, "north up");
      const at = (x: number, y: number) => {
        const q = project([x, y, 0], v.target, v.distance, { ...v, fov }, aspect)!;
        return { x: (q.x + 1) / 2 * W, y: (1 - q.y) / 2 * H };
      };
      const sw = at(map.minX, map.minY), se = at(map.maxX, map.minY), nw = at(map.minX, map.maxY);
      assert.ok(Math.abs(sw.x - left) < 2 && Math.abs(se.x - right) < 2, `${name}: the sides at ${left} and ${right}: ${sw.x}, ${se.x}`);
      assert.ok(Math.abs(sw.y - south) < 2 && Math.abs(se.y - south) < 2, `${name}: the south at ${south}: ${sw.y}`);
      assert.ok(nw.y < 0, `${name}: the north is cut off (${nw.y})`);
      const top = at(map.minX, 0);
      assert.ok(Math.abs(top.x - sw.x) < 1.5, `${name}: the sides stay upright: ${top.x} in the middle, ${sw.x} at the south`);
    }
  }
  // Without a playable part the whole map is framed; the target is the playable part's middle across.
  const wide: Box = { minX: 0, maxX: 32768, minY: 0, maxY: 8192, minZ: 100, maxZ: 300 };
  const whole = viewOfMap(wide, null, 1, aspect), same = viewOfMap(wide, wide, 1, aspect);
  assert.deepEqual(whole, same);
  assert.equal(whole.target[0], 16384);
  assert.equal(whole.target[2], 200);
  const offCentre = viewOfMap(wide, { ...wide, minX: 1024 }, 1, aspect);
  assert.equal(offCentre.target[0], (1024 + 32768) / 2);
});

test("cycleIndex: View Selection goes through the selection one object a press and stops at either end", () => {
  // we-drive 2026-11-12, four rocks selected: Next twice, then it stayed; Previous then stayed at its end too.
  assert.equal(cycleIndex(4, -1, 1), 0, "the first press: the first selected");
  assert.equal(cycleIndex(4, 0, 1), 1);
  assert.equal(cycleIndex(4, 3, 1), 3, "Next stays at the last");
  assert.equal(cycleIndex(4, 3, -1), 2);
  assert.equal(cycleIndex(4, 0, -1), 0, "Previous stays at the first");
  assert.equal(cycleIndex(4, -1, -1), 3, "Previous first: the last selected");
  assert.equal(cycleIndex(4, 7, 1), 0, "a look from an older selection starts again");
  assert.equal(cycleIndex(1, 0, 1), 0, "one object: always it");
  assert.equal(cycleIndex(0, -1, 1), -1, "nothing selected");
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
  // G goes round as the World Editor's: none, large, medium, small, none.
  const seen: string[] = [];
  let g: GridSize = "none";
  for (let i = 0; i < 5; i++) seen.push(g = nextGrid(g));
  assert.deepEqual(seen, ["large", "medium", "small", "none", "large"]);
});

test("navalColors: as the World Editor, red where ships can't sail (land, the edge), water clear, shallow or deep", () => {
  const land = 0x40 | 0x08, shallow = 0x08, deep = 0x08 | 0x02, border = 0x80 | 0x40 | 0x08 | 0x04 | 0x02;
  const rgba = navalColors([land, shallow, deep, border]);
  const px = (i: number) => [...rgba.subarray(i * 4, i * 4 + 4)];
  // Half-transparent light red: over ground g, each channel comes out as (g + (255, 128, 128)) / 2, as measured.
  assert.deepEqual(px(0), [255, 128, 128, 128]);
  assert.deepEqual(px(3), [255, 128, 128, 128]);
  assert.deepEqual(px(1), [0, 0, 0, 0]);
  assert.deepEqual(px(2), [0, 0, 0, 0]);
  // The map's edge, past the playable part: flat brown over everything, water or land (a 4x3 grid, its middle 2x1 playable).
  const grid = [land, shallow, deep, border, land, shallow, deep, border, land, shallow, deep, border];
  const edged = navalColors(grid, { width: 4, x0: 1, x1: 3, y0: 1, y1: 2 });
  const at = (x: number, y: number) => [...edged.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  assert.deepEqual(at(1, 1), [0, 0, 0, 0], "sailable water inside stays clear");
  assert.deepEqual(at(2, 1), [0, 0, 0, 0]);
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [3, 1], [0, 1], [1, 2], [3, 2]]) assert.deepEqual(at(x, y), [108, 55, 15, 255], `edge cell ${x},${y}`);
  assert.deepEqual([...navalColors(grid, null)], [...navalColors(grid)], "no playable part: no edge");
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

test("layerCameras: the Camera Editor's cameras, unsaved edits and all, before the saved file's", async () => {
  const saved = [{ name: "saved", targetX: 0, targetY: 0, rotation: 90, distance: 1650, angleOfAttack: 304, fieldOfView: 70 }];
  const edited = [{ ...saved[0], name: "edited", targetX: 512 }];
  let reads = 0;
  const readSaved = async () => { reads++; return saved; };
  assert.deepEqual(await layerCameras([{}, { cameraObjects: async () => edited }], readSaved), edited);
  assert.equal(reads, 0, "the file isn't read while a group holds the cameras");
  assert.deepEqual(await layerCameras([{}], readSaved), saved, "without the Camera Editor, the saved file");
});

test("layerRegions: the Region Editor's regions, unsaved edits and all, before the saved file's", async () => {
  const saved = [{ left: 0, bottom: 0, right: 64, top: 64 }], edited = [{ left: 128, bottom: 0, right: 256, top: 64 }];
  let reads = 0;
  const readSaved = async () => { reads++; return saved; };
  assert.deepEqual(await layerRegions([{}, { regionObjects: async () => edited }], readSaved), edited);
  assert.equal(reads, 0);
  assert.deepEqual(await layerRegions([{}], readSaved), saved);
});

test("groundPathingColors: magenta where nothing walks, blue where nothing is built, clear where both can", () => {
  const rgba = groundPathingColors([NO_WALK | NO_BUILD, NO_BUILD, 0, NO_WALK | NO_WATER | NO_BUILD, NO_WATER]);
  const px = (i: number) => [...rgba.slice(i * 4, i * 4 + 4)];
  assert.ok(px(0)[0] > 200 && px(0)[2] > 200 && px(0)[1] < 100 && px(0)[3] > 0, `${px(0)}`);
  assert.ok(px(1)[2] > 200 && px(1)[0] < 100 && px(1)[3] > 0, `${px(1)}`);
  assert.equal(px(2)[3], 0);
  assert.deepEqual(px(3), px(0), "a cliff and deep water look alike: nothing walks there");
  assert.equal(px(4)[3], 0);
});

test("regionColors: each region filled in its colour inside a darker edge, small ones over large ones, nothing outside", () => {
  // 8 × 4 cells of 32 from (-128, -64): a large red region over all of it, a small blue one at cells 1–2 × 1–2.
  const big = { left: -128, bottom: -64, right: 128, top: 64, color: { red: 255, green: 0, blue: 0 } };
  const small = { left: -96, bottom: -32, right: 0, top: 64, color: { red: 0, green: 0, blue: 255 } };
  const rgba = regionColors([small, big], 8, 4, -128, -64);
  const px = (x: number, y: number) => [...rgba.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
  assert.deepEqual(px(0, 0).slice(0, 3), [255 * 0.3, 0, 0].map(Math.floor), "the big one's edge");
  assert.deepEqual(px(5, 1), [255, 0, 0, 170], "the big one's inside");
  assert.equal(px(2, 2)[2], 255, "the small one's inside, over the big one");
  assert.equal(px(2, 2)[0], 0);
  assert.equal(px(1, 1)[3], 235, "the small one's edge");
  // Outside the map and broken numbers: nothing, no throw.
  const none = regionColors([{ left: 1000, bottom: 1000, right: 2000, top: 2000 }, { left: NaN, bottom: 0, right: 1, top: 1 }], 8, 4, -128, -64);
  assert.ok(none.every((v) => v === 0));
});
