import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decode, encode, HD_PATH_FLATTEST, HD_REFLECT_DEPTH, HD_WATER_TILT, HD_SHALLOW_DEPTHS, HD_SHALLOW_SHARE, HD_WATER_DEFAULTS, HD_WATER_DEPTHS, HD_WATER_GLSL, HD_WATER_OWN, HD_WATER_PATHS, HD_WATER_THROUGH, HD_WAVE_LIGHT,
  HD_WAVE_RED, HD_WAVES, HD_DEPTH_EXTRA, HD_DEPTH_EXTRA_FULL, hdDepthExtra, hdTableDepth, hdReflectScale, hdShallowAt, hdSky, hdSkyFlat, HD_SKY_FLAT, type FlatSky, hdWaterAt, hdWaterPath, hdWaterPixel, hdWaterSettings, hdWaveLean, hdWaveLight,
  hdWaveShift,
} from "./hdwater";
import { HD_DEEP, HD_SHALLOW, HD_TINT_CAP, hdWaterColor, hdWaterShallow } from "./renderer";

// The World Editor's HD pictures these come from (we-drive, branch water-render-we, 2026-11-14; docs/testing/terrain-and-water.md "HD water"):
// flat 128 × 96 maps of eight depths in bands across the map, View Entire Map, mean colours of the bands in a west, a
// middle and an east column, the same maps with Water off for the bed.

/** The camera of a picture (Studio's terms: target, distance, yaw, pitch, vertical field of view) at the editor's
 *  1184 × 844 view: the ray (from the eye) through a pixel. */
function ray(cam: { target: number[]; distance: number; yaw: number; pitch: number; fov: number }, px: number, py: number): number[] {
  const W = 1184, H = 844;
  const norm = (v: number[]) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const { target, distance, yaw, pitch, fov } = cam;
  const eye = [target[0] + distance * Math.cos(pitch) * Math.cos(yaw), target[1] + distance * Math.cos(pitch) * Math.sin(yaw), target[2] + distance * Math.sin(pitch)];
  const f = norm(target.map((t, i) => t - eye[i]));
  const r = norm(cross(f, [0, 0, 1])), u = cross(r, f);
  const t = Math.tan(fov / 2), nx = (2 * (px + 0.5)) / W - 1, ny = 1 - (2 * (py + 0.5)) / H;
  return norm([0, 1, 2].map((i) => f[i] + nx * t * (W / H) * r[i] + ny * t * u[i]));
}
/** The camera's axis (from the eye to the target, unit). */
function axis(cam: { distance: number; yaw: number; pitch: number }): number[] {
  return [-Math.cos(cam.pitch) * Math.cos(cam.yaw), -Math.cos(cam.pitch) * Math.sin(cam.yaw), -Math.sin(cam.pitch)];
}
/** View Entire Map of the 128 × 96 maps (Studio's, at the editor's field of view, which the pictures line up with). */
const ENTIRE = { target: [704, -2867.5, -161.5], distance: 17168, yaw: -Math.PI / 2, pitch: 1.5688, fov: 0.7166 };
/** The bands' rows and the columns' pixels in the editor's pictures. */
const ROWS: Record<string, number> = { 12: 57, 38.4: 217, 96: 377, 800: 520 };
const COLS: Record<string, number> = { west: 240, mid: 600, east: 955 };

const within = (got: readonly number[], want: readonly number[], tol: number, what: string) =>
  assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= tol), `${what}: ${got.map(Math.round)} against the editor's ${want} (±${tol})`);
const deep = (ts: string) => hdWaterColor(ts, null);

test("HD water's tables: none of the water at 0, all of it from 200 deep, linear between the measured depths", () => {
  assert.deepEqual(hdWaterAt(0), { through: 1, own: 0, reflect: 0 });
  assert.deepEqual(hdWaterAt(-5), { through: 1, own: 0, reflect: 0 }, "above the surface: the bed alone");
  assert.deepEqual(hdWaterAt(200), { through: 0, own: 1, reflect: 1 });
  assert.deepEqual(hdWaterAt(5000), { through: 0, own: 1, reflect: 1 });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  // The bed's and the deep colour's shares go by the path, the reflection's by the depth.
  HD_WATER_PATHS.forEach((p, i) => {
    const w = hdWaterAt(1000, p);
    assert.ok(near(w.through, HD_WATER_THROUGH[i]) && near(w.own, HD_WATER_OWN[i]), `along ${p}: ${JSON.stringify(w)}`);
  });
  HD_WATER_DEPTHS.forEach((d, i) => assert.ok(near(hdWaterAt(d, 1000).reflect, HD_REFLECT_DEPTH[i]), `at ${d}`));
  assert.deepEqual(hdWaterAt(24), hdWaterAt(24, 24), "the path is the depth unless given");
  const half = hdWaterAt(20);
  assert.ok(Math.abs(half.through - (HD_WATER_THROUGH[3] + HD_WATER_THROUGH[4]) / 2) < 1e-9, "20 is halfway between 16 and 24");
  // The thickness along the camera's axis: the path through the water (the depth over the cosine of the view's angle
  // from straight down, never flatter than 0.2) times the cosine of the view's angle from the axis, less by the
  // camera's tilt; any lengths. A camera looking straight down (the default): the depth anywhere in its picture.
  assert.equal(hdWaterPath(50, [0, 0, -3]), 50);
  assert.ok(near(hdWaterPath(50, [0, 3, -4]), 50), "the side of a straight-down camera's picture");
  assert.ok(near(hdWaterPath(50, [0, 3, -4], [0, 0, -7]), 50));
  assert.equal(hdWaterPath(50, [0, 0, 0]), 50, "no view: the depth");
  // A camera 0.8 below the horizon (sine), looking along the view: the path, 1 − 0.2 × HD_WATER_TILT of it.
  const tilt = 1 - HD_WATER_TILT * 0.2;
  assert.ok(near(hdWaterPath(50, [0, 3, -4], [0, 6, -8]), 62.5 * tilt));
  assert.ok(near(hdWaterPath(50, [0, 0, -1], [0, 3, -4]), 50 * 0.8 * tilt), "straight down through that camera's picture");
  assert.ok(near(hdWaterPath(50, [1, 0, 0], [1, 0, 0]), (50 / HD_PATH_FLATTEST) * (1 - HD_WATER_TILT)), "along the surface: no flatter than 0.2");
  assert.ok(near(hdWaterPath(50, [0, 0, -1], [1, 0, 0]), 50 * HD_PATH_FLATTEST * (1 - HD_WATER_TILT)), "never less than the flattest share of the view");
  // The shader holds the same tables, in the same places: the depths, the paths, then hdWaterAt's through, own,
  // reflect in that order, and the same flattest view.
  assert.deepEqual(glslTables(/const float HD_DEPTHS\[8\] = (float\[8\]\([^)]*\))/), [[...HD_WATER_DEPTHS]]);
  assert.deepEqual(glslTables(/const float HD_PATHS\[\d+\] = (float\[\d+\]\([^)]*\))/), [[...HD_WATER_PATHS]]);
  assert.deepEqual(glslTables(/vec3 hdWaterAt\(float d, float p\) \{\s*return vec3\((.*?)\);\s*\}/s), [[...HD_WATER_THROUGH], [...HD_WATER_OWN], [...HD_REFLECT_DEPTH]]);
  const glslPath = /return d \/ max\(-view\.z, ([\d.]+)\) \* max\(dot\(view, forward\), ([\d.]+)\) \* \(1\.0 - ([\d.]+) \* \(1\.0 \+ forward\.z\)\);/.exec(HD_WATER_GLSL);
  assert.deepEqual([Number(glslPath?.[1]), Number(glslPath?.[2]), Number(glslPath?.[3])], [HD_PATH_FLATTEST, HD_PATH_FLATTEST, HD_WATER_TILT]);
});

/** The `float[n](…)` tables inside the part of the shader a pattern's first group matches, as numbers. */
function glslTables(pattern: RegExp): number[][] {
  const part = pattern.exec(HD_WATER_GLSL)?.[1];
  assert.ok(part, `the GLSL has ${pattern}`);
  return [...part.matchAll(/float\[\d+\]\(([^)]*)\)/g)].map((m) => m[1].split(",").map(Number));
}

test("the w3i's water settings: its reflectivity and environment map reflectivity, a new map's 10 and 100 otherwise", () => {
  assert.deepEqual(hdWaterSettings({ reflectivity: 20, environmentMapReflectivity: 50, maxOpacity: 100 }), { reflectivity: 20, environment: 50, waves: 100 });
  assert.deepEqual(hdWaterSettings({ wavesNormalMapStrength: 40 }), { ...HD_WATER_DEFAULTS, waves: 40 }, "the waves' strength");
  assert.deepEqual(hdWaterSettings(undefined), HD_WATER_DEFAULTS, "an older w3i without the block");
  assert.deepEqual(hdWaterSettings({ reflectivity: "x", environmentMapReflectivity: Number.NaN, wavesNormalMapStrength: null }), HD_WATER_DEFAULTS, "not numbers");
  assert.deepEqual(hdWaterSettings({ reflectivity: -3, environmentMapReflectivity: 100, wavesNormalMapStrength: -1 }), { reflectivity: 0, environment: 100, waves: 0 }, "negative: none");
  assert.deepEqual(hdReflectScale(HD_WATER_DEFAULTS), [1, 0.113]);
  assert.deepEqual(hdReflectScale({ reflectivity: 0, environment: 100 }), [0, 0], "reflectivity 0: no reflection, nothing dimmed");
});

/**
 * The editor's game view through `--look 0,Y,D,304,70,90` over a band `depth` deep (surface 38.4): Studio's camera for it
 * (we-camera.mjs studioCamera: the target 298/3000 of the distance back, on the bed; 2738/3000 of the distance).
 */
const gameCam = (y: number, depth: number, distance = 1200) =>
  ({ target: [0, y - (298 / 3000) * distance, 38.4 - depth], distance: (2738 / 3000) * distance, yaw: -Math.PI / 2, pitch: 0.99833, fov: 0.71663 });
/**
 * Bands of the editor's game view (we-drive, HD, branch hd-deep-water, 2026-11-20; Lordaeron maps from
 * make-water-tilesets.mjs --depths 4,8,16,24,40,56,72,800 and 32,64,96,128,160,200,800,800, the look's Y in a band's
 * middle): [Y, depth, boxes of 60 rows (from py − 30) in three columns (200 to 440, 472 to 712, 784 to 1084), the first,
 * middle and last that lie in the band: [px, py, the editor's colour]]. The dry ground (nv-L.w3x through the same
 * looks: the camera stands on the ground, so the bed is seen as there) is 133, 92, 27 everywhere.
 */
type GameBand = [number, number, [number, number, number[]][]];
const GAME_BED = [133.4, 92.4, 27.3];
/** With the w3i's reflectivity 0 (the -r0 maps), from 1200. */
const GAME_OFF: GameBand[] = [
  [2624, 8, [[320, 130, [120, 84, 32]], [320, 370, [125, 88, 30]], [320, 610, [125, 87, 30]], [592, 130, [118, 83, 32]], [592, 370, [125, 87, 30]], [592, 610, [124, 86, 30]], [934, 130, [127, 88, 29]], [934, 370, [123, 86, 30]], [934, 610, [123, 86, 31]]]],
  [1600, 16, [[320, 130, [110, 78, 35]], [320, 370, [115, 82, 33]], [320, 610, [117, 83, 33]], [592, 130, [111, 79, 34]], [592, 370, [118, 83, 32]], [592, 610, [116, 82, 33]], [934, 130, [113, 80, 34]], [934, 370, [114, 81, 33]], [934, 610, [118, 83, 32]]]],
  [576, 24, [[320, 130, [101, 73, 38]], [320, 370, [105, 75, 37]], [320, 610, [106, 76, 36]], [592, 130, [102, 74, 37]], [592, 370, [102, 74, 37]], [592, 610, [110, 79, 35]], [934, 130, [106, 76, 36]], [934, 370, [105, 76, 36]], [934, 610, [111, 79, 34]]]],
  [-448, 40, [[320, 130, [80, 62, 44]], [320, 370, [90, 67, 41]], [320, 610, [94, 69, 39]], [592, 130, [82, 64, 43]], [592, 370, [88, 66, 42]], [592, 610, [96, 70, 39]], [934, 130, [81, 63, 44]], [934, 370, [87, 66, 41]], [934, 610, [95, 70, 39]]]],
  [-1472, 56, [[320, 130, [55, 52, 50]], [320, 370, [66, 56, 48]], [320, 610, [77, 61, 45]], [592, 130, [54, 51, 51]], [592, 370, [68, 57, 47]], [592, 610, [76, 60, 45]], [934, 130, [55, 52, 51]], [934, 370, [69, 58, 47]], [934, 610, [76, 60, 45]]]],
  [2624, 64, [[320, 130, [40, 47, 55]], [320, 370, [59, 54, 50]], [320, 610, [67, 56, 47]], [592, 130, [38, 46, 55]], [592, 370, [58, 53, 50]], [592, 610, [66, 55, 48]], [934, 130, [47, 50, 53]], [934, 370, [56, 52, 50]], [934, 610, [65, 55, 48]]]],
  [-2496, 72, [[320, 130, [29, 46, 57]], [320, 370, [46, 49, 53]], [320, 610, [61, 55, 50]], [592, 130, [29, 47, 57]], [592, 370, [46, 50, 54]], [592, 610, [60, 54, 50]], [934, 130, [26, 46, 58]], [934, 370, [47, 50, 53]], [934, 610, [58, 53, 50]]]],
  [1600, 96, [[320, 130, [0, 46, 69]], [320, 370, [5, 44, 63]], [320, 610, [25, 44, 58]], [592, 130, [0, 49, 69]], [592, 370, [7, 44, 62]], [592, 610, [22, 43, 59]], [934, 130, [0, 47, 68]], [934, 370, [7, 47, 62]], [934, 610, [24, 43, 59]]]],
  [576, 128, [[320, 130, [0, 48, 69]], [320, 310, [0, 47, 69]], [320, 550, [0, 46, 69]], [592, 130, [0, 50, 69]], [592, 310, [0, 45, 69]], [592, 550, [0, 47, 69]], [934, 130, [0, 49, 69]], [934, 310, [0, 47, 69]], [934, 550, [0, 49, 69]]]],
  [-448, 160, [[320, 130, [0, 48, 69]], [320, 310, [0, 47, 69]], [320, 550, [0, 48, 69]], [592, 130, [0, 51, 69]], [592, 310, [0, 48, 69]], [592, 550, [0, 50, 69]], [934, 130, [0, 49, 69]], [934, 310, [0, 47, 69]], [934, 550, [0, 48, 69]]]],
  [-1472, 200, [[320, 130, [0, 47, 69]], [320, 310, [0, 46, 69]], [320, 550, [0, 49, 69]], [592, 130, [0, 49, 69]], [592, 310, [0, 45, 69]], [592, 550, [0, 47, 69]], [934, 130, [0, 48, 69]], [934, 310, [0, 48, 69]], [934, 550, [0, 46, 69]]]],
];
/** The same, from 600 and 2400 (the deep -r0 map): the bed's share goes by the slant, not the distance. */
const GAME_OFF_NEAR_FAR: [number, GameBand[]][] = [
  [600, [
    [2624, 64, [[320, 70, [35, 47, 56]], [320, 430, [59, 53, 50]], [320, 790, [72, 58, 46]], [592, 70, [35, 46, 56]], [592, 430, [58, 53, 50]], [592, 790, [73, 58, 47]], [934, 70, [35, 46, 56]], [934, 430, [57, 53, 50]], [934, 790, [71, 58, 47]]]],
    [1600, 96, [[320, 70, [0, 47, 69]], [320, 430, [13, 45, 61]], [320, 790, [37, 48, 56]], [592, 70, [0, 48, 69]], [592, 430, [13, 45, 61]], [592, 790, [36, 47, 56]], [934, 70, [0, 48, 69]], [934, 430, [12, 45, 61]], [934, 790, [36, 47, 56]]]],
  ]],
  [2400, [
    [2624, 64, [[320, 250, [56, 53, 50]], [320, 310, [58, 53, 50]], [320, 430, [61, 54, 49]], [592, 250, [56, 52, 51]], [592, 310, [58, 53, 50]], [592, 430, [56, 51, 50]], [934, 250, [53, 51, 51]], [934, 310, [58, 53, 50]], [934, 430, [60, 53, 50]]]],
    [1600, 96, [[320, 250, [2, 45, 64]], [320, 310, [6, 45, 63]], [320, 430, [15, 45, 61]], [592, 250, [0, 45, 65]], [592, 310, [1, 44, 64]], [592, 430, [18, 46, 60]], [934, 250, [0, 44, 64]], [934, 310, [4, 45, 63]], [934, 430, [12, 44, 61]]]],
  ]],
];

/** Barrens the same way (make-water-tilesets.mjs … --reflectivity 0 B; its dry ground 80, 49, 29): not fitted on. */
const GAME_BARRENS: GameBand[] = [
  [2624, 8, [[320, 130, [72, 44, 27]], [320, 370, [75, 46, 28]], [320, 610, [75, 46, 28]], [592, 130, [70, 43, 27]], [592, 370, [75, 46, 28]], [592, 610, [74, 45, 28]], [934, 130, [76, 46, 28]], [934, 370, [74, 45, 28]], [934, 610, [73, 45, 27]]]],
  [1600, 16, [[320, 130, [65, 41, 25]], [320, 370, [68, 42, 26]], [320, 610, [70, 43, 26]], [592, 130, [66, 41, 26]], [592, 370, [70, 44, 27]], [592, 610, [69, 43, 26]], [934, 130, [67, 42, 26]], [934, 370, [69, 43, 26]], [934, 610, [70, 43, 27]]]],
  [576, 24, [[320, 130, [59, 38, 24]], [320, 370, [62, 39, 25]], [320, 610, [63, 40, 25]], [592, 130, [61, 39, 25]], [592, 370, [60, 38, 24]], [592, 610, [65, 41, 25]], [934, 130, [62, 39, 25]], [934, 370, [63, 40, 25]], [934, 610, [66, 41, 26]]]],
  [-448, 40, [[320, 130, [46, 33, 22]], [320, 370, [53, 35, 23]], [320, 610, [56, 37, 24]], [592, 130, [48, 34, 23]], [592, 370, [51, 34, 23]], [592, 610, [57, 37, 24]], [934, 130, [48, 33, 23]], [934, 370, [51, 35, 23]], [934, 610, [56, 37, 24]]]],
  [-1472, 56, [[320, 130, [32, 28, 22]], [320, 370, [38, 29, 21]], [320, 610, [45, 32, 22]], [592, 130, [31, 28, 21]], [592, 370, [39, 30, 22]], [592, 610, [44, 32, 22]], [934, 130, [31, 28, 21]], [934, 370, [40, 31, 23]], [934, 610, [44, 31, 22]]]],
  [2624, 64, [[320, 130, [22, 27, 22]], [320, 370, [34, 30, 22]], [320, 610, [39, 30, 22]], [592, 130, [21, 26, 21]], [592, 370, [33, 28, 21]], [592, 610, [38, 29, 21]], [934, 130, [27, 28, 23]], [934, 370, [32, 28, 21]], [934, 610, [37, 28, 21]]]],
  [-2496, 72, [[320, 130, [17, 26, 22]], [320, 370, [27, 28, 22]], [320, 610, [34, 30, 23]], [592, 130, [17, 28, 24]], [592, 370, [26, 28, 23]], [592, 610, [34, 30, 22]], [934, 130, [16, 27, 23]], [934, 370, [27, 28, 22]], [934, 610, [33, 29, 22]]]],
  [1600, 96, [[320, 130, [6, 28, 26]], [320, 370, [7, 26, 23]], [320, 610, [15, 25, 22]], [592, 130, [7, 30, 27]], [592, 370, [8, 27, 24]], [592, 610, [13, 25, 22]], [934, 130, [6, 29, 27]], [934, 370, [8, 29, 26]], [934, 610, [14, 25, 22]]]],
  [576, 128, [[320, 130, [7, 30, 27]], [320, 310, [6, 29, 26]], [320, 550, [6, 28, 25]], [592, 130, [7, 32, 29]], [592, 310, [6, 27, 24]], [592, 550, [6, 29, 26]], [934, 130, [7, 30, 28]], [934, 310, [6, 29, 27]], [934, 550, [7, 31, 28]]]],
  [-448, 160, [[320, 130, [6, 29, 26]], [320, 310, [6, 29, 26]], [320, 550, [7, 30, 27]], [592, 130, [7, 32, 29]], [592, 310, [6, 29, 27]], [592, 550, [7, 31, 28]], [934, 130, [7, 30, 28]], [934, 310, [6, 29, 27]], [934, 550, [6, 30, 27]]]],
  [-1472, 200, [[320, 130, [6, 29, 27]], [320, 310, [5, 26, 24]], [320, 550, [7, 31, 28]], [592, 130, [7, 31, 28]], [592, 310, [6, 28, 25]], [592, 550, [6, 29, 27]], [934, 130, [7, 31, 29]], [934, 310, [6, 29, 27]], [934, 550, [6, 28, 25]]]],
];

/**
 * hdWaterPixel over the bed (GAME_BED, Lordaeron's colours unless given) at each box's middle against the editor's
 * colour: each band's mean within `tol`, every box within `boxTol` (the waves' blotches move a single box by a few
 * levels).
 */
function checkBands(bands: GameBand[], distance: number, settings: Parameters<typeof hdWaterPixel>[4], tol: number, boxTol: number, ts = "L", bed = GAME_BED) {
  for (const [y, depth, boxes] of bands) {
    const cam = gameCam(y, depth, distance), sum = [0, 0, 0], want = [0, 0, 0];
    for (const [px, py, editor] of boxes) {
      const got = hdWaterPixel(bed, depth, deep(ts), ray(cam, px, py), settings, hdWaterShallow(ts, null), 0, null, axis(cam));
      within(got, editor, boxTol, `${depth} deep from ${distance}, the box at ${px}, ${py}`);
      got.forEach((v, k) => { sum[k] += v / boxes.length; want[k] += editor[k] / boxes.length; });
    }
    within(sum, want, tol, `${depth} deep from ${distance}, the band's mean`);
  }
}

test("without the reflection (w3i reflectivity 0) HD water is the bed and the deep colour by its thickness along the camera, as in the editor's game view", () => {
  const off = { reflectivity: 0, environment: 100 };
  // Every band's mean within 2 levels; single boxes up to 8 (64 deep) and 9 (96 deep, the last row before the slope
  // down to 128) off, where the bed shows least evenly.
  checkBands(GAME_OFF, 1200, off, 2, 10);
  for (const [distance, bands] of GAME_OFF_NEAR_FAR) checkBands(bands, distance, off, 2, 6);
  // The same tables on another tileset's bed and colour, not fitted on: every band within 2, every box within 5.
  checkBands(GAME_BARRENS, 1200, off, 2, 5.5, "B", [80, 49, 29]);
  // The control (the open point this closes): through 96 deep water at the view's own slant the editor shows almost
  // none of the bed (red 7 in the middle box), where the depth alone, as if looking straight down, shows much more.
  const [y, depth, boxes] = GAME_OFF[7], [px, py, editor] = boxes[4], view = ray(gameCam(y, depth), px, py);
  const straight = hdWaterPixel(GAME_BED, depth, deep("L"), [0, 0, -1], off), slanted = hdWaterPixel(GAME_BED, depth, deep("L"), view, off, undefined, 0, null, axis(gameCam(y, depth)));
  assert.ok(straight[0] - editor[0] > 20 && slanted[0] < 12, `96 deep: ${straight.map(Math.round)} by the depth, ${slanted.map(Math.round)} along the slanted camera, the editor's ${editor}`);
  assert.ok(hdWaterPath(depth, view, axis(gameCam(y, depth))) > 1.1 * depth, "a slanted camera's thickness is more than the depth");

  // Looking straight down (View Entire Map, branch water-render-we, 2026-11-14: [depth, bed, the editor's water] in the
  // middle column): the shallow bands of the four tilesets, where the editor's View Entire Map agrees with its game
  // view (deeper, its View Entire Map shows less of the bed than the game view: docs/testing/branch-rounds.md, branch
  // hd-deep-water). Ashenvale's water lies 12.8 higher (Water.slk's height).
  const bands: Record<string, [number, number[], number[]][]> = {
    L: [[4, [1, 125, 0], [1, 121, 5]], [12, [1, 125, 0], [1, 115, 15]], [24, [1, 125, 0], [1, 105, 24]]],
    A: [[16.8, [0, 50, 25], [0, 45, 31]], [24.8, [0, 50, 25], [0, 43, 34]]],
    B: [[4, [121, 79, 37], [116, 76, 36]], [12, [121, 80, 37], [110, 72, 34]], [24, [121, 79, 37], [99, 66, 32]]],
    N: [[4, [74, 132, 148], [71, 128, 143]], [12, [74, 132, 148], [66, 120, 134]], [24, [74, 132, 148], [60, 110, 122]]],
  };
  for (const [ts, rows] of Object.entries(bands)) for (const [d, bed, editor] of rows) {
    within(hdWaterPixel(bed, d, deep(ts), [0, 0, -1], off), editor, 3, `${ts} ${d} deep`);
  }
  // And deep: the tileset's colour itself.
  within(hdWaterPixel([255, 255, 255], 800, deep("B"), [0, 0, -1], off), [6, 31, 27], 0.5, "Barrens 800 deep");
});

/**
 * The editor's game view looking straight down (we-drive, HD, branch we-look-hd2, 2026-11-20: `--look 0,Y,1200,270,70,90`
 * over the middle of each band of the -r0 maps of GAME_OFF, the mean of rows 200 to 640 and columns 300 to 900 in linear
 * light): [depth, the editor's colour]. The colour is the same across the picture (96 deep: red 24 to 30 in every column
 * from the middle to the sides, 28° off straight down).
 */
const STRAIGHT_DOWN: [number, number[]][] = [
  [8, [124.5, 87.0, 30.2]], [16, [117.6, 82.9, 32.5]], [24, [108.6, 77.7, 35.3]], [40, [94.6, 69.7, 39.5]], [48, [86.3, 65.4, 42.0]],
  [56, [77.0, 60.8, 44.9]], [64, [67.4, 56.4, 47.5]], [72, [59.8, 54.1, 49.8]], [80, [48.3, 49.4, 52.8]], [96, [27.4, 44.4, 57.8]],
  [112, [3.9, 44.4, 62.9]], [144, [0, 49.0, 69.0]], [176, [0, 48.3, 69.0]],
];

/** GAME_OFF's looks through the angle of attack 304 in STRAIGHT_DOWN's session (48 and 80 deep on the 8, 48, 80, … map,
 *  64 and 96 deep on the 32, 64, 96, … map), the same boxes. */
const GAME_OFF_SAME_SESSION: GameBand[] = [
  [2624, 48, [[320, 130, [71, 59, 47]], [592, 130, [71, 58, 47]], [934, 130, [72, 59, 46]], [320, 370, [79, 62, 44]], [592, 370, [77, 61, 45]], [934, 370, [80, 62, 44]], [320, 610, [89, 67, 41]], [592, 610, [89, 67, 41]], [934, 610, [88, 66, 42]]]],
  [1600, 80, [[320, 130, [10, 43, 61]], [592, 130, [8, 44, 62]], [934, 130, [8, 45, 62]], [320, 370, [29, 45, 57]], [592, 370, [31, 45, 57]], [934, 370, [35, 47, 56]], [320, 610, [49, 51, 53]], [592, 610, [47, 49, 53]], [934, 610, [47, 48, 53]]]],
  [576, 112, [[320, 130, [0, 46, 69]], [592, 130, [0, 47, 69]], [934, 130, [0, 48, 69]], [320, 370, [0, 49, 68]], [592, 370, [0, 48, 68]], [934, 370, [0, 46, 69]], [320, 610, [0, 44, 64]], [592, 610, [0, 44, 64]], [934, 610, [1, 45, 64]]]],
  [2624, 64, [[320, 130, [45, 50, 54]], [592, 130, [46, 50, 53]], [934, 130, [44, 48, 54]], [320, 370, [53, 51, 51]], [592, 370, [55, 52, 51]], [934, 370, [56, 51, 50]], [320, 610, [67, 56, 48]], [592, 610, [71, 59, 46]], [934, 610, [68, 57, 47]]]],
  [1600, 96, [[320, 130, [0, 50, 68]], [592, 130, [0, 48, 68]], [934, 130, [0, 49, 68]], [320, 370, [3, 44, 63]], [592, 370, [5, 43, 63]], [934, 370, [8, 44, 62]], [320, 610, [30, 46, 57]], [592, 610, [29, 46, 57]], [934, 610, [25, 46, 58]]]],
];

test("HD water goes by its thickness along the camera's axis: looking straight down, the same colour across the picture", () => {
  const off = { reflectivity: 0, environment: 100 }, down = [0, 0, -1];
  // Every band within 3 levels of the editor's (the tables lie half way between these and the slanted views of GAME_OFF).
  for (const [depth, editor] of STRAIGHT_DOWN) within(hdWaterPixel(GAME_BED, depth, deep("L"), down, off, undefined, 0, null, down), editor, 3, `${depth} deep, straight down`);
  // At the picture's side (28° off straight down) the same colour as in its middle: the camera's axis counts, not the view.
  const side = [Math.sin(0.49), 0, -Math.cos(0.49)];
  assert.deepEqual(hdWaterPixel(GAME_BED, 96, deep("L"), side, off, undefined, 0, null, down), hdWaterPixel(GAME_BED, 96, deep("L"), down, off, undefined, 0, null, down));
  // The control: by the path through the water (the view taken as the axis) the side would show far less of the bed
  // than the editor's 24 to 30 red.
  const byPath = hdWaterPixel(GAME_BED, 96, deep("L"), side, off, undefined, 0, null, side);
  assert.ok(byPath[0] < 20, `96 deep at the side by the path: ${byPath.map(Math.round)}`);
  // Through the angle of attack 304 in the same session (not fitted on): every band within 3, every box within 7.
  checkBands(GAME_OFF_SAME_SESSION, 1200, off, 3, 7);
  // The control: without the camera's tilt (HD_WATER_TILT) the slanted view shows too little of the bed there.
  const [y, depth, boxes] = GAME_OFF_SAME_SESSION[1], [px, py, editor] = boxes[4], cam = gameCam(y, depth), f = axis(cam), v = ray(cam, px, py);
  // (Lordaeron has one water colour and the reflection is off, so straight down through water as thick is the same.)
  const untilted = hdWaterPixel(GAME_BED, hdWaterPath(depth, v, f) / (1 - HD_WATER_TILT * (1 + f[2])), deep("L"), [0, 0, -1], off);
  assert.ok(editor[0] - untilted[0] > 4, `80 deep at 592, 370 without the tilt: ${untilted.map(Math.round)} against the editor's ${editor}`);
});

/**
 * Sunken Ruins in the editor's game view as GAME_OFF (make-water-tilesets.mjs … --reflectivity 0 Z; its dry ground
 * 100.5, 96, 38.6). The 160 band left out: its blue was 178 on the mean against the deep colour's 171 at 128 and 200
 * deep, in that picture alone (its boxes 168 to 186).
 */
const GAME_Z: GameBand[] = [
  [2624, 8, [[320, 130, [91, 95, 62]], [320, 370, [94, 95, 55]], [320, 610, [92, 94, 60]], [592, 130, [90, 95, 65]], [592, 370, [94, 96, 57]], [592, 610, [92, 94, 59]], [934, 130, [95, 95, 56]], [934, 370, [91, 95, 62]], [934, 610, [92, 94, 59]]]],
  [1600, 16, [[320, 130, [83, 94, 78]], [320, 370, [86, 94, 73]], [320, 610, [88, 95, 70]], [592, 130, [84, 95, 78]], [592, 370, [87, 94, 71]], [592, 610, [88, 95, 71]], [934, 130, [85, 94, 76]], [934, 370, [86, 95, 75]], [934, 610, [85, 93, 73]]]],
  [576, 24, [[320, 130, [77, 95, 87]], [320, 370, [81, 95, 81]], [320, 610, [80, 94, 82]], [592, 130, [76, 95, 90]], [592, 370, [80, 95, 82]], [592, 610, [82, 94, 80]], [934, 130, [75, 93, 89]], [934, 370, [81, 95, 82]], [934, 610, [82, 94, 79]]]],
  [-448, 40, [[320, 130, [58, 94, 110]], [320, 370, [67, 96, 103]], [320, 610, [69, 95, 99]], [592, 130, [59, 95, 111]], [592, 370, [66, 95, 104]], [592, 610, [68, 92, 97]], [934, 130, [56, 95, 114]], [934, 370, [71, 97, 102]], [934, 610, [68, 93, 98]]]],
  [-1472, 56, [[320, 130, [41, 99, 129]], [320, 370, [49, 96, 120]], [320, 610, [60, 98, 115]], [592, 130, [41, 99, 129]], [592, 370, [50, 97, 121]], [592, 610, [57, 95, 112]], [934, 130, [38, 98, 130]], [934, 370, [49, 97, 121]], [934, 610, [58, 97, 113]]]],
  [2624, 64, [[320, 130, [27, 97, 141]], [320, 370, [44, 93, 136]], [320, 610, [48, 92, 118]], [592, 130, [30, 96, 135]], [592, 370, [43, 94, 129]], [592, 610, [49, 93, 118]], [934, 130, [32, 96, 143]], [934, 370, [39, 94, 129]], [934, 610, [49, 92, 120]]]],
  [-2496, 72, [[320, 130, [21, 81, 146]], [320, 370, [30, 80, 134]], [320, 610, [41, 80, 127]], [592, 130, [19, 82, 146]], [592, 370, [31, 80, 130]], [592, 610, [39, 80, 120]], [934, 130, [17, 82, 147]], [934, 370, [33, 80, 137]], [934, 610, [37, 80, 117]]]],
  [1600, 96, [[320, 130, [1, 91, 173]], [320, 370, [2, 85, 152]], [320, 610, [18, 82, 155]], [592, 130, [1, 90, 182]], [592, 370, [3, 85, 152]], [592, 610, [13, 83, 136]], [934, 130, [1, 90, 172]], [934, 370, [3, 85, 163]], [934, 610, [12, 83, 142]]]],
  [576, 128, [[320, 130, [0, 91, 168]], [320, 310, [0, 91, 169]], [320, 550, [0, 91, 169]], [592, 130, [0, 91, 175]], [592, 310, [0, 91, 177]], [592, 550, [0, 91, 164]], [934, 130, [0, 91, 174]], [934, 310, [0, 91, 171]], [934, 550, [0, 91, 164]]]],
  [-1472, 200, [[320, 130, [1, 91, 168]], [320, 310, [1, 91, 178]], [320, 550, [1, 91, 170]], [592, 130, [0, 91, 162]], [592, 310, [1, 91, 183]], [592, 550, [1, 91, 168]], [934, 130, [1, 91, 170]], [934, 310, [1, 91, 180]], [934, 550, [1, 91, 168]]]],
];

test("Sunken Ruins' HD water is turquoise in the shallows and blue in the deep: its own shallow colour to 64 deep", () => {
  const off = { reflectivity: 0, environment: 100 }, bed = [100.5, 96, 38.6];
  // Band means within 4 levels; the deep blue varies by 24 from box to box (162 to 186 at 200 deep), the rest by 13.
  checkBands(GAME_Z, 1200, off, 4, 16, "Z", bed);
  // The control: with the deep colour alone the green is far short in the shallows (the open point this closed).
  const [y, depth, boxes] = GAME_Z[4], [px, py, editor] = boxes[4];
  const plain = hdWaterPixel(bed, depth, deep("Z"), ray(gameCam(y, depth), px, py), off, undefined, 0, null, axis(gameCam(y, depth)));
  assert.ok(editor[1] - plain[1] > 6, `one colour: ${plain.map(Math.round)} at 56 deep against the editor's ${editor}`);
  // The shallow colour to 60 deep, the deep colour from 72 (Water.slk's levels); the shader holds the same table.
  assert.equal(hdShallowAt(0), 1);
  assert.equal(hdShallowAt(56), 1);
  assert.ok(Math.abs(hdShallowAt(66) - 0.5) < 1e-9);
  assert.ok(hdShallowAt(72) === 0 && hdShallowAt(5000) === 0);
  assert.deepEqual(glslTables(/(float hdShallowAt\(float d\) \{[^}]*\})/), [[...HD_SHALLOW_SHARE]]);
  assert.deepEqual(glslTables(/const float HD_SHALLOW_DEPTHS\[\d+\] = (float\[\d+\]\([^)]*\))/), [[...HD_SHALLOW_DEPTHS]]);
  // A tileset without a shallow colour of its own keeps its deep colour at every depth, tinted too; Sunken Ruins' shallow
  // colour takes the tint as its deep colour does (HD_TINT_CAP).
  assert.deepEqual(hdWaterShallow("L", null), hdWaterColor("L", null));
  assert.deepEqual(hdWaterShallow("L", [64, 64, 255, 255]), hdWaterColor("L", [64, 64, 255, 255]));
  assert.deepEqual(hdWaterShallow("z", null).map((v) => Math.round(v * 255)), [...HD_SHALLOW.Z], "the tileset's letter in any case");
  assert.deepEqual(hdWaterShallow("Z", [255, 255, 255, 255]), hdWaterShallow("Z", null), "a white tint: as untinted");
  assert.ok(hdWaterShallow("Z", [64, 64, 64, 255])[2] < hdWaterShallow("Z", null)[2] / 2, "a dark tint darkens it");
  assert.deepEqual(hdWaterPixel([1, 125, 0], 38.4, deep("L"), [0, 0, -1], off, hdWaterShallow("L", null)), hdWaterPixel([1, 125, 0], 38.4, deep("L"), [0, 0, -1], off));
});

test("HD water reflects a sky that is brighter in the west: the editor's water lighter on the left of View Entire Map", () => {
  // [column, depth, bed (Water off), the editor's water]. The 96 deep bands left out: there the editor's View Entire
  // Map shows less of the bed than its game view (the test below).
  const bands: Record<string, [string, number, number[], number[]][]> = {
    L: [["west", 12, [1, 125, 0], [35, 119, 40]], ["west", 38.4, [1, 125, 0], [70, 113, 75]], ["west", 800, [1, 125, 0], [73, 87, 95]],
      ["mid", 12, [1, 125, 0], [25, 116, 34]], ["mid", 38.4, [1, 125, 0], [54, 105, 65]], ["mid", 800, [1, 125, 0], [61, 78, 89]],
      ["east", 12, [1, 125, 0], [15, 115, 28]], ["east", 38.4, [1, 125, 0], [39, 99, 56]], ["east", 800, [1, 123, 0], [46, 68, 82]]],
    B: [["west", 12, [121, 80, 37], [114, 81, 50]], ["west", 38.4, [121, 80, 37], [105, 89, 73]], ["west", 800, [121, 79, 37], [71, 78, 74]],
      ["mid", 12, [121, 80, 37], [111, 77, 45]], ["mid", 38.4, [121, 80, 37], [98, 80, 63]], ["mid", 800, [121, 79, 37], [59, 68, 66]],
      ["east", 12, [121, 79, 37], [109, 75, 42]], ["east", 38.4, [121, 79, 37], [91, 71, 54]], ["east", 800, [119, 78, 37], [50, 60, 59]]],
  };
  for (const [ts, rows] of Object.entries(bands)) for (const [col, d, bed, editor] of rows) {
    within(hdWaterPixel(bed, d, deep(ts), ray(ENTIRE, COLS[col], ROWS[d]), undefined, undefined, 0, null, axis(ENTIRE)), editor, 6, `${ts} ${col} ${d} deep`);
  }
  // The open point this closes: deep Lordaeron water 67 red in the west, 39 in the east; Studio's was a flat 22.
  const west = hdWaterPixel([1, 125, 0], 800, deep("L"), ray(ENTIRE, COLS.west, ROWS[800]));
  const east = hdWaterPixel([1, 125, 0], 800, deep("L"), ray(ENTIRE, COLS.east, ROWS[800]));
  assert.ok(west[0] - east[0] > 20, `west ${west.map(Math.round)} against east ${east.map(Math.round)}`);
});

/** GAME_OFF's maps with the w3i's default reflectivity 10 (no -r0), the same looks. */
const GAME_ON: GameBand[] = [
  [2624, 8, [[320, 130, [122, 87, 38]], [320, 370, [122, 88, 43]], [320, 610, [126, 91, 40]], [592, 130, [122, 87, 35]], [592, 370, [122, 87, 38]], [592, 610, [126, 89, 34]], [934, 130, [119, 85, 39]], [934, 370, [125, 88, 34]], [934, 610, [122, 86, 36]]]],
  [1600, 16, [[320, 130, [109, 81, 47]], [320, 370, [118, 88, 48]], [320, 610, [121, 92, 56]], [592, 130, [110, 81, 45]], [592, 370, [116, 85, 44]], [592, 610, [119, 88, 48]], [934, 130, [113, 83, 46]], [934, 370, [113, 83, 49]], [934, 610, [114, 83, 43]]]],
  [576, 24, [[320, 130, [102, 78, 52]], [320, 370, [108, 85, 59]], [320, 610, [115, 93, 68]], [592, 130, [101, 78, 52]], [592, 370, [106, 82, 54]], [592, 610, [111, 87, 58]], [934, 130, [99, 75, 49]], [934, 370, [108, 82, 55]], [934, 610, [106, 80, 49]]]],
  [-448, 40, [[320, 130, [80, 67, 56]], [320, 370, [100, 84, 65]], [320, 610, [100, 85, 70]], [592, 130, [81, 67, 53]], [592, 370, [93, 76, 58]], [592, 610, [95, 78, 60]], [934, 130, [81, 68, 60]], [934, 370, [92, 74, 57]], [934, 610, [94, 74, 53]]]],
  [-1472, 56, [[320, 130, [61, 60, 61]], [320, 370, [78, 72, 65]], [320, 610, [96, 88, 76]], [592, 130, [57, 56, 58]], [592, 370, [75, 69, 62]], [592, 610, [91, 82, 70]], [934, 130, [60, 59, 62]], [934, 370, [74, 67, 65]], [934, 610, [80, 68, 57]]]],
  [-2496, 72, [[320, 130, [42, 57, 67]], [320, 370, [62, 68, 70]], [320, 610, [73, 75, 74]], [592, 130, [37, 54, 67]], [592, 370, [59, 65, 67]], [592, 610, [62, 63, 64]], [934, 130, [43, 59, 71]], [934, 370, [53, 60, 64]], [934, 610, [61, 61, 60]]]],
  [1600, 96, [[320, 130, [28, 57, 75]], [320, 370, [36, 60, 75]], [320, 610, [66, 79, 84]], [592, 130, [31, 62, 76]], [592, 370, [30, 55, 71]], [592, 610, [36, 54, 69]], [934, 130, [20, 52, 72]], [934, 370, [31, 57, 71]], [934, 610, [34, 52, 68]]]],
  [576, 128, [[320, 130, [31, 60, 76]], [320, 310, [37, 64, 79]], [320, 550, [51, 74, 87]], [592, 130, [27, 58, 75]], [592, 310, [29, 59, 76]], [592, 550, [34, 63, 79]], [934, 130, [19, 51, 72]], [934, 310, [30, 57, 77]], [934, 550, [28, 56, 77]]]],
  [-448, 160, [[320, 130, [23, 53, 73]], [320, 310, [42, 68, 82]], [320, 550, [42, 67, 83]], [592, 130, [25, 55, 74]], [592, 310, [34, 65, 78]], [592, 550, [28, 55, 76]], [934, 130, [23, 53, 74]], [934, 310, [31, 62, 78]], [934, 550, [25, 56, 75]]]],
  [-1472, 200, [[320, 130, [25, 56, 74]], [320, 310, [36, 63, 79]], [320, 550, [63, 84, 92]], [592, 130, [23, 56, 73]], [592, 310, [31, 60, 77]], [592, 550, [36, 64, 80]], [934, 130, [28, 58, 76]], [934, 310, [33, 60, 79]], [934, 550, [25, 57, 75]]]],
];

test("HD water in the editor's game view with the reflection: the bed, the deep colour and the sky by the thickness, 8 to 200 deep", () => {
  // Band means within 3 levels (before the path, deep water was 9 to 14 too red from 56 to 128 deep: the open point's
  // "too much bed"); single boxes up to 16 off, deep water too: the sky's fit (HD_SKY) and the waves.
  checkBands(GAME_ON, 1200, undefined, 3, 17);
});

test("Outland's deep water reflects a dark red sky alike in every direction: the editor's 23, 13, 13", () => {
  // View Entire Map of the eight-band map over Outland (we-drive, HD, 2026-11-17): bands 96 to 800 deep in the editor
  // 23, 10, 11 / 22, 12, 14 / 23, 11, 12; Lordaeron's sky at that view gave 62, 63, 59 (Studio's picture).
  assert.equal(hdSkyFlat("L"), null);
  assert.deepEqual(hdSkyFlat("o"), HD_SKY_FLAT.O, "a lower case tileset letter too");
  // Its waves are a fifth as strong: the full wave light over so dark a sky cut a quarter of the pixels at black.
  const lean = (flat: FlatSky | null, l: number) => hdWaterPixel([0, 0, 0], 200, deep("O"), [0, 0.5, -0.85], undefined, undefined, l, flat).map(decode);
  const swing = (flat: FlatSky | null) => lean(flat, 0.1)[1] - lean(flat, 0)[1];
  assert.ok(Math.abs(swing(hdSkyFlat("O")) - HD_SKY_FLAT.O.waves * HD_WAVE_LIGHT[1] * 0.1) < 1e-9, "the waves' share of HD_WAVE_LIGHT");
  assert.ok(lean(hdSkyFlat("O"), -0.1)[1] > 0, "a wave's trough stays above black");
  const view = [0.3, 0.55, -0.78];
  const plain = hdWaterPixel([0, 0, 0], 800, deep("O"), view);
  assert.ok(plain.every((v) => v > 20), `control: Lordaeron's sky over Outland's black water is bright: ${plain.map(Math.round)}`);
  within(hdWaterPixel([0, 0, 0], 800, deep("O"), view, undefined, undefined, 0, hdSkyFlat("O")), [23, 11, 12], 2.5, "View Entire Map, 800 deep");
  // wt-O.w3x's 200 deep band through `--look 0,-2600,1500,304,70,R` (branch we-compare-13, 2026-11-19), boxes of the
  // editor's pictures: the middle (400, 300, 400 x 250), the left (0, 300, 300 x 250) and the right (884, 300, 300 x 250).
  // Red stays 22 to 25 in all; green and blue are the environment map's faces (straight-edged patches of 7 to 21).
  // The bed is left out here (Studio's picture showed some of Outland's red ground through that water, 29 red in the
  // middle box, where the editor's showed none: the next test, HD_DEPTH_EXTRA).
  const looks: [number, number[][]][] = [
    [0, [[23, 10, 9], [24, 8, 6], [25, 21, 20]]],
    [90, [[23, 13, 13], [23, 20, 21], [22, 10, 8]]],
    [180, [[23, 10, 11], [23, 16, 17], [24, 18, 18]]],
    [270, [[23, 10, 11], [24, 18, 18], [23, 10, 9]]],
  ];
  const reds: number[] = [];
  for (const [rotation, boxes] of looks) {
    // we-drive's studioCamera for that look (the target 0.0993 of the distance back, the ground 161.6 down).
    const r = (rotation * Math.PI) / 180;
    const cam = { target: [-149 * Math.cos(r), -2600 - 149 * Math.sin(r), -161.5], distance: 1369, yaw: ((rotation + 180) * Math.PI) / 180, pitch: 0.99833, fov: 0.71663 };
    boxes.forEach((editor, i) => {
      const x0 = [400, 0, 884][i], y0 = 300, w = i ? 300 : 400, flat = [0, 0, 0], lordaeron = [0, 0, 0];
      for (let a = 0; a < 5; a++) {
        for (let b = 0; b < 5; b++) {
          const v = ray(cam, x0 + (w / 5) * (a + 0.5), y0 + 50 * (b + 0.5));
          hdWaterPixel([0, 0, 0], 200, deep("O"), v, undefined, undefined, 0, hdSkyFlat("O")).forEach((c, k) => { flat[k] += c / 25; });
          hdWaterPixel([0, 0, 0], 200, deep("O"), v).forEach((c, k) => { lordaeron[k] += c / 25; });
        }
      }
      within(flat.slice(0, 1), editor.slice(0, 1), 3, `rotation ${rotation}, box ${i}, red`);
      within(flat, editor, 9, `rotation ${rotation}, box ${i}`);
      reds.push(lordaeron[0]);
    });
  }
  // Control: Lordaeron's sky (what a tint of it gave) changes with the direction where the editor's red doesn't.
  assert.ok(Math.max(...reds) > 1.6 * Math.min(...reds), `Lordaeron's sky's red ${reds.map(Math.round)}`);
  assert.deepEqual(hdWaterPixel([0, 0, 0], 800, deep("L"), view, undefined, undefined, 0, hdSkyFlat("L")), hdWaterPixel([0, 0, 0], 800, deep("L"), view), "the other tilesets are untouched");
});

test("Outland's water hides its red bed as water 28 deeper would (HD_DEPTH_EXTRA)", () => {
  // The editor's game view (we-drive, HD, branch we-remeasure-hd, 2026-11-20): wt-O-32-64-96-128-160-200-800-800.w3x,
  // whose 128, 160 and 200 bands are 25.6, 57.6 and 97.6 deep under Outland's surface; straight down
  // (`--look 0,Y,1200,270,70,90`, rows 300 to 544 and columns 300 to 884) and through 304 (`--look 0,Y,1200,304,70,90`,
  // rows 380 to 480 and columns 200 to 1000); the dry nv-O's 80.4, 21.7, 0 for the bed. Red only: green and blue are
  // the environment map's faces (lowprio-features), which HD_SKY_FLAT doesn't draw.
  const bed = [80.4, 21.7, 0], down = [0, 0, -1], a = (34 * Math.PI) / 180, slanted = [0, Math.sin(a), -Math.cos(a)];
  const cases: [number, number[], number][] = [
    [25.6, down, 51.7], [57.6, down, 34.0], [97.6, down, 22.3], [25.6, slanted, 46.9], [57.6, slanted, 28.3], [97.6, slanted, 23.7],
  ];
  const red = (depth: number, view: number[], extra: number) => hdWaterPixel(bed, depth, deep("O"), view, undefined, undefined, 0, hdSkyFlat("O"), view, extra)[0];
  for (const [depth, view, editor] of cases) {
    assert.ok(Math.abs(red(depth, view, hdDepthExtra("O")) - editor) <= 1.5, `${depth} deep along ${view.map((v) => v.toFixed(2))}: ${red(depth, view, hdDepthExtra("O")).toFixed(1)} against the editor's ${editor}`);
  }
  // The control: the plain depth shows far more of the red bed (Studio's 68, 51 red before at 25.6 and 57.6 straight down).
  assert.ok(red(25.6, down, 0) - 51.7 > 10 && red(57.6, down, 0) - 34.0 > 10, "without the extra the bed shows through");
  assert.equal(hdDepthExtra("o"), HD_DEPTH_EXTRA.O, "a lower case tileset letter too");
  assert.equal(hdDepthExtra("L"), 0, "the other tilesets: the depth itself");
  // Less towards the shore, none at it, in full from HD_DEPTH_EXTRA_FULL.
  assert.equal(hdTableDepth(0, 28), 0);
  assert.equal(hdTableDepth(-3, 28), -3);
  assert.equal(hdTableDepth(HD_DEPTH_EXTRA_FULL / 2, 28), HD_DEPTH_EXTRA_FULL / 2 + 14);
  assert.equal(hdTableDepth(40, 28), 68);
  assert.equal(hdTableDepth(40, 0), 40);
  // The shader does the same.
  assert.ok(HD_WATER_GLSL.includes(`d / ${HD_DEPTH_EXTRA_FULL.toFixed(1)}`), "the shader's hdTableDepth");
});

test("the reflection follows the view: the editor's opening camera turned to the four sides over 200 deep water", () => {
  // The 3 × 3 boxes (rows 300–450, 450–600, 600–750; columns 100–400, 442–742, 784–1084) of the editor's pictures.
  const looks: [number, number[][]][] = [
    [90, [[44, 68, 82], [35, 61, 77], [29, 58, 76], [52, 74, 86], [39, 66, 80], [28, 58, 76], [59, 80, 90], [41, 67, 81], [29, 59, 76]]],
    [180, [[82, 94, 100], [75, 90, 96], [65, 83, 92], [82, 94, 100], [77, 91, 97], [62, 81, 91], [80, 92, 99], [74, 89, 95], [62, 81, 91]]],
    [0, [[25, 56, 74], [31, 58, 75], [39, 64, 79], [27, 57, 75], [30, 59, 76], [40, 65, 80], [29, 59, 76], [35, 63, 78], [49, 71, 82]]],
  ];
  for (const [rotation, boxes] of looks) {
    // we-camera.mjs studioCamera for the look center,3000,304,70,rotation (the map's centre 0, 0; the ground 161.5 down).
    const r = (rotation * Math.PI) / 180;
    const cam = { target: [-298 * Math.cos(r), -298 * Math.sin(r), -161.5], distance: 2738, yaw: ((rotation + 180) * Math.PI) / 180, pitch: 0.99833, fov: 0.71663 };
    boxes.forEach((editor, i) => {
      // The box's mean over a 5 × 5 grid of its pixels.
      const x0 = [100, 442, 784][i % 3], y0 = [300, 450, 600][Math.floor(i / 3)], sum = [0, 0, 0];
      for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) hdWaterPixel([0, 0, 0], 200, deep("L"), ray(cam, x0 + 30 + 60 * a, y0 + 15 + 30 * b)).forEach((v, k) => { sum[k] += v / 25; });
      within(sum, editor, 6, `rotation ${rotation}, box ${i}`);
    });
  }
  // Looking west (towards the bright sky) is lighter than looking east.
  assert.ok(hdSky([-0.6, 0, 0.8])[0] > 2 * hdSky([0.6, 0, 0.8])[0]);
});

test("the w3i's reflectivity scales the reflection, its environment map reflectivity too (the editor's pictures)", () => {
  // Deep (800) and 38.4 deep water in the west column of View Entire Map, Lordaeron's bed 1, 125, 0.
  const cases: [number, number, number[], number[]][] = [
    [10, 100, [73, 87, 95], [70, 113, 75]], [20, 100, [102, 112, 115], [98, 129, 100]], [40, 100, [141, 148, 146], [136, 155, 134]], [10, 50, [50, 69, 82], [49, 101, 58]],
  ];
  for (const [reflectivity, environment, deepWater, shallow] of cases) {
    const s = { reflectivity, environment };
    within(hdWaterPixel([1, 125, 0], 800, deep("L"), ray(ENTIRE, COLS.west, ROWS[800]), s), deepWater, 7, `reflectivity ${reflectivity}, environment ${environment}, deep`);
    within(hdWaterPixel([1, 125, 0], 38.4, deep("L"), ray(ENTIRE, COLS.west, ROWS[38.4]), s, undefined, 0, null, axis(ENTIRE)), shallow, 7, `reflectivity ${reflectivity}, environment ${environment}, 38.4 deep`);
  }
});

test("HD water's waves add to the reflection and take from it alike: the mean colour stays, as strong as the editor's", () => {
  // The editor's opening camera over 200 deep Lordaeron water, the picture's middle (as the test above).
  const cam = { target: [0, -298, -161.5], distance: 2738, yaw: (270 * Math.PI) / 180, pitch: 0.99833, fov: 0.71663 };
  const view = ray(cam, 592, 422), black = [0, 0, 0];
  const pixel = (lean: number, settings = HD_WATER_DEFAULTS, depth = 200) => hdWaterPixel(black, depth, deep("L"), view, settings, deep("L"), lean);
  const flat = pixel(0);
  assert.deepEqual(flat, hdWaterPixel(black, 200, deep("L"), view), "no lean: the water without waves");
  // The lean's spread: two layers of the normal map's green, 0.079 each.
  const spread = 0.079 * Math.SQRT2, up = pixel(spread), down = pixel(-spread);
  flat.forEach((v, i) => assert.ok(Math.abs((decode(up[i]) + decode(down[i])) / 2 - decode(v)) < 1e-9, `channel ${i}: a wave and its opposite cancel in linear light`));
  // The editor's contrast there: 2.6 to 4.6 levels of green (standard deviation), 0.003 to 0.008 in linear light.
  const levels = (up[1] - down[1]) / 2, linear = (decode(up[1]) - decode(down[1])) / 2;
  assert.ok(levels > 2.6 && levels < 4.6, `${levels} levels of green`);
  assert.ok(linear > 0.005 && linear < 0.007, `${linear} in linear light`);
  assert.ok(Math.abs((decode(up[0]) - decode(down[0])) / (decode(up[1]) - decode(down[1])) - 0.75) < 0.02, "red three quarters of green");
  // The w3i's wave strength scales them (0: flat water), and they are the reflection's: none without it, few in the shallows.
  assert.deepEqual(pixel(spread, { ...HD_WATER_DEFAULTS, waves: 0 }), flat);
  assert.ok(Math.abs(decode(pixel(spread, { ...HD_WATER_DEFAULTS, waves: 50 })[1]) - (decode(up[1]) + decode(flat[1])) / 2) < 1e-9, "strength 50: half");
  assert.deepEqual(hdWaveLight({ waves: 100 }), [...HD_WAVE_LIGHT]);
  assert.deepEqual(hdWaveLight({ waves: 0 }), [0, 0, 0]);
  const still = { ...HD_WATER_DEFAULTS, reflectivity: 0 };
  assert.deepEqual(pixel(spread, still), pixel(0, still), "reflectivity 0: no waves either");
  const shallowUp = pixel(spread, HD_WATER_DEFAULTS, 4), shallowFlat = pixel(0, HD_WATER_DEFAULTS, 4);
  const shallowWave = decode(shallowUp[1]) - decode(shallowFlat[1]), deepWave = decode(up[1]) - decode(flat[1]);
  assert.ok(shallowWave > 0 && shallowWave < 0.1 * deepWave + 1e-9, `4 deep: a tenth of deep water's at most, and some (${shallowWave} against ${deepWave})`);
});

test("a wave's lean: the normal map's green alone seen straight down, its red too the more level the view", () => {
  assert.equal(hdWaveLean(0.3, 0.1, [0, 0, -1]), 0.1);
  assert.equal(hdWaveLean(0.3, 0.1, [0, 0, -500]), 0.1, "any length");
  // Through the opening camera's middle (0.56 level): 1.5 times the red beside the green, scaled to keep the spread.
  const share = HD_WAVE_RED * 0.56, norm = Math.sqrt(1 + (share * 0.67) ** 2);
  const view = [0, 0.56, -Math.sqrt(1 - 0.56 ** 2)];
  assert.ok(Math.abs(share - 1.5) < 0.02);
  assert.ok(Math.abs(hdWaveLean(0.2, 0.1, view) - (0.1 + share * 0.2) / norm) < 1e-9);
  // Red and green spread 0.67 to 1 and don't go together: the mix's spread is the green's.
  const mixSpread = Math.hypot(1 / norm, (share * 0.67) / norm);
  assert.ok(Math.abs(mixSpread - 1) < 1e-9);
  // The shader holds the same numbers: read the red's factor and the spread's square out of the lean function.
  const lean = /float hdWaveLean\([^)]*\) \{([^}]*)\}/.exec(HD_WATER_GLSL)?.[1] ?? "";
  assert.equal(Number(/float share = ([\d.]+) \* length\(view\.xy\)/.exec(lean)?.[1]), HD_WAVE_RED);
  assert.ok(Math.abs(Number(/share \* share \* ([\d.e-]+)\)/.exec(lean)?.[1]) - 0.67 ** 2) < 1e-12, lean);
});

test("the waves' two layers drift against each other, north-east and south-west, and come round again", () => {
  const [a, b] = HD_WAVES;
  assert.deepEqual([a.size, b.size], [1024, 1024]);
  assert.deepEqual(a.drift.map((v) => -v), [...b.drift], "against each other");
  assert.deepEqual(hdWaveShift(0), [0, 0, 0.25, 0.25]);
  const near = (x: number[], y: number[], what: string) => assert.ok(x.every((v, i) => Math.abs(v - y[i]) < 1e-6 || Math.abs(Math.abs(v - y[i]) - 1) < 1e-6), `${what}: ${x} against ${y}`);
  // After a second the first layer's pattern lies 45 units further east and north: the texture is read 45 / 1024 of a
  // repeat back in x, and forward in y (which counts southwards).
  const step = 45 / 1024;
  near(hdWaveShift(1), [1 - step, step, 0.25 + step, 0.25 - step], "one second");
  hdWaveShift(7.3).forEach((v) => assert.ok(v >= 0 && v < 1));
  // A repeat takes 1024 / 45 seconds; a month of running time lands where its remainder does.
  const period = 1024 / 45;
  near(hdWaveShift(3 + period), hdWaveShift(3), "one repeat on");
  near(hdWaveShift(3 + 114000 * period), hdWaveShift(3), "a month on");
});

test("each tileset has its own deep HD colour, Northrend's for one not measured", () => {
  const rgb = (ts: string) => hdWaterColor(ts, null).map((v) => Math.round(v * 255));
  assert.deepEqual(rgb("L"), [0, 48, 69]);
  assert.deepEqual(rgb("y"), [36, 48, 126], "the tileset's letter in any case");
  assert.deepEqual(rgb("C"), [0, 0, 0], "Felwood's is black");
  assert.deepEqual(rgb("?"), [...HD_DEEP.N]);
  assert.equal(Object.keys(HD_DEEP).length, 18, "the eighteen tilesets of the editor's list");
});

test("a map's water tint caps HD water's own colour per channel: the editor's deep Lordaeron water under nine tints", () => {
  // we-drive, HD, game view (branch we-remeasure-hd, 2026-11-20): make-water-tilesets.mjs --depths 32,64,96,128,160,200,
  // 800,800 --tint R,G,B --reflectivity 0 L, the 200 deep band through `--look 0,-1472,1200,304,70,90` (rows 380 to 480,
  // columns 200 to 1000), where the deep colour is all there is: [tint red, green, blue], the editor's colour.
  const editor: [number[], number[]][] = [
    [[255, 255, 255], [0, 47.7, 69]], [[224, 224, 224], [0, 48.7, 59]], [[192, 192, 192], [0, 47.3, 50]], [[160, 160, 160], [0, 47.2, 41]],
    [[128, 128, 128], [0, 48.1, 31]], [[96, 96, 96], [0, 41, 22]], [[255, 64, 64], [0, 25, 12]], [[64, 255, 64], [0, 48.2, 12]],
    [[64, 64, 255], [0, 25, 69]], [[255, 128, 64], [0, 48.7, 12]],
  ];
  // The tint is stored blue, green, red, alpha.
  const stored = ([r, g, b]: number[]) => [b, g, r, 255];
  for (const [tint, want] of editor) within(hdWaterColor("L", stored(tint)).map((v) => v * 255), want, 2.2, `tint ${tint}`);
  // Sunken Ruins and Northrend the same way: grey tints 255, 128 and 64.
  const others: [string, number, number[]][] = [
    ["Z", 255, [0.9, 91, 175.3]], ["Z", 128, [0.9, 43, 106]], ["Z", 64, [0.9, 18, 52]],
    ["N", 255, [0, 36.2, 21.2]], ["N", 128, [0, 39.2, 21.4]], ["N", 64, [0, 22, 14]],
  ];
  for (const [ts, v, want] of others) within(hdWaterColor(ts, stored([v, v, v])).map((c) => c * 255), want, 4.5, `${ts} tint ${v}`);
  for (const ts of ["L", "Z", "N", "B", "Y"]) assert.deepEqual(hdWaterColor(ts, stored([255, 255, 255])), hdWaterColor(ts, null), `${ts}: a white tint is the water untinted`);
  // The control: Lordaeron's bound on Sunken Ruins would take its blue far down under a white tint.
  assert.ok(Math.abs(encode(Math.min(decode(171), HD_TINT_CAP.L[2])) - 171) > 90);
  // A tileset not measured: its deep colour times the tint squared (in linear light).
  within(hdWaterColor("Y", stored([128, 128, 128])).map((c) => c * 255), [...HD_DEEP.Y].map((c) => encode(decode(c) * (128 / 255) ** 2)), 0.01, "Cityscape");
  // The control: the colour taken before for every tint (0, 40, 37) is 25 off in blue under the 255, 64, 64 tint and
  // 32 under a white one.
  assert.ok(Math.abs(37 - 12) > 20 && Math.abs(37 - 69) > 20);
  assert.ok(hdWaterColor("L", stored([255, 64, 64]))[2] * 255 < 14, "the 255, 64, 64 tint's blue");
  // A stored value past 255 or not a number counts as 255 (no tint in that channel).
  assert.deepEqual(hdWaterColor("L", [300, Number.NaN, 255, 255]), hdWaterColor("L", null));
});
