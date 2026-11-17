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

test("BC1 in a 5x5 image: each of the four blocks has its own colour, and the edge texels come from the right block", () => {
  // Blocks in row order: red, green, blue, white (c0 = c1, every index 0, so each block is its one colour).
  const solid = (c: number) => [c & 255, c >> 8, c & 255, c >> 8, 0, 0, 0, 0];
  const data = new Uint8Array([...solid(0xf800), ...solid(0x07e0), ...solid(0x001f), ...solid(0xffff)]);
  const img = decodeBlocks("bc1", data, 5, 5);
  assert.equal(img.length, 5 * 5 * 4);
  const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255], white = [255, 255, 255, 255];
  for (const [x, y, want, why] of [
    [0, 0, red, "first texel"], [3, 3, red, "last texel of the first block"],
    [4, 0, green, "right edge, top row"], [4, 3, green, "right edge, last row of the top blocks"],
    [0, 4, blue, "bottom edge, left"], [3, 4, blue, "bottom edge, last column of the left blocks"],
    [4, 4, white, "the corner, the only texel of its block"],
  ] as const) assert.deepEqual(px(img, 5, x, y), want, `texel ${x},${y}: ${why}`);
  // The four colours are all there and nothing else (control: no block was read twice).
  const seen = new Set<string>();
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) seen.add(px(img, 5, x, y).join());
  assert.equal(seen.size, 4);
});

test("BC1 and BC3 data short of a whole block are refused, one byte short as well as none", () => {
  for (const [f, size] of [["bc1", 8], ["bc3", 16]] as const) {
    assert.throws(() => decodeBlocks(f, new Uint8Array(4 * size - 1), 5, 5), /truncated/, `${f}: 4 blocks of ${size} bytes, one byte short`);
    assert.throws(() => decodeBlocks(f, new Uint8Array(0), 5, 5), /truncated/, `${f}: no data`);
    assert.equal(decodeBlocks(f, new Uint8Array(4 * size + 3), 5, 5).length, 100, `${f}: trailing bytes are ignored`);
  }
});
