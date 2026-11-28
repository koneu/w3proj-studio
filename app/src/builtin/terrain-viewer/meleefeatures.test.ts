import assert from "node:assert/strict";
import { test } from "node:test";
import { compareFeatures, FEATURE_NOTES, median, referenceOf } from "./meleefeatures";
import reference from "./meleereference.json";

test("a reference holds each feature's lowest, usual span, median and highest, and no map", () => {
  const maps = Array.from({ length: 11 }, (_, i) => ({ openGround: 10 + i * 2, campsPerPlayer: 9 }));
  const ref = referenceOf([...maps, { openGround: NaN, campsPerPlayer: 9, mines: 6 }]);
  assert.equal(ref.maps, 12);
  assert.deepEqual(ref.features.openGround, { min: 10, low: 12, median: 20, high: 28, max: 30 });
  assert.deepEqual(ref.features.campsPerPlayer, { min: 9, low: 9, median: 9, high: 9, max: 9 });
  // A feature only some maps have is taken over those.
  assert.deepEqual(ref.features.mines, { min: 6, low: 6, median: 6, high: 6, max: 6 });
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("a map is told where it lies outside every reference map, or outside where most lie", () => {
  const ref = referenceOf(Array.from({ length: 11 }, (_, i) => ({ openGround: 10 + i * 2, campsPerPlayer: 5 + i, mines: 6 })));
  const got = compareFeatures({ openGround: 48, campsPerPlayer: 5.5, mines: 6, unknownFeature: 3 }, ref);
  assert.deepEqual(got.map((o) => [o.feature, o.verdict]), [["openGround", "above all 11 reference maps"], ["campsPerPlayer", "lower than nine in ten reference maps"]]);
  assert.deepEqual([got[0].value, got[0].usual, got[0].range], [48, [12, 28], [10, 30]]);
  assert.equal(got[0].what, FEATURE_NOTES.openGround);
  assert.equal(compareFeatures({ openGround: 2 }, ref)[0].verdict, "below all 11 reference maps");
  assert.equal(compareFeatures({ openGround: 29 }, ref)[0].verdict, "higher than nine in ten reference maps");
  assert.deepEqual(compareFeatures({ openGround: 20, campsPerPlayer: 9, mines: 6 }, ref), []);
});

test("the stored reference is the game's two-player maps as numbers only", () => {
  assert.ok(reference.maps >= 30, String(reference.maps));
  const keys = Object.keys(reference.features);
  assert.ok(keys.length >= 14);
  for (const k of keys) {
    assert.ok(FEATURE_NOTES[k], `${k} has a note`);
    const r = (reference.features as Record<string, { min: number; low: number; median: number; high: number; max: number }>)[k];
    assert.ok(r.min <= r.low && r.low <= r.median && r.median <= r.high && r.high <= r.max, `${k} is in order`);
  }
  // Numbers only: nothing in it names a map.
  assert.doesNotMatch(JSON.stringify(reference), /[A-Za-z]{4,}(?<!features|campLevel|campLevelHighest|campShelter|campShelterLowest|campWays|campsPerPlayer|mines|narrowGround|naturalWalk|nearestCamp|nearestExpansion|openGround|startToStart|treesPer100Walkable|treesPlayable|walkable|median|maps|high)\b.*\.w3[xm]/);
  assert.deepEqual(Object.keys(reference).sort(), ["features", "maps"]);
});
