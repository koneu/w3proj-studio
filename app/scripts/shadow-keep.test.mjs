// shadow-keep.mjs: the light kept over a shadow's core, a region without a shadow giving none (the control), the mean
// of several frames, and its arguments.

import test from "node:test";
import assert from "node:assert/strict";
import { coreMask, parseArgs, shadowKeep } from "./shadow-keep.mjs";

const enc = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));
const dec = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

/** A 100x80 picture of one colour (linear r, g, b), `shade` (linear, per channel) times it inside `square` [x, y, w, h]. */
function picture(rgb, square = null, shade = [1, 1, 1]) {
  const width = 100, height = 80, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = square && x >= square[0] && x < square[0] + square[2] && y >= square[1] && y < square[1] + square[3];
    for (let k = 0; k < 3; k++) rgba[(y * width + x) * 4 + k] = enc(rgb[k] * (inside ? shade[k] : 1));
    rgba[(y * width + x) * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

test("shadow-keep: the light kept per channel over the shadow's core, in linear light", () => {
  const water = [0.02, 0.2, 0.5], off = picture(water);
  const on = picture(water, [30, 20, 40, 40], [0.9, 0.5, 0.7]);
  const r = shadowKeep(on, off, [0, 0, 100, 80]);
  // the core is the square less the blur's half-width on each side: about 32 x 32
  assert.ok(r.pixels > 900 && r.pixels < 1600, `core of ${r.pixels} pixels`);
  // what the 8-bit pictures hold of 0.9, 0.5, 0.7 times the colour
  const want = [0.9, 0.5, 0.7].map((s, k) => dec(enc(water[k] * s)) / dec(enc(water[k])));
  r.kept.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 0.002, `channel ${k}: ${v} against ${want[k]}`));
});

test("shadow-keep: a region without a shadow has no core, nor one with a shadow lighter than the threshold", () => {
  const water = [0.02, 0.2, 0.5];
  assert.deepEqual(shadowKeep(picture(water), picture(water), [0, 0, 100, 80]), { pixels: 0, kept: null });
  assert.equal(shadowKeep(picture(water, [30, 20, 40, 40], [0.9, 0.9, 0.9]), picture(water), [0, 0, 100, 80]).kept, null);
  // the square outside the region: none either
  assert.equal(shadowKeep(picture(water, [30, 20, 40, 40], [0.5, 0.5, 0.5]), picture(water), [75, 0, 25, 80]).kept, null);
  // the light shadow over the core of a darker one of the same view
  const mask = coreMask(picture(water, [30, 20, 40, 40], [0.4, 0.4, 0.4]), picture(water), [0, 0, 100, 80]);
  const light = shadowKeep(picture(water, [30, 20, 40, 40], [0.9, 0.9, 0.9]), picture(water), [0, 0, 100, 80], { mask });
  assert.ok(light.pixels > 900 && light.kept.every((v) => Math.abs(v - 0.9) < 0.02), JSON.stringify(light));
  assert.throws(() => shadowKeep(picture(water), picture(water), [0, 0, 10, 10], { mask }), /mask has/);
});

test("shadow-keep: several frames are averaged before the ratio is taken", () => {
  const off = [picture([0.1, 0.2, 0.3]), picture([0.1, 0.2, 0.9])];
  const on = [picture([0.1, 0.2, 0.3], [30, 20, 40, 40], [0.5, 0.5, 0.5]), picture([0.1, 0.2, 0.9], [30, 20, 40, 40], [0.5, 0.5, 0.5])];
  // each frame alone keeps the same (a little over 0.5: the core takes in the pixels the blur darkens round it)
  const one = shadowKeep(on[0], off[0], [0, 0, 100, 80]), r = shadowKeep(on, off, [0, 0, 100, 80]);
  assert.ok(one.kept.every((v) => v > 0.5 && v < 0.56), `${one.kept}`);
  r.kept.forEach((v, k) => assert.ok(Math.abs(v - one.kept[k]) < 0.01, `${r.kept} against ${one.kept}`));
  // a frame on against the other off: the blue is far off (what the mean evens out)
  assert.ok(Math.abs(shadowKeep(on[0], off[1], [0, 0, 100, 80]).kept[2] - one.kept[2]) > 0.1);
  assert.throws(() => shadowKeep(on, [{ width: 10, height: 10, rgba: new Uint8Array(400) }], [0, 0, 5, 5]), /differ in size/);
  assert.throws(() => shadowKeep(on, off, [90, 0, 20, 10]), /outside/);
});

test("shadow-keep: arguments", () => {
  assert.deepEqual(parseArgs(["a.png,b.png", "c.png", "--region", "s=1,2,3,4", "--threshold", "0.7"]),
    { files: ["a.png,b.png", "c.png"], regions: [{ name: "s", rect: [1, 2, 3, 4] }], threshold: 0.7, min: 30 });
  assert.throws(() => parseArgs(["a.png", "b.png"]), /--region/);
  assert.throws(() => parseArgs(["a.png", "--region", "1,2,3,4"]), /two pictures/);
  assert.throws(() => parseArgs(["a.png", "b.png", "--region", "1,2,3,4", "--threshold", "2"]), /between 0 and 1/);
});
