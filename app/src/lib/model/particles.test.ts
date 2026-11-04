import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model, ParticleEmitter2, Track } from "./mdx";
import { ParticleInstance, spriteCell } from "./particles";
import { mat4, poseNodes, type Clock } from "./renderer";

/** A model with one emitter at (0, 0, 100) shooting straight up. */
function model(over: Partial<ParticleEmitter2> = {}): Model {
  const node = { name: "Fire", objectId: 0, parentId: -1, flags: 0, kind: "pre2" };
  const e: ParticleEmitter2 = {
    node, speed: 100, variation: 0, latitude: 0, gravity: 0, lifespan: 1, emissionRate: 10, width: 0, length: 0,
    filterMode: 1, rows: 1, columns: 1, headOrTail: 0, tailLength: 1, time: 0.5,
    segmentColor: [[1, 1, 1], [1, 1, 1], [1, 1, 1]], segmentAlpha: [255, 255, 0], segmentScaling: [10, 10, 10],
    headIntervals: [0, 0, 1], headDecayIntervals: [0, 0, 1], tailIntervals: [0, 0, 1], tailDecayIntervals: [0, 0, 1],
    textureId: 0, squirt: false, priorityPlane: 0, replaceableId: 0, ...over,
  };
  return {
    version: 800, name: "test", extent: { radius: 0, min: [0, 0, 0], max: [0, 0, 0] },
    sequences: [{ name: "Stand", start: 0, end: 1000, moveSpeed: 0, flags: 0, rarity: 0, extent: { radius: 0, min: [0, 0, 0], max: [0, 0, 0] } }],
    globalSequences: [], textures: [], materials: [], geosets: [], geosetAnims: [], nodes: [node],
    pivots: new Float32Array([0, 0, 100]), particleEmitters2: [e], skipped: [], warnings: [],
  };
}
const clock: Clock = { frame: 0, seqStart: 0, seqEnd: 1000, time: 0 };
const track = (times: number[], values: number[]): Track => ({ interp: 0, globalSeq: -1, times: new Uint32Array(times), values: new Float32Array(values), size: 1 });

/** Steps `n` times by `dt` at a standing pose (instance at the origin). */
function run(m: Model, n: number, dt: number, c: Clock = clock) {
  const p = new ParticleInstance(m, () => 0.5);
  const nodes = poseNodes(m, c);
  for (let i = 0; i < n; i++) p.step(dt, c, nodes, mat4.identity());
  return p;
}

test("emission rate: 10 per second spawn 10 in a second, each living its lifespan", () => {
  const p = run(model({ lifespan: 5 }), 10, 0.1);
  assert.equal(p.count, 10);
  // With a lifespan of 1 s the stream settles at rate × lifespan (steps exact in binary).
  assert.equal(run(model({ emissionRate: 8 }), 40, 0.125).count, 8);
});

test("particles start at the pivot, fly along +Z at their speed and fall with gravity", () => {
  const p = run(model({ emissionRate: 1, lifespan: 10 }), 1, 1);
  const first = p.emitters[0].particles[0];
  assert.deepEqual([first.x, first.y, first.z], [0, 0, 100]);
  assert.equal(first.vz, 100);
  const falling = run(model({ emissionRate: 1, lifespan: 10, gravity: 50 }), 3, 1).emitters[0].particles[0];
  // Spawned in the first step, then two steps of 1 s: v = 100 - 2·50, z = 100 + 50 + 0.
  assert.equal(falling.vz, 0);
  assert.equal(falling.z, 150);
});

test("visibility off stops emission; squirt emits a burst only when passing a key", () => {
  assert.equal(run(model({ visibilityTrack: track([0], [0]) }), 10, 0.1).count, 0);
  const squirt = model({ squirt: true, lifespan: 10, emissionRateTrack: track([500], [7]) });
  const p = new ParticleInstance(squirt, () => 0.5);
  const nodes = poseNodes(squirt, clock);
  for (const frame of [0, 400, 600, 800]) p.step(0.1, { ...clock, frame }, nodes, mat4.identity());
  assert.equal(p.count, 7);
});

test("sprite cells walk through the interval, repeating `repeat` times", () => {
  assert.equal(spriteCell([0, 0, 1], 0.7), 0);
  assert.equal(spriteCell([0, 3, 1], 0), 0);
  assert.equal(spriteCell([0, 3, 1], 0.5), 2);
  assert.equal(spriteCell([0, 3, 1], 0.99), 3);
  assert.equal(spriteCell([10, 13, 2], 0.5), 10);
  assert.equal(spriteCell([10, 13, 2], 0.25), 12);
});
