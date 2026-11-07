import assert from "node:assert/strict";
import { test } from "node:test";
import { frustumPlanes, sphereInView } from "./frustum";
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
