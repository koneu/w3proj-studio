import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeImage } from "./index";

const u32s = (b: Uint8Array, at: number, ...v: number[]) => { const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(at + i * 4, x, true)); };
const magic = (b: Uint8Array, s: string, at = 0) => b.set(new TextEncoder().encode(s), at);
const px = (m: { rgba: Uint8ClampedArray }, i: number) => [...m.rgba.subarray(i * 4, i * 4 + 4)];

/** A BLP1 palette: entry 0 red, 1 green, 2 blue (stored B, G, R). */
function palette(b: Uint8Array, at: number) { b.set([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0], at); }

function blp1(alphaBits: number, levels: Uint8Array[], w = 2, h = 2) {
  const size = levels.reduce((n, l) => n + l.length, 0);
  const b = new Uint8Array(156 + 1024 + size);
  magic(b, "BLP1");
  u32s(b, 4, 1, alphaBits, w, h, 4, levels.length > 1 ? 1 : 0);
  palette(b, 156);
  let o = 156 + 1024;
  levels.forEach((l, i) => { u32s(b, 28 + i * 4, o); u32s(b, 92 + i * 4, l.length); b.set(l, o); o += l.length; });
  return b;
}

test("BLP1 palettized, no alpha: colours come from the palette", () => {
  const m = decodeImage(blp1(0, [new Uint8Array([0, 1, 2, 0])]));
  assert.equal(m.format, "BLP1 palettized, no alpha");
  assert.equal(m.hasAlpha, false);
  assert.deepEqual(px(m.mip(0), 0), [255, 0, 0, 255]);
  assert.deepEqual(px(m.mip(0), 1), [0, 255, 0, 255]);
  assert.deepEqual(px(m.mip(0), 2), [0, 0, 255, 255]);
});

test("BLP1 palettized alpha: 8, 4 and 1 bits", () => {
  const eight = decodeImage(blp1(8, [new Uint8Array([0, 0, 0, 0, 200, 100, 50, 0])])).mip(0);
  assert.deepEqual([3, 7, 11, 15].map((i) => eight.rgba[i]), [200, 100, 50, 0]);
  const four = decodeImage(blp1(4, [new Uint8Array([0, 0, 0, 0, 0xf1, 0x03])])).mip(0);
  assert.deepEqual([3, 7, 11, 15].map((i) => four.rgba[i]), [17, 255, 51, 0]);
  const one = decodeImage(blp1(1, [new Uint8Array([0, 0, 0, 0, 0b0101])])).mip(0);
  assert.deepEqual([3, 7, 11, 15].map((i) => one.rgba[i]), [255, 0, 255, 0]);
});

test("BLP1 mip levels halve; a level outside the file is left out", () => {
  const two = blp1(0, [new Uint8Array(4), new Uint8Array([2])]);
  const m = decodeImage(two);
  assert.equal(m.mipCount, 2);
  assert.deepEqual(px(m.mip(1), 0), [0, 0, 255, 255]);
  assert.throws(() => m.mip(2), /out of range/);
  assert.equal(decodeImage(two.subarray(0, two.length - 1)).mipCount, 1);
});

test("a level is decoded once", () => {
  const m = decodeImage(blp1(0, [new Uint8Array(4)]));
  assert.equal(m.mip(0), m.mip(0));
});

test("broken BLP files are refused", () => {
  assert.throws(() => decodeImage(blp1(0, [new Uint8Array(4)]).subarray(0, 200)), /no readable mip/);
  const c = blp1(0, [new Uint8Array(4)]);
  u32s(c, 4, 9);
  assert.throws(() => decodeImage(c), /compression 9/);
  assert.throws(() => decodeImage(new TextEncoder().encode("hello world, not an image")), /unrecognised/);
});

function blp2(encoding: number, alphaDepth: number, alphaType: number, data: Uint8Array, w = 1, h = 1) {
  const b = new Uint8Array(148 + 1024 + data.length);
  magic(b, "BLP2");
  u32s(b, 4, 1);
  b.set([encoding, alphaDepth, alphaType, 0], 8);
  u32s(b, 12, w, h);
  u32s(b, 20, 148 + 1024);
  u32s(b, 84, data.length);
  palette(b, 148);
  b.set(data, 148 + 1024);
  return b;
}

test("BLP2: palettized, raw BGRA, and which DXT its alpha type means", () => {
  assert.deepEqual(px(decodeImage(blp2(1, 0, 0, new Uint8Array([1]))).mip(0), 0), [0, 255, 0, 255]);
  assert.deepEqual(px(decodeImage(blp2(3, 8, 0, new Uint8Array([10, 20, 30, 40]))).mip(0), 0), [30, 20, 10, 40]);
  assert.equal(decodeImage(blp2(2, 0, 0, new Uint8Array(8), 4, 4)).format, "BLP2 DXT1");
  assert.equal(decodeImage(blp2(2, 8, 1, new Uint8Array(16), 4, 4)).format, "BLP2 DXT3");
  assert.equal(decodeImage(blp2(2, 8, 7, new Uint8Array(16), 4, 4)).format, "BLP2 DXT5");
  assert.throws(() => decodeImage(blp2(9, 0, 0, new Uint8Array(4))), /encoding 9/);
});

test("BLP2 JPEG isn't supported, and says so", () => {
  const b = blp2(1, 0, 0, new Uint8Array(1));
  u32s(b, 4, 0);
  assert.throws(() => decodeImage(b), /BLP2 JPEG/);
});

function tga(type: number, bpp: number, desc: number, pixels: number[], w = 2, h = 2) {
  const b = new Uint8Array(18 + pixels.length);
  b[2] = type; b[12] = w; b[14] = h; b[16] = bpp; b[17] = desc;
  b.set(pixels, 18);
  return b;
}

test("TGA: bottom-up by default, top-down by flag, BGR(A) to RGBA", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  assert.deepEqual(px(decodeImage(tga(2, 24, 0, rows), "a.tga").mip(0), 0), [9, 8, 7, 255]);
  assert.deepEqual(px(decodeImage(tga(2, 24, 0x20, rows), "a.tga").mip(0), 0), [3, 2, 1, 255]);
  assert.deepEqual(px(decodeImage(tga(2, 32, 0x28, [1, 2, 3, 4, ...new Array(12).fill(0)]), "a.tga").mip(0), 0), [3, 2, 1, 4]);
  assert.deepEqual(px(decodeImage(tga(3, 8, 0x20, [9, 0, 0, 0]), "a.tga").mip(0), 0), [9, 9, 9, 255]);
});

test("TGA RLE: repeated and literal packets, an overlong run stops at the image", () => {
  const m = decodeImage(tga(10, 24, 0x20, [0x81, 1, 2, 3, 0x01, 4, 5, 6, 7, 8, 9]), "a.tga").mip(0);
  assert.deepEqual([0, 1, 2, 3].map((i) => px(m, i)), [[3, 2, 1, 255], [3, 2, 1, 255], [6, 5, 4, 255], [9, 8, 7, 255]]);
  assert.deepEqual(px(decodeImage(tga(10, 24, 0x20, [0xff, 1, 2, 3]), "a.tga").mip(0), 3), [3, 2, 1, 255]);
});

test("TGA colour-mapped", () => {
  const b = new Uint8Array(18 + 6 + 1);
  b[1] = 1; b[2] = 1; b[5] = 2; b[7] = 24; b[12] = 1; b[14] = 1; b[16] = 8;
  b.set([1, 2, 3, 4, 5, 6, 1], 18);
  assert.deepEqual(px(decodeImage(b, "a.tga").mip(0), 0), [6, 5, 4, 255]);
});

function dds(pfFlags: number, fourcc: string, bpp: number, masks: number[], data: Uint8Array, w = 1, h = 1, mips = 1) {
  const b = new Uint8Array(128 + data.length);
  magic(b, "DDS ");
  u32s(b, 12, h, w);
  u32s(b, 28, mips);
  u32s(b, 80, pfFlags);
  magic(b, fourcc.padEnd(4, "\0"), 84);
  u32s(b, 88, bpp, ...masks);
  b.set(data, 128);
  return b;
}

test("DDS: uncompressed by channel masks, compressed by FourCC, mip levels", () => {
  const argb = decodeImage(dds(0x41, "", 32, [0xff0000, 0xff00, 0xff, 0xff000000], new Uint8Array([1, 2, 3, 4]))).mip(0);
  assert.deepEqual(px(argb, 0), [3, 2, 1, 4]);
  assert.equal(decodeImage(dds(4, "DXT5", 0, [0, 0, 0, 0], new Uint8Array(16), 4, 4)).format, "DDS DXT5");
  assert.equal(decodeImage(dds(4, "DXT1", 0, [0, 0, 0, 0], new Uint8Array(8 + 8 + 8), 4, 4, 3)).mipCount, 3);
  assert.equal(decodeImage(dds(4, "DXT1", 0, [0, 0, 0, 0], new Uint8Array(8), 4, 4, 3)).mipCount, 1);
});

test("DDS it can't read says why", () => {
  assert.throws(() => decodeImage(dds(4, "XXXX", 0, [0, 0, 0, 0], new Uint8Array(8))), /FourCC XXXX/);
  const bc7 = dds(4, "DX10", 0, [0, 0, 0, 0], new Uint8Array(40));
  u32s(bc7, 128, 98);
  assert.throws(() => decodeImage(bc7), /BC7/);
  assert.throws(() => decodeImage(dds(4, "DXT1", 0, [0, 0, 0, 0], new Uint8Array(2), 4, 4)), /truncated/);
});
