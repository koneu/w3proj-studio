import assert from "node:assert/strict";
import { test } from "node:test";
import { facing, GAME_LIGHT_FILL, hdLight, hdTone, shadeWrap, SUN_SHADE, sunAmbient, sunFacing, sunLight, toneOf } from "./tone";
import type { SceneLight } from "./dnclight";

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} not within ${tol} of ${b}`);

test("the graphics mode picks the picture's tone: classic for SD, HD for the rest", () => {
  assert.equal(toneOf("sd"), 1);
  assert.equal(toneOf("hd"), 2);
  assert.equal(toneOf("de"), 2);
  assert.equal(toneOf(undefined), 2, "the app's default mode is HD");
});

/** The factor a light gives flat ground (normal straight up) after hdLight and shadeWrap, relative to the
 *  editor's light without a lighting model (exposure only): the k of the tone curve's fit over the exposure. */
function flatFactor(l: SceneLight): number {
  return surfaceFactor(l, [0, 0, 1]);
}
/** The same for a surface of normal `n`. */
function surfaceFactor(l: SceneLight, n: number[]): number {
  const h = hdLight(l);
  return h.ambient[1] + h.diffuse[1] * facing(n, h.dir, shadeWrap(2, h));
}
const sun = (intensity: number, dir: [number, number, number], ambient = 0, shadow = 0): SceneLight =>
  ({ dir, diffuse: [intensity, intensity, intensity], ambient: [ambient, ambient, ambient], shadow });
const UP: [number, number, number] = [0, 0, 1];
const SOUTH_WEST: [number, number, number] = [-0.675, -0.406, 0.616];

test("HD: lighting models' light as the World Editor's pictures measured it (k / 0.70, we-drive 2026-11-08)", () => {
  // Measured: the tone curve fitted to each picture gave k; 0.70 is the editor's own light.
  near(flatFactor(sun(1, UP)), 0.701 / 0.7, 0.03, "sun 1 straight down");
  near(flatFactor(sun(0.5, UP)), 0.56 / 0.7, 0.07, "sun 0.5");
  near(flatFactor(sun(2, UP)), 1.0 / 0.7, 0.12, "sun 2");
  near(flatFactor(sun(1, SOUTH_WEST)), 0.419 / 0.7, 0.05, "sun 1 from the south-west, 52° from straight up");
  near(flatFactor(sun(0, UP, 1)), 0.869 / 0.7, 0.05, "ambient 1 alone");
  near(flatFactor(sun(0, UP, 0.5)), 0.577 / 0.7, 0.06, "ambient 0.5 alone");
  // Map 03 (Lordaeron's HD model at 06:00): its light in RGB and its sun; the HD models' ambient is -0.03.
  near(flatFactor({ dir: [-0.392, -0.169, 0.904], diffuse: [1.026, 1.026, 1.199], ambient: [-0.03, -0.03, -0.03], shadow: 0.265 }), 0.625 / 0.7, 0.05, "map 03's game light");
});

test("HD: a shadow intensity above 0 lifts the shading toward the full sun (cliff.w3m's own lighting)", () => {
  // Sun 1.95 from the south-west with shadow intensity 5.85 gave k 2.47; the same sun with 0 gives about 0.55.
  const withShadow = flatFactor(sun(1.95, SOUTH_WEST, 0, 5.85)), without = flatFactor(sun(1.95, SOUTH_WEST));
  near(without, 0.563 / 0.7, 0.1, "without");
  assert.ok(withShadow > 3 * without, `with shadow intensity 5.85: ${withShadow} against ${without}`);
  near(withShadow, 2.47 / 0.7, 0.6, "with");
  // Straight down it changes nothing (measured: 0.715 with 5.85 against 0.701 with 0).
  near(flatFactor(sun(1, UP, 0, 5.85)), flatFactor(sun(1, UP)), 1e-9, "straight down");
});

test("HD: the shadow intensity lifts cliff walls as much as flat ground, and ambient beside a sun adds as it reads", () => {
  // cliff.w3m's unit lighting at 06:00 (sun 1.94 from the south-west, ambient 0.168, 0.168, 0.196) with one value
  // changed at a time; its south walls (normal straight south) and grass, light factor from the pictures (we-drive).
  const cliff = (shadow: number, ambient = 0.2): SceneLight =>
    ({ dir: SOUTH_WEST, diffuse: [1.942, 1.942, 1.942], ambient: [0.84 * ambient, 0.84 * ambient, 0.98 * ambient], shadow });
  const SOUTH = [0, -1, 0];
  for (const [shadow, wall, grass] of [[0, 0.708, 0.917], [1, 1.22, 1.446], [2, 1.672, 2.128], [3, 2.14, NaN], [5.85, 3.81, NaN]]) {
    near(surfaceFactor(cliff(shadow), SOUTH), wall, 0.15, `wall, shadow intensity ${shadow}`);
    if (!Number.isNaN(grass)) near(surfaceFactor(cliff(shadow), [0, 0, 1]), grass, 0.15, `grass, shadow intensity ${shadow}`);
  }
  // The lift per unit of shadow intensity is the same on both (a lift by the wall's own cosine was half again more).
  const perUnit = (n: number[]) => surfaceFactor(cliff(1), n) - surfaceFactor(cliff(0), n);
  near(perUnit(SOUTH), perUnit([0, 0, 1]), 1e-9, "walls and ground");
  near(surfaceFactor(cliff(5.85, 0), SOUTH), 3.63, 0.2, "wall, ambient 0");
  near(surfaceFactor(cliff(0, 0), [0, 0, 1]), 0.779, 0.06, "grass, ambient 0, shadow 0");
});

test("HD: the picture's curve is ACES up to the middle, and white sooner near the top (the editor's shoulder)", () => {
  const aces = (x: number) => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  for (const x of [0, 0.02, 0.1, 0.2, 0.3]) near(hdTone(x), aces(x), 0.01, `x ${x}`);
  near(hdTone(0.45), 0.649, 0.005, "lifted from ACES's 0.581");
  near(hdTone(0.6), 0.917, 0.005, "lifted from 0.673");
  assert.equal(hdTone(0.7), 1, "white where ACES is still at 0.71");
  assert.equal(hdTone(50), 1);
  assert.equal(hdTone(-1), 0);
  for (let x = 0; x < 2; x += 0.01) assert.ok(hdTone(x + 0.01) >= hdTone(x), `rising at ${x}`);
});

test("HD's real shadows: lit, the shading is facing()'s; between, it goes over smoothly", () => {
  const l = sun(1.95, SOUTH_WEST, 0.2, 5.85);
  for (const n of [[0, 0, 1], [0, -1, 0], [0.3, 0.2, 0.9], [-1, 0, 0]]) {
    near(sunFacing(n, l.dir, 5.85, 1), facing(n, l.dir, 5.85), 1e-12, `normal ${n}`);
    const half = sunFacing(n, l.dir, 5.85, 0.5), none = sunFacing(n, l.dir, 5.85, 0), full = sunFacing(n, l.dir, 5.85, 1);
    near(half, (none + full) / 2, 1e-12, `half lit, normal ${n}`);
  }
  assert.equal(sunAmbient(1), 1);
  assert.equal(sunAmbient(0), SUN_SHADE.ambient);
  assert.equal(sunAmbient(7), 1, "clamped");
});

test("HD's real shadows: the light in a shadow as the World Editor's pictures measured it (we-drive 2026-11-09)", () => {
  // A test map on cliff.w3m's flat ground under its lighting at 06:00 (sun from the south-west, 52° from straight up,
  // ambient colour 0.84 in green) with the sun's intensity, the ambient's and the shadow intensity changed one at a
  // time: the light in a footman's and a gryphon's shadow over the editor's own light (green, tone curve inverted).
  const inShadow = (intensity: number, ambient: number, shadow: number) => {
    const h = hdLight(sun(intensity, SOUTH_WEST, 0.84 * ambient, shadow));
    return h.ambient[1] * sunAmbient(0) + h.diffuse[1] * sunFacing([0, 0, 1], h.dir, shadeWrap(2, h), 0);
  };
  const lit = (intensity: number, ambient: number, shadow: number) => flatFactor(sun(intensity, SOUTH_WEST, 0.84 * ambient, shadow));
  for (const [i, a, s, measured, tol] of [
    [1.95, 0.2, 0, 0.314, 0.04], [1, 0.2, 0, 0.314, 0.04], [1.95, 0, 0, 0, 0.03],
    [1.95, 0.2, 2, 2.675, 0.35], [1, 0.2, 2, 1.889, 0.3], [1.95, 0, 2, 2.593, 0.4],
  ]) near(inShadow(i, a, s), measured, tol, `sun ${i}, ambient ${a}, shadow intensity ${s}`);
  // Darker than the lit ground without shadow intensity, about as light at 1 (the editor's shadows all but vanish),
  // lighter above: cliff.w3m's 5.85 gives yellow shadows on orange sand (1.64 times the lit ground's light, in blue).
  assert.ok(inShadow(1.95, 0.2, 0) < 0.4 * lit(1.95, 0.2, 0));
  near(inShadow(1.95, 0.2, 1) / lit(1.95, 0.2, 1), 1, 0.15, "shadow intensity 1");
  near(inShadow(1.95, 0.2, 5.85) / lit(1.95, 0.2, 5.85), 1.64, 0.15, "shadow intensity 5.85");
});

test("HD's real shadows under the game's own lighting keep about half the light (map 03's footmen, we-drive)", () => {
  // Lordaeron's HD terrain model at 06:00 (no ambient, shadow intensity 0.265): 0.51 of the lit ground's light in green.
  const l = hdLight({ dir: [-0.392, -0.169, 0.904], diffuse: [1.026, 1.026, 1.199], ambient: [-0.03, -0.03, -0.03], shadow: 0.265, fill: GAME_LIGHT_FILL });
  const at = (lit: number) => sunLight(l.ambient[1], l.diffuse[1], [0, 0, 1], l.dir, shadeWrap(2, l), l.fill ?? 0, lit);
  near(at(0) / at(1), 0.51, 0.04, "with the game's fill");
  near(at(1), facing([0, 0, 1], l.dir, shadeWrap(2, l)) * l.diffuse[1], 1e-12, "lit: the fill changes nothing");
  // A map's own lighting model has none: the same light without it is nearly black in shadow.
  assert.ok(sunLight(l.ambient[1], l.diffuse[1], [0, 0, 1], l.dir, shadeWrap(2, l), 0, 0) / at(1) < 0.1);
  assert.equal(hdLight({ dir: [0, 0, 1], diffuse: [1, 1, 1], ambient: [0, 0, 0] }).fill, undefined);
});

test("the classic picture (and the model viewer) shade by the cosine alone", () => {
  const l = sun(1, SOUTH_WEST, 0, 5.85);
  assert.equal(shadeWrap(1, l), 0);
  assert.equal(shadeWrap(0, l), 0);
  assert.equal(shadeWrap(undefined, l), 0);
  assert.equal(shadeWrap(2, l), 5.85);
  assert.equal(shadeWrap(2, sun(1, UP)), 0);
  assert.equal(shadeWrap(2, { dir: UP, diffuse: [1, 1, 1], ambient: [0, 0, 0] }), 0, "a light without the field");
});
