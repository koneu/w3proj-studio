import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import { crc32, encodePng } from "./png";

/** A PNG read back with Node's own zlib: the oracle isn't the writer's. */
function readPng(png: Uint8Array) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8, width = 0, height = 0, type = "";
  const idat: Buffer[] = [];
  const types: string[] = [];
  while (o < png.length) {
    const len = view.getUint32(o);
    type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    assert.equal(view.getUint32(o + 8 + len), crc32(png.subarray(o + 4, o + 8 + len)), `${type} crc`);
    types.push(type);
    if (type === "IHDR") { width = view.getUint32(o + 8); height = view.getUint32(o + 12); assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]); }
    if (type === "IDAT") idat.push(Buffer.from(data));
    o += 12 + len;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (1 + width * 4)], 0, "filter byte");
    rgba.set(raw.subarray(y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4)), y * width * 4);
  }
  return { width, height, rgba };
}

const picture = (w: number, h: number) => Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 7 + (i >> 5)) & 255);

test("crc32 of the standard check string", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("a PNG reads back to the same pixels, compressed or stored", async () => {
  for (const [w, h] of [[1, 1], [3, 2], [256, 256], [300, 70]]) {
    const px = picture(w, h);
    for (const compress of [true, false]) {
      const back = readPng(await encodePng(w, h, px, { compress }));
      assert.deepEqual([back.width, back.height], [w, h]);
      assert.deepEqual(back.rgba, px, `${w}×${h} compress ${compress}`);
    }
  }
});

test("stored PNG is bigger than the compressed one for flat colour (compression runs)", async () => {
  const flat = new Uint8Array(256 * 256 * 4).fill(40);
  assert.ok((await encodePng(256, 256, flat)).length < (await encodePng(256, 256, flat, { compress: false })).length / 10);
});

test("wrong sizes are refused", async () => {
  await assert.rejects(encodePng(2, 2, new Uint8Array(15)), /needs 16 values/);
  await assert.rejects(encodePng(0, 2, new Uint8Array(0)), /can't write/);
  await assert.rejects(encodePng(1.5, 2, new Uint8Array(12)), /can't write/);
});

test("a side past what the writer's tests cover is refused instead of written wrong", async () => {
  await assert.rejects(encodePng(65536, 1, new Uint8Array(65536 * 4)), /can't write/);
});

test("an image past the pixel cap is refused before anything is allocated", async () => {
  const huge = { length: 8193 * 4096 * 4 } as ArrayLike<number>;
  await assert.rejects(encodePng(8193, 4096, huge), /more than \d+ pixels/);
  await assert.rejects(encodePng(65535, 65535, { length: 0 } as ArrayLike<number>), /more than \d+ pixels/);
  assert.equal((await encodePng(2, 2, new Uint8Array(16))).length > 40, true, "at the cap's other side an image is written");
});

test("a failing compressor is an error of encodePng, not an unhandled rejection or a silent empty image", async () => {
  const real = globalThis.CompressionStream;
  const unhandled: unknown[] = [];
  const on = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", on);
  class Broken {
    writable = { getWriter: () => ({ write: () => Promise.reject(new Error("deflate broke")), close: async () => {} }) };
    readable = { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) };
  }
  (globalThis as { CompressionStream?: unknown }).CompressionStream = Broken;
  try {
    await assert.rejects(encodePng(2, 2, new Uint8Array(16)), /deflate broke/);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    (globalThis as { CompressionStream?: unknown }).CompressionStream = real;
    process.off("unhandledRejection", on);
  }
});

test("when the reader fails first, the write's later failure is not left unhandled", async () => {
  const real = globalThis.CompressionStream;
  const unhandled: unknown[] = [];
  const on = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", on);
  class Broken {
    writable = { getWriter: () => ({ write: () => new Promise((_, no) => setTimeout(() => no(new Error("late")), 5)), close: async () => {} }) };
    readable = { getReader: () => ({ read: async () => { throw new Error("read broke"); } }) };
  }
  (globalThis as { CompressionStream?: unknown }).CompressionStream = Broken;
  try {
    await assert.rejects(encodePng(2, 2, new Uint8Array(16)), /read broke/);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    (globalThis as { CompressionStream?: unknown }).CompressionStream = real;
    process.off("unhandledRejection", on);
  }
});
