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
  // The intensities themselves, without the colours (classic water is lit by these).
  near(night.levels!, [0.3, 1.95]);
  near(noon.levels!, [0.3, 1.95]);
  // A light turned 90° about X shines from -Y.
  m.lights[0].rotation = { interp: 0, globalSeq: -1, keys: [{ time: 0, value: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }] };
  near(lightAt(m, 6)!.dir, [0, -1, 0]);
});

test("a track of a global sequence stays at its first key all day (the sun of a map's own lighting)", () => {
  const m = sample();
  // As the 3.0.1 lighting editor saved it into smoketest_maps/cliff.w3m: a second rotation key at 17235, but
  // the track belongs to global sequence 0 (0 long). The World Editor keeps the sun of the first key.
  m.globalSequences = [0];
  const sw = [0.381539, -0.215864, -0.442587, 0.782271], north = [-0.477628, -0.225547, 0, 0.849117];
  m.lights[0].rotation = { interp: 0, globalSeq: 0, keys: [{ time: 333, value: sw }, { time: 17235, value: north }] };
  const near = (a: number[], b: number[]) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-3), `${a} ≉ ${b}`);
  for (const hour of [0, 6, 12, 18]) near(lightAt(m, hour)!.dir, [-0.675, -0.406, 0.616]);
  // The same keys outside a global sequence follow the day: the north key from 17235 on.
  m.lights[0].rotation.globalSeq = -1;
  near(lightAt(m, 12)!.dir, [-0.383, 0.811, 0.442]);
});

test("cliff.w3m's own lighting is the same at 06:00, 08:00 and 12:00, and carries its shadow intensity", () => {
  // Its colour keys (Hermite, stored blue first): white from 15172 to 43700 of 333–60333, so 06:00 (15333), 08:00
  // (20333) and 12:00 (30333) all fall on it; the ambient is flat from 14950 to 19932 and from 19932 to 45115.
  const m = sample();
  m.sequences = [{ name: "Stand", start: 333, end: 60333, moveSpeed: 0, nonLooping: false, rarity: 0 }];
  const k = (time: number, value: number[], inTan: number[], outTan: number[]) => ({ time, value, inTan, outTan });
  const zero = [0, 0, 0];
  m.lights[0].color = { track: { interp: 2, globalSeq: -1, keys: [
    k(333, [0.799191, 0.532794, 0.313408], zero, [0.196887, 0.223073, 0.313408]), k(13506, zero, zero, zero),
    k(13989, [0.2, 0.352941, 0.0235294], [0.196887, 0.223073, 0.313408], [0, 0.240211, 0.369262]),
    k(15172, [0.996078, 0.996078, 0.996078], [0, 0.240211, 0.369262], zero), k(15367, [0.996078, 0.996078, 0.996078], zero, zero),
    k(43700, [0.996078, 0.996078, 0.996078], zero, zero), k(45367, [0.996078, 0.996078, 0.996078], zero, [0, -0.147828, -0.324197]),
  ] } };
  m.lights[0].ambColor = { track: { interp: 2, globalSeq: -1, keys: [
    k(13826, zero, zero, zero), k(14950, [0.980392, 0.839852, 0.839852], [0.0145619, 0.317505, 0.37233], zero),
    k(19932, [0.980392, 0.839852, 0.839852], zero, zero), k(45115, [0.980392, 0.839852, 0.839852], zero, [-0.0775508, -0.317505, -0.203499]),
  ] } };
  m.lights[0].ambIntensity = { value: [0.2] };
  m.lights[0].shadowIntensity = 5.85;
  // Its sun: global sequence 0, so the first key all day.
  m.globalSequences = [0];
  m.lights[0].rotation = { interp: 0, globalSeq: 0, keys: [{ time: 333, value: [0.381539, -0.215864, -0.442587, 0.782271] }, { time: 17235, value: [-0.477628, -0.225547, 0, 0.849117] }] };
  const [six, eight, noon] = [6, 8, 12].map((h) => lightAt(m, h)!);
  const same = (a: number[], b: number[], what: string) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-9), `${what}: ${a} ≠ ${b}`);
  for (const [other, hour] of [[eight, 8], [noon, 12]] as const) {
    for (const key of ["dir", "diffuse", "ambient"] as const) same(other[key], six[key], `${key} at ${hour}:00`);
  }
  same(six.diffuse, [1.9423521, 1.9423521, 1.9423521], "06:00 is the white key at intensity 1.95");
  assert.equal(six.shadow, 5.85);
});
