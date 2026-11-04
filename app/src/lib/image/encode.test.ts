import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeBlp1Jpeg } from "./encode";
import { decodeImage } from "./index";

/** 8×8: red rising left to right, alpha opaque on the left half, clear on the right. */
function sample(): Uint8Array {
  const px = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const i = (y * 8 + x) * 4;
    px.set([x * 32, 128, 64, x < 4 ? 255 : 0], i);
  }
  return px;
}

test("BLP1 JPEG with alpha and mipmaps: every level, alpha kept", () => {
  const img = decodeImage(encodeBlp1Jpeg(8, 8, sample(), 95, { alpha: true, mipmaps: true }));
  assert.equal(img.mipCount, 4);
  assert.deepEqual([0, 1, 2, 3].map((k) => img.mip(k).width), [8, 4, 2, 1]);
  const top = img.mip(0).rgba;
  // JPEG is lossy: close, not exact.
  assert.ok(Math.abs(top[3] - 255) < 12, `left alpha ${top[3]}`);
  assert.ok(top[7 * 4 + 3] < 12, `right alpha ${top[7 * 4 + 3]}`);
  assert.ok(Math.abs(top[7 * 4] - 224) < 20, `red ${top[7 * 4]}`);
});

test("defaults (minimaps): one level, opaque", () => {
  const img = decodeImage(encodeBlp1Jpeg(8, 8, sample()));
  assert.equal(img.mipCount, 1);
  assert.ok(img.mip(0).rgba[7 * 4 + 3] > 240);
});
