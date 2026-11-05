import assert from "node:assert/strict";
import { test } from "node:test";
import { resizeTerrain } from "./resize";
import type { Corner, Terrain } from "./w3e";

function terrain(w: number, h: number): Terrain {
  const corner = (i: number): Corner => ({ height: i, water: 0, texture: i % 3, variation: 5, cliffVariation: 0, cliffTexture: 15, layer: 2, ramp: true, blight: true, hasWater: false, boundary: false, rawHeight: 0, rawWater: 0, texExtra: 0 });
  return { width: w, height: h, offsetX: -64, offsetY: -64, corners: Array.from({ length: w * h }, (_, i) => corner(i)) } as unknown as Terrain;
}

test("corners that stay are untouched; new ones continue the edge with a variation of their own", () => {
  const t = terrain(3, 2);
  const random = Math.random;
  Math.random = () => 0.7; // randomVariation: 17, never the 5 of the old corners
  try {
    const r = resizeTerrain(t, [0, 2, 0, 0]);
    assert.equal(r.width, 5);
    assert.equal(r.corners.length, 10);
    assert.deepEqual(r.corners[1], t.corners[1]);
    const added = r.corners[3], edge = t.corners[2];
    assert.equal(added.texture, edge.texture);
    assert.equal(added.height, edge.height);
    assert.equal(added.variation, 17);
    assert.equal(added.ramp, false);
    assert.equal(added.blight, false);
  } finally { Math.random = random; }
});

test("adding on the left and bottom moves the offset, not the world position", () => {
  const r = resizeTerrain(terrain(3, 3), [1, 0, 1, 0]);
  assert.equal(r.offsetX, -64 - 128);
  assert.equal(r.offsetY, -64 - 128);
  assert.deepEqual(r.corners[r.width + 1], terrain(3, 3).corners[0]);
});
