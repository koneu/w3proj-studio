import assert from "node:assert/strict";
import { test } from "node:test";
import { blockDataSize, decodeBlocks } from "./dxt";

/** RGBA of texel (x, y) in a decoded image of width `w`. */
const px = (img: Uint8ClampedArray, w: number, x: number, y: number) => [...img.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

test("BC1: the two end colours and the thirds between them", () => {
  // Red (0xF800) and blue (0x001F); texel indices 0, 1, 2, 3 along each row.
  const block = new Uint8Array([0x00, 0xf8, 0x1f, 0x00, 0xe4, 0xe4, 0xe4, 0xe4]);
  const img = decodeBlocks("bc1", block, 4, 4);
  assert.deepEqual(px(img, 4, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(img, 4, 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(img, 4, 2, 0), [170, 0, 85, 255]);
  assert.deepEqual(px(img, 4, 3, 0), [85, 0, 170, 255]);
});

test("BC1 punch-through: colour 0 ≤ colour 1 makes index 3 transparent", () => {
  const block = new Uint8Array([0x1f, 0x00, 0x00, 0xf8, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(px(decodeBlocks("bc1", block, 4, 4), 4, 0, 0), [0, 0, 0, 0]);
});

test("BC3: interpolated alpha over a BC1 colour block", () => {
  // Alpha 255 → 0 with index 1 everywhere (alpha 0); colour white.
  const alpha = [0xff, 0x00, 0x49, 0x92, 0x24, 0x49, 0x92, 0x24];
  const color = [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0];
  const img = decodeBlocks("bc3", new Uint8Array([...alpha, ...color]), 4, 4);
  assert.deepEqual(px(img, 4, 0, 0), [255, 255, 255, 0]);
  assert.deepEqual(px(img, 4, 3, 3), [255, 255, 255, 0]);
});

test("images that aren't a multiple of 4 use whole blocks", () => {
  assert.equal(blockDataSize("bc1", 5, 5), 4 * 8);
  assert.equal(blockDataSize("bc3", 4, 4), 16);
  const img = decodeBlocks("bc1", new Uint8Array(4 * 8), 5, 5);
  assert.equal(img.length, 5 * 5 * 4);
});
