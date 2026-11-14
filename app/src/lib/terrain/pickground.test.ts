import assert from "node:assert/strict";
import { test } from "node:test";
import { heightAt, pickGroundOn, pickHeightAt, type Corner, type Terrain } from "./w3e";

/** tests/fixtures/we-specs/plateau.w3x: 65x65 corners, a level-3 plateau (128 up) at corners 25..39 x 27..35. */
function plateau(): Terrain {
  const width = 65, height = 65, corners: Corner[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const high = x >= 25 && x <= 39 && y >= 27 && y <= 35;
    corners.push({ layer: high ? 3 : 2, height: high ? 128 : 0, ramp: false } as Corner);
  }
  return { width, height, offsetX: -4096, offsetY: -4096, corners } as Terrain;
}
const col = (x: number) => (x + 4096) / 128;

/** The ray of the World Editor's opening camera (distance 2738, pitch 57.2 degrees, from the south, target 128 up)
 *  through the ground point (col, row) at height `z`. */
function rayThrough(c: number, r: number, z: number) {
  const pitch = 0.9983283321407566, d = 2738;
  const origin: [number, number, number] = [0, -298 - d * Math.cos(pitch), 128 + d * Math.sin(pitch)];
  const p = [c * 128 - 4096, r * 128 - 4096, z];
  const v = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]], l = Math.hypot(v[0], v[1], v[2]);
  return { origin, dir: [v[0] / l, v[1] / l, v[2] / l] as [number, number, number] };
}

test("the ground pick over a cliff lands where the World Editor's does: 0.125 of a tile nearer than the bilinear slope", () => {
  const t = plateau();
  // spec ramp-plateau-west, click 360,450 on plateau.w3x: the ray meets the foot of the west face (col 24) at row
  // 31.57, which rounds to corner row 32; the editor's Ramp builds on row 31.
  const ray = rayThrough(23.992, 31.569, 0);
  const hit = pickGroundOn(t, ray, 30000)!;
  assert.ok(hit, "hits the map");
  const row = (hit[1] + 4096) / 128;
  assert.ok(row < 31.5, `row ${row} rounds to 31`);
  assert.ok(col(hit[0]) > 23.99 && col(hit[0]) < 24.2, `col ${col(hit[0])} on the face`);
  // Over the same face further up (click 360,484: the slope's hit at row 30.56, the editor's corner row 30).
  const up = pickGroundOn(t, rayThrough(24.25, 30.56, 32), 30000)!;
  assert.ok((up[1] + 4096) / 128 < 30.5, `row ${(up[1] + 4096) / 128} rounds to 30`);
});

test("flat ground, and a ray that never reaches a cliff, pick as before", () => {
  const t = plateau();
  const ray = rayThrough(32, 20.3, 0);
  const hit = pickGroundOn(t, ray, 30000)!;
  assert.ok(Math.abs(col(hit[0]) - 32) < 0.001 && Math.abs((hit[1] + 4096) / 128 - 20.3) < 0.001);
  assert.equal(pickHeightAt(t, -4096 + 10 * 128, -4096 + 10 * 128), 0);
  assert.equal(pickHeightAt(t, 0, 0), 128, "the plateau's top");
  // On the face the pick looks up the slope; the height the viewer draws is unchanged.
  const x = -4096 + 24.5 * 128, y = -4096 + 31 * 128;
  assert.ok(pickHeightAt(t, x, y) > heightAt(t, x, y));
  assert.equal(heightAt(t, x, y), 64);
});
