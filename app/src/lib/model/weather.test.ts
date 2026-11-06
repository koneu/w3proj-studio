import assert from "node:assert/strict";
import { test } from "node:test";
import { GAME_VIEW, MOST_PARTICLES, placeWeather, viewBox, weatherEffect } from "./weather";

const rain: Record<string, string> = {
  effectID: "RAhr", texDir: "ReplaceableTextures\\Weather", texFile: "rainTail", alphaMode: "1", height: "768", angx: "15", angy: "15",
  lifespan: "0.9", particles: "1800", veloc: "-1200", accel: "0", var: "0", texr: "1", texc: "1", head: "0", tail: "1", taillen: "0.14",
  lati: "4.5", midTime: "0.5", redStart: "100", greenStart: "150", blueStart: "140", alphaStart: "0", alphaMid: "255", alphaEnd: "255",
  scaleStart: "1.5", scaleMid: "1", scaleEnd: "0.75",
};
const box = (size: number) => ({ left: -size / 2, right: size / 2, bottom: -size / 2, top: size / 2 });

test("a row becomes an emitter", () => {
  const w = weatherEffect(rain), e = w.model.particleEmitters2[0];
  assert.equal(w.texture, "ReplaceableTextures\\Weather\\rainTail");
  assert.deepEqual([e.speed, e.lifespan, e.filterMode, e.headOrTail, e.tailLength], [-1200, 0.9, 1, 1, 0.14]);
  assert.deepEqual(e.segmentAlpha, [0, 255, 255]);
  assert.deepEqual(e.segmentColor[0].map((c) => Math.round(c * 255)), [100, 150, 140]);
});

test("head or tail or both", () => {
  const kind = (head: string, tail: string) => weatherEffect({ ...rain, head, tail }).model.particleEmitters2[0].headOrTail;
  assert.deepEqual([kind("1", "0"), kind("0", "1"), kind("1", "1")], [0, 1, 2]);
});

test("a game view holds the row's particles", () => {
  const w = weatherEffect(rain), e = w.model.particleEmitters2[0];
  placeWeather(w, box(GAME_VIEW), 0);
  assert.equal(e.width, GAME_VIEW);
  assert.ok(Math.abs(e.emissionRate * e.lifespan - 1800) < 1e-6);
});

test("a small region has as thick a rain, a big one is capped", () => {
  const w = weatherEffect(rain), e = w.model.particleEmitters2[0];
  placeWeather(w, box(GAME_VIEW / 2), 0);
  assert.ok(Math.abs(e.emissionRate * e.lifespan - 450) < 1e-6);
  placeWeather(w, box(GAME_VIEW * 10), 0);
  assert.ok(Math.abs(e.emissionRate * e.lifespan - MOST_PARTICLES) < 1e-6);
});

test("it starts at its height over the ground, and upwind", () => {
  const still = weatherEffect({ ...rain, angx: "0", angy: "0" });
  const at = placeWeather(still, box(1000), 50);
  assert.deepEqual([at[12], at[13], at[14]], [0, 0, 818]);
  const w = weatherEffect(rain), world = placeWeather(w, box(1000), 0);
  // Halfway through its fall a particle is over the box's middle.
  const half = w.model.particleEmitters2[0].speed * 0.45;
  assert.ok(Math.abs(world[12] + world[8] * half) < 1e-3);
  assert.ok(Math.abs(world[13] + world[9] * half) < 1e-3);
});

test("the tilt keeps particles falling at the row's speed", () => {
  const { tilt } = weatherEffect(rain);
  assert.ok(Math.abs(Math.hypot(tilt[8], tilt[9], tilt[10]) - 1) < 1e-6);
  assert.ok(tilt[10] > 0.9, "mostly straight down for rain");
});

test("the box follows the view, and is never less than a game view", () => {
  assert.equal(viewBox(100, 0, 500).right - viewBox(100, 0, 500).left, GAME_VIEW);
  assert.ok(viewBox(0, 0, 4000).right > GAME_VIEW / 2);
  assert.equal(viewBox(100, 50, 500).left, 100 - GAME_VIEW / 2);
});
