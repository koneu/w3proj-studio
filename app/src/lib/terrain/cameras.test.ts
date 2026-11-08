import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraColors, cameraEye, LAYER_LOOK, type CameraLook } from "./cameras";

const cam = { targetX: 640, targetY: 640, rotation: 0, distance: 640, angleOfAttack: 0, fieldOfView: 60 };
const W = 40, H = 40;
const texel = (rgba: Uint8Array, x: number, y: number) => [...rgba.slice(((Math.floor(y / 32)) * W + Math.floor(x / 32)) * 4, ((Math.floor(y / 32)) * W + Math.floor(x / 32)) * 4 + 4)];

test("cameraColors: the target and the eye are drawn where the camera is, nothing elsewhere", () => {
  assert.deepEqual(cameraEye(cam), [0, 640]);
  const rgba = cameraColors([cam], W, H, 0, 0);
  const at = (x: number, y: number) => texel(rgba, x, y)[3];
  assert.equal(at(640, 640), 255);
  assert.equal(at(16, 656), 255);
  assert.ok(at(320, 656) > 0, "the line between them");
  assert.equal(at(1200, 100), 0);
  assert.equal(cameraColors([{ ...cam, fieldOfView: NaN }], W, H, 0, 0).every((v) => v === 0), true, "a camera with a broken value is left out whole");
});

test("cameraColors: each camera takes the look it is given, and the later one is drawn over the earlier", () => {
  const blue: CameraLook = { fov: [0, 0, 200, 100], line: [0, 0, 200, 200], target: [0, 0, 255, 255], eye: [0, 0, 255, 255], targetRadius: 3, eyeRadius: 2 };
  const other = { ...cam, name: "other" };
  const rgba = cameraColors([cam, other], W, H, 0, 0, (c) => (c === other ? blue : LAYER_LOOK));
  assert.deepEqual(texel(rgba, 640, 640), blue.target, "the second camera's target lies over the first's");
  // A target radius of 3 reaches three cells out; the layer's own 2 doesn't.
  assert.deepEqual(texel(rgba, 640 + 3 * 32, 640), blue.target);
  assert.deepEqual(texel(cameraColors([cam], W, H, 0, 0), 640 + 3 * 32, 640), [0, 0, 0, 0]);
});
