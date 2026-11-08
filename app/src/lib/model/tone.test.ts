import assert from "node:assert/strict";
import { test } from "node:test";
import { hdLight, shadeWrap, toneOf } from "./tone";
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
  const h = hdLight(l);
  const d = Math.max(0, h.dir[2] / Math.hypot(...h.dir));
  const up = d + (1 - d) * shadeWrap(2, h);
  return h.ambient[1] + h.diffuse[1] * up;
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

test("the classic picture (and the model viewer) shade by the cosine alone", () => {
  const l = sun(1, SOUTH_WEST, 0, 5.85);
  assert.equal(shadeWrap(1, l), 0);
  assert.equal(shadeWrap(0, l), 0);
  assert.equal(shadeWrap(undefined, l), 0);
  assert.equal(shadeWrap(2, l), 5.85);
  assert.equal(shadeWrap(2, sun(1, UP)), 0);
  assert.equal(shadeWrap(2, { dir: UP, diffuse: [1, 1, 1], ambient: [0, 0, 0] }), 0, "a light without the field");
});
