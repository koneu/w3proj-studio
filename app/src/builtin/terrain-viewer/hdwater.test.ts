import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decode, HD_REFLECT_DEPTH, HD_SHALLOW_SHARE, HD_WATER_DEFAULTS, HD_WATER_DEPTHS, HD_WATER_GLSL, HD_WATER_OWN, HD_WATER_THROUGH, HD_WAVE_LIGHT, HD_WAVE_RED, HD_WAVES,
  hdReflectScale, hdShallowAt, hdSky, hdWaterAt, hdWaterPixel, hdWaterSettings, hdWaveLean, hdWaveLight, hdWaveShift,
} from "./hdwater";
import { HD_DEEP, HD_SHALLOW, hdWaterColor, hdWaterShallow } from "./renderer";

// The World Editor's HD pictures these come from (we-drive, branch water-render-we, 2026-11-14; TESTING.md "HD water"):
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
/** View Entire Map of the 128 × 96 maps (Studio's, at the editor's field of view, which the pictures line up with). */
const ENTIRE = { target: [704, -2867.5, -161.5], distance: 17168, yaw: -Math.PI / 2, pitch: 1.5688, fov: 0.7166 };
/** The bands' rows and the columns' pixels in the editor's pictures. */
const ROWS: Record<string, number> = { 12: 57, 38.4: 217, 96: 377, 800: 520 };
const COLS: Record<string, number> = { west: 240, mid: 600, east: 955 };

const within = (got: readonly number[], want: readonly number[], tol: number, what: string) =>
  assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= tol), `${what}: ${got.map(Math.round)} against the editor's ${want} (±${tol})`);
const deep = (ts: string) => hdWaterColor(ts, false);

test("HD water's tables: none of the water at 0, all of it from 200 deep, linear between the measured depths", () => {
  assert.deepEqual(hdWaterAt(0), { through: 1, own: 0, reflect: 0 });
  assert.deepEqual(hdWaterAt(-5), { through: 1, own: 0, reflect: 0 }, "above the surface: the bed alone");
  assert.deepEqual(hdWaterAt(200), { through: 0, own: 1, reflect: 1 });
  assert.deepEqual(hdWaterAt(5000), { through: 0, own: 1, reflect: 1 });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  HD_WATER_DEPTHS.forEach((d, i) => {
    const w = hdWaterAt(d);
    assert.ok(near(w.through, HD_WATER_THROUGH[i]) && near(w.own, HD_WATER_OWN[i]) && near(w.reflect, HD_REFLECT_DEPTH[i]), `at ${d}: ${JSON.stringify(w)}`);
  });
  const half = hdWaterAt(18);
  assert.ok(Math.abs(half.through - (HD_WATER_THROUGH[2] + HD_WATER_THROUGH[3]) / 2) < 1e-9, "18 is halfway between 12 and 24");
  // The shader holds the same tables.
  for (const t of [HD_WATER_DEPTHS, HD_WATER_THROUGH, HD_WATER_OWN, HD_REFLECT_DEPTH]) assert.ok(HD_WATER_GLSL.includes(t.map((v) => (Number.isInteger(v) ? v.toFixed(1) : String(v))).join(", ")), `the GLSL has ${t}`);
});

test("the w3i's water settings: its reflectivity and environment map reflectivity, a new map's 10 and 100 otherwise", () => {
  assert.deepEqual(hdWaterSettings({ reflectivity: 20, environmentMapReflectivity: 50, maxOpacity: 100 }), { reflectivity: 20, environment: 50, waves: 100 });
  assert.deepEqual(hdWaterSettings({ wavesNormalMapStrength: 40 }), { ...HD_WATER_DEFAULTS, waves: 40 }, "the waves' strength");
  assert.deepEqual(hdWaterSettings(undefined), HD_WATER_DEFAULTS, "an older w3i without the block");
  assert.deepEqual(hdWaterSettings({ reflectivity: "x", environmentMapReflectivity: Number.NaN, wavesNormalMapStrength: null }), HD_WATER_DEFAULTS, "not numbers");
  assert.deepEqual(hdWaterSettings({ reflectivity: -3, environmentMapReflectivity: 100, wavesNormalMapStrength: -1 }), { reflectivity: 0, environment: 100, waves: 0 }, "negative: none");
  assert.deepEqual(hdReflectScale(HD_WATER_DEFAULTS), [1, 0.113]);
  assert.deepEqual(hdReflectScale({ reflectivity: 0, environment: 100 }), [0, 0], "reflectivity 0: no reflection, nothing dimmed");
});

test("without the reflection (w3i reflectivity 0) HD water is the bed and the tileset's deep colour by depth, as the editor's", () => {
  // [depth, bed, the editor's water] in the middle column; Ashenvale's water lies 12.8 higher (Water.slk's height).
  const bands: Record<string, [number, number[], number[]][]> = {
    L: [[4, [1, 125, 0], [1, 121, 5]], [12, [1, 125, 0], [1, 115, 15]], [24, [1, 125, 0], [1, 105, 24]], [38.4, [1, 125, 0], [0, 93, 33]], [64, [1, 125, 0], [1, 72, 44]], [96, [1, 125, 0], [0, 50, 57]]],
    A: [[16.8, [0, 50, 25], [0, 45, 31]], [24.8, [0, 50, 25], [0, 43, 34]], [36.8, [0, 50, 25], [0, 40, 39]], [51.2, [0, 50, 25], [0, 37, 44]], [76.8, [0, 50, 25], [1, 33, 52]], [108.8, [0, 50, 25], [0, 35, 64]]],
    B: [[4, [121, 79, 37], [116, 76, 36]], [12, [121, 80, 37], [110, 72, 34]], [24, [121, 79, 37], [99, 66, 32]], [38.4, [121, 80, 37], [86, 58, 29]], [64, [121, 79, 37], [62, 44, 24]], [96, [121, 79, 37], [26, 31, 23]]],
    N: [[4, [74, 132, 148], [71, 128, 143]], [12, [74, 132, 148], [66, 120, 134]], [24, [74, 132, 148], [60, 110, 122]], [38.4, [73, 132, 148], [51, 97, 106]], [64, [74, 131, 147], [35, 73, 78]], [96, [74, 132, 148], [11, 45, 39]]],
  };
  const off = { reflectivity: 0, environment: 100 };
  for (const [ts, rows] of Object.entries(bands)) for (const [d, bed, editor] of rows) {
    within(hdWaterPixel(bed, d, deep(ts), [0, 0, -1], off), editor, 3, `${ts} ${d} deep`);
  }
  // And deep: the tileset's colour itself.
  within(hdWaterPixel([255, 255, 255], 800, deep("B"), [0, 0, -1], off), [6, 31, 27], 0.5, "Barrens 800 deep");
});

test("Sunken Ruins' HD water is turquoise in the shallows and blue in the deep: its own shallow colour by depth", () => {
  // The editor's bands with the reflection off (wdZr0, View Entire Map, the middle column): [depth, bed, water].
  const bands: [number, number[], number[]][] = [
    [12, [137, 133, 74], [124, 127, 86]], [24, [137, 133, 74], [113, 122, 96]], [38.4, [137, 133, 74], [98, 117, 107]],
    [64, [137, 132, 74], [71, 106, 125]], [96, [137, 133, 74], [29, 87, 147]], [200, [137, 133, 74], [0, 91, 170]],
  ];
  const off = { reflectivity: 0, environment: 100 };
  const shallow = hdWaterShallow("Z", false);
  for (const [d, bed, editor] of bands) within(hdWaterPixel(bed, d, deep("Z"), [0, 0, -1], off, shallow), editor, 3, `Z ${d} deep`);
  // The control: with the deep colour alone the green is far short in the middle depths (the open point this closes).
  const plain = hdWaterPixel([137, 132, 74], 64, deep("Z"), [0, 0, -1], off);
  assert.ok(106 - plain[1] > 12, `one colour: ${plain.map(Math.round)} at 64 deep against the editor's 71, 106, 125`);
  // Deep water has none of the shallow colour, the surface all of it; the shader holds the same table.
  assert.ok(Math.abs(hdShallowAt(200)) < 1e-9 && hdShallowAt(5000) === 0);
  assert.equal(hdShallowAt(0), 1);
  assert.ok(Math.abs(hdShallowAt(38.4) - HD_SHALLOW_SHARE[4]) < 1e-9);
  assert.ok(HD_WATER_GLSL.includes(HD_SHALLOW_SHARE.map((v) => (Number.isInteger(v) ? v.toFixed(1) : String(v))).join(", ")));
  // A tileset without a shallow colour of its own keeps its deep colour at every depth, and so does a tinted map.
  assert.deepEqual(hdWaterShallow("L", false), hdWaterColor("L", false));
  assert.deepEqual(hdWaterShallow("z", false).map((v) => Math.round(v * 255)), [...HD_SHALLOW.Z], "the tileset's letter in any case");
  assert.deepEqual(hdWaterShallow("Z", true), hdWaterColor("Z", true));
  assert.deepEqual(hdWaterPixel([1, 125, 0], 38.4, deep("L"), [0, 0, -1], off, hdWaterShallow("L", false)), hdWaterPixel([1, 125, 0], 38.4, deep("L"), [0, 0, -1], off));
});

test("HD water reflects a sky that is brighter in the west: the editor's water lighter on the left of View Entire Map", () => {
  // [column, depth, bed (Water off), the editor's water].
  const bands: Record<string, [string, number, number[], number[]][]> = {
    L: [["west", 12, [1, 125, 0], [35, 119, 40]], ["west", 38.4, [1, 125, 0], [70, 113, 75]], ["west", 96, [1, 125, 0], [70, 86, 87]], ["west", 800, [1, 125, 0], [73, 87, 95]],
      ["mid", 12, [1, 125, 0], [25, 116, 34]], ["mid", 38.4, [1, 125, 0], [54, 105, 65]], ["mid", 96, [1, 125, 0], [57, 77, 79]], ["mid", 800, [1, 125, 0], [61, 78, 89]],
      ["east", 12, [1, 125, 0], [15, 115, 28]], ["east", 38.4, [1, 125, 0], [39, 99, 56]], ["east", 96, [1, 125, 0], [44, 69, 73]], ["east", 800, [1, 123, 0], [46, 68, 82]]],
    B: [["west", 12, [121, 80, 37], [114, 81, 50]], ["west", 38.4, [121, 80, 37], [105, 89, 73]], ["west", 96, [121, 79, 37], [71, 75, 70]], ["west", 800, [121, 79, 37], [71, 78, 74]],
      ["mid", 12, [121, 80, 37], [111, 77, 45]], ["mid", 38.4, [121, 80, 37], [98, 80, 63]], ["mid", 96, [121, 79, 37], [62, 66, 62]], ["mid", 800, [121, 79, 37], [59, 68, 66]],
      ["east", 12, [121, 79, 37], [109, 75, 42]], ["east", 38.4, [121, 79, 37], [91, 71, 54]], ["east", 96, [121, 80, 37], [52, 57, 54]], ["east", 800, [119, 78, 37], [50, 60, 59]]],
  };
  for (const [ts, rows] of Object.entries(bands)) for (const [col, d, bed, editor] of rows) {
    within(hdWaterPixel(bed, d, deep(ts), ray(ENTIRE, COLS[col], ROWS[d])), editor, 6, `${ts} ${col} ${d} deep`);
  }
  // The open point this closes: deep Lordaeron water 67 red in the west, 39 in the east; Studio's was a flat 22.
  const west = hdWaterPixel([1, 125, 0], 800, deep("L"), ray(ENTIRE, COLS.west, ROWS[800]));
  const east = hdWaterPixel([1, 125, 0], 800, deep("L"), ray(ENTIRE, COLS.east, ROWS[800]));
  assert.ok(west[0] - east[0] > 20, `west ${west.map(Math.round)} against east ${east.map(Math.round)}`);
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
    within(hdWaterPixel([1, 125, 0], 38.4, deep("L"), ray(ENTIRE, COLS.west, ROWS[38.4]), s), shallow, 7, `reflectivity ${reflectivity}, environment ${environment}, 38.4 deep`);
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
  assert.ok(decode(shallowUp[1]) - decode(shallowFlat[1]) < 0.1 * (decode(up[1]) - decode(flat[1])) + 1e-9, "4 deep: a tenth of deep water's");
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
  // The shader holds the same numbers.
  assert.ok(HD_WATER_GLSL.includes(`float share = ${HD_WAVE_RED} * length(view.xy);`));
  assert.ok(HD_WATER_GLSL.includes(String(0.67 ** 2)));
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
  const rgb = (ts: string) => hdWaterColor(ts, false).map((v) => Math.round(v * 255));
  assert.deepEqual(rgb("L"), [0, 48, 69]);
  assert.deepEqual(rgb("y"), [36, 48, 126], "the tileset's letter in any case");
  assert.deepEqual(rgb("C"), [0, 0, 0], "Felwood's is black");
  assert.deepEqual(rgb("?"), [...HD_DEEP.N]);
  assert.equal(Object.keys(HD_DEEP).length, 18, "the eighteen tilesets of the editor's list");
});
