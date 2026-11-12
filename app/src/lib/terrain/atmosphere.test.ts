import assert from "node:assert/strict";
import { test } from "node:test";
import { applySky, NO_WEATHER, resolveChoice, resolveWeather } from "./atmosphere";

const tilesets: [string, string][] = [["A", "Ashenvale"], ["L", "Lordaeron Summer"]];
const weather: [string, string][] = [["RAlr", "Lordaeron Rain (Heavy)"], ["WOsw", "Outland Wind"]];
const doc = () => ({
  version: 31, flags: 0, lightEnvironment: "", weather: NO_WEATHER,
  fog: { style: 0, start: 3000, end: 5000, density: 0.5, color: [255, 255, 255, 255] },
  terrainFog: { style: 0, overSky: 0, linearStart: 0, linearEnd: 0, maxOpacity: 0, height: 0 },
  waterTint: [128, 255, 255, 255],
});

test("a name is an id or a label in any case; an unknown one lists the choices", () => {
  assert.equal(resolveChoice("light", "a", tilesets), "A");
  assert.equal(resolveChoice("light", "lordaeron summer", tilesets), "L");
  assert.throws(() => resolveChoice("light", "Nowhere Land", tilesets), /Unknown light "Barrens"\. Choices: A = Ashenvale; L = Lordaeron Summer/);
  assert.equal(resolveWeather("none", weather), NO_WEATHER);
  assert.equal(resolveWeather("RAlr", weather), "RAlr");
  assert.equal(resolveWeather("outland wind", weather), "WOsw");
  assert.throws(() => resolveWeather("Snow", weather), /Unknown weather effect "Snow".*RAlr = Lordaeron Rain/);
});

test("set_sky's changes land in the w3i and are listed; fog values turn fog on", () => {
  const d = doc();
  const out = applySky(d, { lightEnvironment: "Ashenvale", fogStyle: "Exponential 2", fogEnd: 9000, fogColor: "#ff0000", overSky: 1, waterTint: [0, 255, 0] }, { tilesets });
  assert.equal(d.lightEnvironment, "A");
  assert.equal(d.fog.style, 2);
  assert.equal(d.fog.end, 9000);
  assert.deepEqual(d.fog.color, [0, 0, 255, 255], "blue, green, red, alpha");
  assert.equal(d.terrainFog.overSky, 1);
  assert.deepEqual(d.waterTint, [0, 255, 0, 255]);
  assert.equal(d.flags, 0x2000 | 0x10000);
  assert.ok(out.some((l) => l.startsWith("light environment: default → A")), out.join("|"));
  assert.ok(out.some((l) => l.startsWith("terrain fog: off → on")));
  assert.deepEqual(applySky(d, { lightEnvironment: "A" }, { tilesets }), [], "the same again changes nothing");
  applySky(d, { lightEnvironment: "default", useFog: false }, { tilesets });
  assert.equal(d.lightEnvironment, "");
  assert.equal(d.flags, 0x10000);
});

test("a refused call leaves the document as it was", () => {
  const d = doc();
  assert.throws(() => applySky(d, { fogEnd: 1, lightEnvironment: "Nowhere Land" }, { tilesets }), /Unknown light environment/);
  assert.throws(() => applySky(d, { fogEnd: 1, fogColor: "red" }, { tilesets }), /#rrggbb/);
  assert.throws(() => applySky(d, { fogStart: "far" }, { tilesets }), /number/);
  assert.deepEqual(d, doc());
  assert.throws(() => applySky({ ...doc(), version: 18 }, { fogEnd: 1 }, { tilesets }), /no light, fog/);
  const old = doc() as Record<string, unknown>; delete old.terrainFog;
  assert.throws(() => applySky(old, { overSky: 1 }, { tilesets }), /over sky/);
});
