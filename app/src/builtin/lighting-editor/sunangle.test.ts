import assert from "node:assert/strict";
import { test } from "node:test";
import { lightAt, type LightModel } from "../../lib/model/dnclight";
import { rotationOf, sunAngleOf } from "./sunangle";

const near = (a: readonly number[], b: readonly number[], eps = 1e-4) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a.join(", ")} isn't ${b.join(", ")}`));
};

/** The direction the terrain view lights with for a rotation (lightAt). */
const dirOf = (q: number[]) => lightAt({
  sequences: [{ name: "Stand", start: 0, end: 60000 }], globalSequences: [],
  lights: [{ type: 1, intensity: { value: [1] }, color: { value: [1, 1, 1] }, ambIntensity: { value: [0] }, ambColor: { value: [1, 1, 1] }, shadowIntensity: 0,
    rotation: { interp: 0, globalSeq: -1, keys: [{ time: 0, value: q }] } }],
} as unknown as LightModel, 12)!.dir;

test("no rotation is the sun straight above", () => {
  assert.deepEqual(sunAngleOf([0, 0, 0, 1]), { direction: 0, height: 90 });
  assert.deepEqual(rotationOf({ direction: 0, height: 90 }), [0, 0, 0, 1]);
  assert.deepEqual(rotationOf({ direction: 123, height: 90 }), [0, 0, 0, 1]);
});

test("the classic light comes from the south-west, about 38 degrees up", () => {
  // A rotation whose light direction is (-0.675, -0.406, 0.616), as the game's DNC models have it.
  const q = rotationOf({ direction: 211, height: 38 });
  const a = sunAngleOf(q);
  near([a.direction, a.height], [211, 38], 1e-3);
  near(dirOf(q), [Math.cos(38 * Math.PI / 180) * Math.cos(211 * Math.PI / 180), Math.cos(38 * Math.PI / 180) * Math.sin(211 * Math.PI / 180), Math.sin(38 * Math.PI / 180)]);
});

test("the compass: 0 east, 90 north, 180 west, 270 south", () => {
  near(dirOf(rotationOf({ direction: 0, height: 0 })), [1, 0, 0]);
  near(dirOf(rotationOf({ direction: 90, height: 0 })), [0, 1, 0]);
  near(dirOf(rotationOf({ direction: 180, height: 0 })), [-1, 0, 0]);
  near(dirOf(rotationOf({ direction: 270, height: 0 })), [0, -1, 0]);
});

test("every typed angle reads back, and the terrain view's light comes from there", () => {
  for (let direction = 0; direction < 360; direction += 15) {
    for (const height of [-89, -45, 0, 0.5, 30, 60, 89]) {
      const q = rotationOf({ direction, height });
      near([Math.hypot(...q)], [1], 1e-5);
      const a = sunAngleOf(q);
      near([a.direction, a.height], [direction, height], 2e-3);
      const e = height * Math.PI / 180, d = direction * Math.PI / 180;
      near(dirOf(q), [Math.cos(e) * Math.cos(d), Math.cos(e) * Math.sin(d), Math.sin(e)]);
    }
  }
});

test("straight below, a rotation that isn't unit length, and one that is nothing", () => {
  const down = rotationOf({ direction: 40, height: -90 });
  assert.deepEqual(down, [1, 0, 0, 0]);
  assert.deepEqual(sunAngleOf(down), { direction: 0, height: -90 });
  const q = rotationOf({ direction: 100, height: 20 });
  assert.deepEqual(sunAngleOf(q.map((v) => v * 3)), sunAngleOf(q));
  assert.deepEqual(sunAngleOf([0, 0, 0, 0]), { direction: 0, height: 90 });
});

test("a rotation with a turn about the light's own axis has the same sun angle", () => {
  // Turned about +Z first (q * roll): the light's axis ends in the same place.
  const [x, y, z, w] = rotationOf({ direction: 211, height: 38 });
  const s = Math.sin(0.4), c = Math.cos(0.4);
  const rolled = [x * c + y * s, y * c - x * s, w * s + z * c, w * c - z * s];
  const a = sunAngleOf(rolled);
  near([a.direction, a.height], [211, 38], 1e-3);
});
