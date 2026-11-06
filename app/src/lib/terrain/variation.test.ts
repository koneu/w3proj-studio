import assert from "node:assert/strict";
import { test } from "node:test";
import { CornerUndo } from "./cliffs";
import { PLAIN_VARIATION, resetVariations } from "./variation";
import type { Corner, Terrain } from "./w3e";

const make = (): Terrain => ({
  width: 3, height: 2,
  corners: Array.from({ length: 6 }, (_, i) => ({
    variation: [0, 5, 17, 16, 31, 9][i], cliffVariation: i % 4, ramp: i % 2 === 0, blight: i === 1, boundary: i === 2,
    height: i * 10, rawHeight: 0x2000 + i, layer: 2 + (i % 3), texture: i % 2, cliffTexture: 1, rawWater: 0x2000 + i, hasWater: i === 3,
  }) as unknown as Corner),
} as Terrain);

const without = (c: Corner) => { const { variation: _v, ...rest } = c; return rest; };
const sameButVariation = (a: Terrain, b: Terrain) => assert.deepEqual(b.corners.map(without), a.corners.map(without));

test("every ground variation becomes the plain one, nothing else changes", () => {
  const before = make(), t = make();
  const n = resetVariations(t, new CornerUndo());
  assert.equal(n, 5, "the corners already plain are not counted");
  assert.deepEqual(t.corners.map((c) => c.variation), Array(6).fill(PLAIN_VARIATION));
  sameButVariation(before, t); // cliff variation, ramps, heights, water, flags, textures
});

test("one undo step restores the old values, redo applies them again", () => {
  const before = make(), t = make(), log = new CornerUndo();
  resetVariations(t, log);
  const step = log.step(t);
  assert.equal(step.corners.length, 5);
  step.undo();
  assert.deepEqual(t.corners, before.corners);
  step.redo();
  assert.deepEqual(t.corners.map((c) => c.variation), Array(6).fill(PLAIN_VARIATION));
});

test("control: a reset that also touches the cliff variation fails the same check", () => {
  const before = make(), t = make();
  resetVariations(t, new CornerUndo());
  t.corners[2].cliffVariation = 0;
  assert.throws(() => sameButVariation(before, t));
  const u = make();
  resetVariations(u, new CornerUndo());
  u.corners[0].variation = 3;
  assert.notDeepEqual(u.corners.map((c) => c.variation), Array(6).fill(PLAIN_VARIATION));
});

test("a map that is plain already has nothing to reset", () => {
  const t = make();
  t.corners.forEach((c) => { c.variation = PLAIN_VARIATION; });
  assert.equal(resetVariations(t, new CornerUndo()), 0);
});
