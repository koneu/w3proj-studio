import assert from "node:assert/strict";
import { test } from "node:test";
import { frustumPlanes, sphereInView, worldSphere } from "./frustum";
import { mat4 } from "./renderer";

// A camera at (0, -1000, 1000) looking at the origin, 45° field of view, square picture.
const viewProj = mat4.mul(mat4.perspective(Math.PI / 4, 1, 10, 10000), mat4.lookAt([0, -1000, 1000], [0, 0, 0], [0, 0, 1]));
const planes = frustumPlanes(viewProj);

test("the planes are unit length and the point looked at is inside all six", () => {
  for (let p = 0; p < 6; p++) {
    assert.ok(Math.abs(Math.hypot(planes[p * 4], planes[p * 4 + 1], planes[p * 4 + 2]) - 1) < 1e-5, `plane ${p}`);
    assert.ok(planes[p * 4 + 3] > 0, `plane ${p} has the origin inside`);
  }
});

test("what's in front of the camera is in view; what's beside, behind or past the far end isn't", () => {
  assert.equal(sphereInView(planes, [0, 0, 0, 10]), true);
  assert.equal(sphereInView(planes, [300, 200, 0, 10]), true);
  assert.equal(sphereInView(planes, [5000, 0, 0, 10]), false, "far to the right");
  assert.equal(sphereInView(planes, [-5000, 0, 0, 10]), false, "far to the left");
  assert.equal(sphereInView(planes, [0, -3000, 3000, 10]), false, "behind the camera");
  assert.equal(sphereInView(planes, [0, 20000, -20000, 10]), false, "past the far plane");
});

test("a sphere counts with its size: the edge of a big one reaches into the view", () => {
  // Just right of the right edge at the origin's depth: the view there is about 1414 · tan(22.5°) ≈ 586 wide each side.
  const beside = [900, 0, 0];
  assert.equal(sphereInView(planes, [...beside, 10]), false);
  assert.equal(sphereInView(planes, [...beside, 400]), true);
});

test("an off-centre model's sphere swings round when the object turns, and grows when it's scaled", () => {
  // A wall whose middle is 200 east of its origin, placed at (1000, 0, 0).
  const wall = [200, 0, 50, 220] as const;
  const at = (angle: number, scale: number) => {
    const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
    return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, scale, 0, 1000, 0, 0, 1]);
  };
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
  assert.ok(near(worldSphere(at(0, 1), wall), [1200, 0, 50, 220]));
  // Turned a quarter: the middle is now north of the origin, not still east of it (as moving the old sphere along would leave it).
  assert.ok(near(worldSphere(at(Math.PI / 2, 1), wall), [1000, 200, 50, 220]), String(worldSphere(at(Math.PI / 2, 1), wall)));
  assert.ok(near(worldSphere(at(Math.PI, 2), wall), [600, 0, 100, 440]), "turned round and twice the size");
});
