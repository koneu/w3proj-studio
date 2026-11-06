import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeImage, type BlockImage, type DecodedImage } from "../image/index";
import { createTexture, drawnTextures, levelFor, uploadableLevels } from "./gltexture";
import type { Layer, Model } from "./mdx";

/** Records what's done to it. `refuse`: the next error the context reports. */
function fakeGl(s3tc = true, refuse = 0) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const count = (fn: string) => calls.filter((c) => c.fn === fn).length;
  const gl = {
    NO_ERROR: 0, INVALID_OPERATION: 0x502, TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, TEXTURE_MAX_LEVEL: 4, TEXTURE_MIN_FILTER: 5, LINEAR_MIPMAP_LINEAR: 6,
    TEXTURE_WRAP_S: 7, TEXTURE_WRAP_T: 8, REPEAT: 9, CLAMP_TO_EDGE: 10,
    getExtension: (name: string) => (s3tc && name === "WEBGL_compressed_texture_s3tc"
      ? { COMPRESSED_RGBA_S3TC_DXT1_EXT: 101, COMPRESSED_RGBA_S3TC_DXT3_EXT: 103, COMPRESSED_RGBA_S3TC_DXT5_EXT: 105 } : null),
    getError() {
      calls.push({ fn: "getError", args: [] });
      // An upload has to happen before there's an error to report.
      if (refuse && count("compressedTexImage2D")) { const e = refuse; refuse = 0; return e; }
      return 0;
    },
  };
  const texture = new Proxy(gl as unknown as WebGL2RenderingContext, {
    get(target, key) {
      if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key];
      return (...args: unknown[]) => { calls.push({ fn: String(key), args }); return {}; };
    },
  });
  const parameter = (name: number) => calls.filter((c) => c.fn === "texParameteri" && c.args[1] === name).map((c) => c.args[2]);
  return { gl: texture, calls, count, parameter };
}

const level = (width: number, height: number, bytes: number) => ({ width, height, data: new Uint8Array(bytes) });
const dxt1 = (...levels: BlockImage["levels"]): BlockImage => ({ format: "bc1", levels });
/** An image that fails the test if it gets decoded. */
const undecoded = (blocks: BlockImage): DecodedImage => ({
  format: "test", width: blocks.levels[0].width, height: blocks.levels[0].height, hasAlpha: false, mipCount: blocks.levels.length, blocks,
  mip() { throw new Error("this image shouldn't be decoded"); },
});
const decodable = (blocks?: BlockImage): DecodedImage & { decoded: number[] } => {
  const decoded: number[] = [];
  return {
    decoded, format: "test", width: 8, height: 8, hasAlpha: false, mipCount: 1, blocks,
    mip(i) { decoded.push(i); return { width: 8, height: 8, rgba: new Uint8ClampedArray(256) }; },
  };
};
const CLAMP: { repeat: [boolean, boolean] } = { repeat: [false, false] };

test("a whole chain goes up to the last level", () => {
  const levels = uploadableLevels(dxt1(level(8, 8, 32), level(4, 4, 8), level(2, 2, 8), level(1, 1, 8)));
  assert.deepEqual(levels.map((l) => l.width), [8, 4, 2, 1]);
});

test("WebGL refuses a top level that isn't whole blocks, and a lower one that isn't either", () => {
  assert.deepEqual(uploadableLevels(dxt1(level(6, 4, 16))), [], "top level");
  assert.deepEqual(uploadableLevels(dxt1(level(4, 6, 16))), [], "top level, the other way");
  // 12, 6: the 6 can't go, and 3 after it doesn't matter any more.
  assert.deepEqual(uploadableLevels(dxt1(level(12, 12, 72), level(6, 6, 32), level(3, 3, 8))).map((l) => l.width), [12]);
  assert.deepEqual(uploadableLevels(dxt1(level(16, 12, 96), level(8, 6, 32))).map((l) => l.width), [16]);
});

test("a level short of data, or of the wrong size, ends the chain", () => {
  assert.deepEqual(uploadableLevels(dxt1(level(8, 8, 32), level(4, 4, 7))).map((l) => l.width), [8]);
  assert.deepEqual(uploadableLevels(dxt1(level(8, 8, 31))), []);
  assert.deepEqual(uploadableLevels(dxt1(level(8, 8, 32), level(2, 2, 8))).map((l) => l.width), [8], "a level was left out");
  assert.deepEqual(uploadableLevels(dxt1(level(0, 8, 0))), []);
  const [only] = uploadableLevels(dxt1(level(4, 4, 100)));
  assert.equal(only.data.length, 8, "compressedTexImage2D takes the exact size");
});

test("blocks go to the GPU as they are, level by level, and aren't decoded", () => {
  const f = fakeGl();
  createTexture(f.gl, undecoded({ format: "bc3", levels: [level(8, 8, 64), level(4, 4, 16), level(2, 2, 16)] }), CLAMP);
  const up = f.calls.filter((c) => c.fn === "compressedTexImage2D").map((c) => c.args.slice(1, 5));
  assert.deepEqual(up, [[0, 105, 8, 8], [1, 105, 4, 4], [2, 105, 2, 2]]);
  assert.equal(f.count("generateMipmap"), 0);
  assert.deepEqual(f.parameter(4), [2], "only the levels there are");
});

test("each format takes its own GL format", () => {
  for (const [format, gl] of [["bc1", 101], ["bc2", 103], ["bc3", 105]] as const) {
    const f = fakeGl();
    createTexture(f.gl, undecoded({ format, levels: [level(4, 4, 16)] }), CLAMP);
    assert.equal(f.calls.find((c) => c.fn === "compressedTexImage2D")!.args[2], gl);
  }
});

test("a mip limit holds, and so does a chain shorter than the limit", () => {
  const limited = fakeGl();
  createTexture(limited.gl, undecoded(dxt1(level(8, 8, 32), level(4, 4, 8), level(2, 2, 8))), { ...CLAMP, maxLevel: 1 });
  assert.deepEqual(limited.parameter(4), [1]);
  const short = fakeGl();
  createTexture(short.gl, undecoded(dxt1(level(8, 8, 32))), { ...CLAMP, maxLevel: 3 });
  assert.deepEqual(short.parameter(4), [0], "level 3 doesn't exist: an incomplete texture draws black");
});

test("wrap flags apply per axis", () => {
  const f = fakeGl();
  createTexture(f.gl, undecoded(dxt1(level(4, 4, 8))), { repeat: [true, false] });
  assert.deepEqual([f.parameter(7), f.parameter(8)], [[9], [10]]);
});

test("without S3TC the image is decoded and mipmapped", () => {
  const f = fakeGl(false), image = decodable(dxt1(level(8, 8, 32)));
  createTexture(f.gl, image, CLAMP);
  assert.deepEqual(image.decoded, [0]);
  assert.equal(f.count("texImage2D"), 1);
  assert.equal(f.count("generateMipmap"), 1);
  assert.equal(f.count("compressedTexImage2D"), 0);
});

test("what has no blocks, or can't be uploaded as blocks, is decoded", () => {
  const plain = decodable(), odd = decodable(dxt1(level(6, 6, 32))), f = fakeGl();
  createTexture(f.gl, plain, CLAMP);
  createTexture(f.gl, odd, CLAMP);
  assert.deepEqual([plain.decoded, odd.decoded], [[0], [0]]);
  assert.equal(f.count("compressedTexImage2D"), 0);
});

test("the decoder keeps the mip limit too", () => {
  const f = fakeGl(false);
  createTexture(f.gl, decodable(), { ...CLAMP, maxLevel: 2 });
  assert.deepEqual(f.parameter(4), [2]);
});

test("a format the GPU refuses is decoded, now and from then on", () => {
  const f = fakeGl(true, 0x502), first = decodable(dxt1(level(8, 8, 32))), second = decodable(dxt1(level(8, 8, 32)));
  createTexture(f.gl, first, CLAMP);
  assert.deepEqual(first.decoded, [0], "the refused upload falls back");
  assert.equal(f.count("deleteTexture"), 1);
  createTexture(f.gl, second, CLAMP);
  assert.deepEqual(second.decoded, [0]);
  assert.equal(f.count("compressedTexImage2D"), 1, "it isn't tried again");
});

test("the GPU is asked about a format once", () => {
  const f = fakeGl(), image = undecoded(dxt1(level(4, 4, 8)));
  createTexture(f.gl, image, CLAMP);
  const asked = f.count("getError");
  assert.ok(asked >= 1);
  createTexture(f.gl, image, CLAMP);
  createTexture(f.gl, image, CLAMP);
  assert.equal(f.count("getError"), asked, "a round trip per texture is what this avoids");
  createTexture(f.gl, undecoded({ format: "bc3", levels: [level(4, 4, 16)] }), CLAMP);
  assert.ok(f.count("getError") > asked, "another format is another question");
});

test("real files hand over their blocks, in the right place", () => {
  // DXT1 with 2 levels: the first 8 × 8 is 32 bytes, its second 8 bytes.
  const data = new Uint8Array(80).map((_, i) => i);
  const dds = new Uint8Array(128 + data.length), v = new DataView(dds.buffer);
  dds.set(new TextEncoder().encode("DDS "));
  v.setUint32(12, 8, true);
  v.setUint32(16, 8, true);
  v.setUint32(28, 2, true);
  v.setUint32(80, 4, true);
  dds.set(new TextEncoder().encode("DXT1"), 84);
  dds.set(data, 128);
  const image = decodeImage(dds);
  assert.equal(image.blocks?.format, "bc1");
  assert.deepEqual(image.blocks!.levels.map((l) => [l.width, l.data[0], l.data.length]), [[8, 0, 32], [4, 32, 8]]);
  // BC4 and BC5 aren't S3TC: they stay with the decoder.
  dds.set(new TextEncoder().encode("ATI2"), 84);
  assert.equal(decodeImage(dds).blocks, undefined);
});

test("BLP2 hands over DXT blocks and nothing else", () => {
  const blp2 = (encoding: number, alphaType: number) => {
    const b = new Uint8Array(148 + 1024 + 8), v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("BLP2"));
    v.setUint32(4, 1, true);
    b.set([encoding, 8, alphaType, 0], 8);
    v.setUint32(12, 4, true);
    v.setUint32(16, 4, true);
    v.setUint32(20, 148 + 1024, true);
    v.setUint32(84, 8, true);
    return b;
  };
  assert.equal(decodeImage(blp2(2, 0)).blocks?.format, "bc1");
  assert.equal(decodeImage(blp2(2, 1)).blocks?.format, "bc2");
  assert.equal(decodeImage(blp2(2, 7)).blocks?.format, "bc3");
  assert.equal(decodeImage(blp2(1, 0)).blocks, undefined);
});

const layer = (textureIds: number[], textureTrack?: Layer["textureTrack"]) => ({ textureIds, textureTrack }) as Layer;
const model = (textures: number, layers: Layer[], emitters: number[] = []) => ({
  textures: Array.from({ length: textures }, () => ({})), materials: [{ priorityPlane: 0, flags: 0, layers }],
  particleEmitters2: emitters.map((textureId) => ({ textureId })),
}) as unknown as Pick<Model, "textures" | "materials" | "particleEmitters2">;

test("a Reforged layer needs its diffuse and ORM, not its normal map or the rest", () => {
  assert.deepEqual([...drawnTextures(model(6, [layer([0, 1, 2, 3, 4, 5])]))], [0, 2]);
});

test("a classic model needs every texture, used by a layer or not", () => {
  assert.deepEqual([...drawnTextures(model(3, [layer([0])]))], [0, 1, 2]);
});

test("a texture that's needed somewhere else stays", () => {
  assert.deepEqual([...drawnTextures(model(3, [layer([0, 1, 2]), layer([1])]))], [0, 1, 2], "another layer's diffuse");
  assert.deepEqual([...drawnTextures(model(3, [layer([0, 1, 2])], [1]))], [0, 1, 2], "a particle emitter's");
});

test("an animated layer can show any of them", () => {
  const track = {} as Layer["textureTrack"];
  assert.deepEqual([...drawnTextures(model(4, [layer([0, 1, 2, 3], track)]))], [0, 1, 2, 3]);
});

test("a level for a size: the smallest that's tall enough", () => {
  const image = { height: 1024, mipCount: 11 };
  assert.equal(levelFor(image, 128), 3);
  assert.equal(levelFor(image, 129), 2);
  assert.equal(levelFor(image, 1024), 0);
  assert.equal(levelFor(image, 4096), 0, "nothing tall enough: the biggest there is");
  assert.equal(levelFor({ height: 1024, mipCount: 2 }, 8), 1, "only the levels the file has");
});
