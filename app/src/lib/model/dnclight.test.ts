import assert from "node:assert/strict";
import { test } from "node:test";
import { fmt, lightAt, readLightMdl, writeLightMdl, type LightModel } from "./dnclight";

test("fmt prints numbers like C's %g (6 significant digits, 3-digit exponent)", () => {
  assert.equal(fmt(0), "0");
  assert.equal(fmt(-0), "-0");
  assert.equal(fmt(1.95), "1.95");
  assert.equal(fmt(0.3), "0.3");
  assert.equal(fmt(333), "333");
  assert.equal(fmt(0.381539), "0.381539");
  assert.equal(fmt(1 / 3), "0.333333");
  assert.equal(fmt(1234567), "1.23457e+006");
  assert.equal(fmt(0.00001), "1e-005");
  assert.equal(fmt(-0.21586), "-0.21586");
});

/** A day/night light like the game's DNC models: static values, colour keys over the day, a turning sun. */
function sample(): LightModel {
  return {
    version: 800,
    name: "DNCTestTerrain",
    blendTime: 150,
    sequences: [{ name: "Stand", start: 0, end: 60000, moveSpeed: 0, nonLooping: false, rarity: 0 }],
    globalSequences: [],
    lights: [{
      name: "FDirectSun", objectId: 0, parentId: -1, flags: 0x200, type: 1, unknown: 0,
      attenuationStart: { value: [80] }, attenuationEnd: { value: [200] },
      intensity: { value: [1.95] },
      color: { track: { interp: 2, globalSeq: -1, keys: [
        { time: 0, value: [0.5, 0.25, 0.125], inTan: [0, 0, 0], outTan: [0, 0, 0] },
        { time: 30000, value: [1, 1, 1], inTan: [0.1, 0.2, 0.3], outTan: [0, 0.5, 0.75] },
        { time: 60000, value: [0.5, 0.25, 0.125], inTan: [0, 0, 0], outTan: [0, 0, 0] },
      ] } },
      ambIntensity: { value: [0.3] },
      ambColor: { track: { interp: 1, globalSeq: -1, keys: [
        { time: 0, value: [0.2, 0.4, 0.6] },
        { time: 60000, value: [0.2, 0.4, 0.6] },
      ] } },
      shadowIntensity: 0.4, shadowCastingStart: 0, shadowCastingEnd: 0, quadraticFalloff: 0, linearFalloff: 0, damping: 0,
      rotation: { interp: 1, globalSeq: -1, keys: [
        { time: 333, value: [0.381539, -0.21586, -0.44258, 0.782271] },
        { time: 17235, value: [-0.47762, -0.22554, 0, 0.849117] },
      ] },
    }],
    pivots: [[0, 0, 0]],
  };
}

test("an MDL text written and read back gives the same model", () => {
  const m = sample();
  const text = writeLightMdl(m, new Date(2026, 10, 4, 15, 39, 28));
  assert.match(text, /^\/\/ MDLFile version\tW3Proj Studio\r\n\/\/ Exported on Wed Nov  4 15:39:28 2026\r\n/);
  assert.deepEqual(readLightMdl(text), m);
});

test("writing is stable: read → write gives the same text", () => {
  const date = new Date(2026, 0, 1);
  const text = writeLightMdl(sample(), date);
  assert.equal(writeLightMdl(readLightMdl(text), date), text);
});

test("a model without lights reads as one without lights (the editor refuses it)", () => {
  const m = readLightMdl("Model \"Footman\" {\n\tBlendTime 150,\n}\n");
  assert.equal(m.name, "Footman");
  assert.deepEqual(m.lights, []);
});

test("lighting at an hour: colours BGR → RGB times intensity, hours over the day sequence, +Z turned", () => {
  const m = sample();
  const near = (a: number[], b: number[]) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-6), `${a} ≉ ${b}`);
  // The sample's sequence runs 0–60000: 12:00 is time 30000, the white key.
  const noon = lightAt(m, 12)!;
  near(noon.diffuse, [1.95, 1.95, 1.95]);
  // Midnight: stored (0.5, 0.25, 0.125) as blue, green, red.
  const night = lightAt(m, 0)!;
  near(night.diffuse, [0.125 * 1.95, 0.25 * 1.95, 0.5 * 1.95]);
  near(night.ambient, [0.6 * 0.3, 0.4 * 0.3, 0.2 * 0.3]);
  // A light turned 90° about X shines from -Y.
  m.lights[0].rotation = { interp: 0, globalSeq: -1, keys: [{ time: 0, value: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }] };
  near(lightAt(m, 6)!.dir, [0, -1, 0]);
});
