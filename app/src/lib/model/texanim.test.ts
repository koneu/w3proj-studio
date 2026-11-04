import assert from "node:assert/strict";
import { test } from "node:test";
import type { Track } from "./mdx";
import { textureMatrix, type Clock } from "./renderer";

const clock: Clock = { frame: 0, seqStart: 0, seqEnd: 1000, time: 0 };
const still = (values: number[]): Track => ({ interp: 0, globalSeq: -1, times: new Uint32Array([0]), values: new Float32Array(values), size: values.length });
/** Applies a column-major 3×3 to (u, v). */
const apply = (m: Float32Array, u: number, v: number) => [m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]].map((x) => +x.toFixed(6) + 0);

test("no animation: texture coordinates unchanged", () => {
  assert.deepEqual(apply(textureMatrix(undefined, clock, []), 0.3, 0.7), [0.3, 0.7]);
});

test("translation moves, rotation and scaling turn about the texture's centre", () => {
  assert.deepEqual(apply(textureMatrix({ translation: still([0.25, -0.5, 0]) }, clock, []), 0.1, 0.9), [0.35, 0.4]);
  // A quarter turn about Z: (1, 0.5) → (0.5, 1); the centre stays.
  const quarter = textureMatrix({ rotation: still([0, 0, Math.SQRT1_2, Math.SQRT1_2]) }, clock, []);
  assert.deepEqual(apply(quarter, 1, 0.5), [0.5, 1]);
  assert.deepEqual(apply(quarter, 0.5, 0.5), [0.5, 0.5]);
  assert.deepEqual(apply(textureMatrix({ scaling: still([2, 2, 1]) }, clock, []), 1, 1), [1.5, 1.5]);
});
