import assert from "node:assert/strict";
import { test } from "node:test";
import { tinyMdx } from "../testhelpers/countinggl";
import { parseModel } from "./mdl";
import type { Track } from "./mdx";
import { modelMoves } from "./preview";
import { standClock } from "./renderer";

// The model preview draws a model that stands still only when something it shows changes; one that moves (a track in
// its Stand animation, particles, ribbons) every frame. modelMoves is that choice.

const model = () => parseModel(tinyMdx("a.tga"));
const track = (times: number[], values: number[], size: number): Track =>
  ({ interp: 1, globalSeq: -1, times: new Uint32Array(times), values: new Float32Array(values), size }) as unknown as Track;

test("a model with nothing moving in its Stand animation stands still", () => {
  const m = model();
  assert.equal(modelMoves(m, standClock(m)), false);
});

test("a track that moves within the Stand animation makes it move; one that moves only outside doesn't", () => {
  const m = model(), clock = standClock(m);
  assert.deepEqual([clock.seqStart, clock.seqEnd], [0, 1000]);
  const node = { translation: track([0, 500], [0, 0, 0, 0, 0, 9], 3) } as unknown as (typeof m.nodes)[number];
  m.nodes.push(node);
  assert.equal(modelMoves(m, clock), true);
  m.nodes[m.nodes.length - 1] = { translation: track([2000, 2500], [0, 0, 0, 0, 0, 9], 3) } as unknown as (typeof m.nodes)[number];
  assert.equal(modelMoves(m, clock), false);
});

test("particles and ribbons move whatever the tracks do", () => {
  const withParticles = model();
  withParticles.particleEmitters2.push({} as (typeof withParticles.particleEmitters2)[number]);
  assert.equal(modelMoves(withParticles, standClock(withParticles)), true);
  const withRibbon = model();
  withRibbon.ribbons.push({} as (typeof withRibbon.ribbons)[number]);
  assert.equal(modelMoves(withRibbon, standClock(withRibbon)), true);
});
