import assert from "node:assert/strict";
import { test } from "node:test";
import { blocksOpaque } from "./gltexture";
import { effectiveFilterMode } from "./renderer";

test("a blend layer with a texture without transparency, at full opacity, is drawn as an opaque one", () => {
  assert.equal(effectiveFilterMode(2, 1, true), 0);
});

test("anything else keeps its filter mode: fading, a texture with transparency, other modes", () => {
  assert.equal(effectiveFilterMode(2, 0.5, true), 2, "a fade is blending");
  assert.equal(effectiveFilterMode(2, 1, false), 2, "a texture with holes needs blending");
  for (const mode of [0, 1, 3, 4, 5, 6]) assert.equal(effectiveFilterMode(mode, 1, true), mode, `mode ${mode}`);
});

/** One BC3 block: alpha end points, then 16 three-bit indices (all the same), then 8 colour bytes. */
const bc3 = (a0: number, a1: number, index: number) => {
  const bits = Array.from({ length: 16 }, () => index).reduce((n, v, i) => n | (BigInt(v) << BigInt(i * 3)), 0n);
  return [a0, a1, ...Array.from({ length: 6 }, (_, i) => Number((bits >> BigInt(i * 8)) & 0xffn)), 0, 0, 0, 0, 0, 0, 0, 0];
};
const image = (format: "bc1" | "bc2" | "bc3", bytes: number[]) => ({ format, levels: [{ width: 4, height: 4, data: new Uint8Array(bytes) }] });

test("BC3: opaque when every texel's alpha works out to 255", () => {
  assert.equal(blocksOpaque(image("bc3", bc3(255, 255, 0))), true);
  assert.equal(blocksOpaque(image("bc3", bc3(255, 255, 5))), true, "interpolated between two 255");
  // With both end points 255 the table is the six-step one, whose index 6 is zero: not opaque.
  assert.equal(blocksOpaque(image("bc3", bc3(255, 255, 6))), false);
  assert.equal(blocksOpaque(image("bc3", bc3(255, 0, 0))), true, "index 0 is the first end point, 255");
  assert.equal(blocksOpaque(image("bc3", bc3(255, 0, 1))), false, "index 1 is the second end point");
  assert.equal(blocksOpaque(image("bc3", bc3(254, 255, 0))), false);
});

test("BC2 and BC1: explicit alpha all 15, no transparent index", () => {
  const colour = [0, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(blocksOpaque(image("bc2", [...Array(8).fill(0xff), ...colour])), true);
  assert.equal(blocksOpaque(image("bc2", [...Array(7).fill(0xff), 0xef, ...colour])), false);
  // End points equal (not "first above second"): index 3 is transparent.
  assert.equal(blocksOpaque(image("bc1", [0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])), false);
  assert.equal(blocksOpaque(image("bc1", [0, 0, 0, 0, 0, 0, 0, 0])), true, "three colours, none index 3");
  assert.equal(blocksOpaque(image("bc1", [1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])), true, "four colours");
});

test("a truncated or empty image is not known to be opaque", () => {
  assert.equal(blocksOpaque({ format: "bc3", levels: [] }), false);
  assert.equal(blocksOpaque(image("bc3", [255, 255])), false);
});

test("the class follows textures that land after the pose", async () => {
  const { ModelGpu } = await import("./renderer");
  const { createTexture } = await import("./gltexture");
  const gl = new Proxy({ getExtension: (n: string) => (n === "WEBGL_compressed_texture_s3tc" ? { COMPRESSED_RGBA_S3TC_DXT5_EXT: 1, COMPRESSED_RGBA_S3TC_DXT1_EXT: 2, COMPRESSED_RGBA_S3TC_DXT3_EXT: 3 } : null), getError: () => 0, getAttribLocation: () => 0, NO_ERROR: 0 } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
  const layer = { filterMode: 2, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 };
  const model = {
    nodes: [], textures: [{ replaceableId: 0, path: "white.blp", flags: 0 }], materials: [{ priorityPlane: 0, flags: 0, layers: [layer] }],
    geosets: [{ positions: new Float32Array(9), normals: new Float32Array(9), uvs: new Float32Array(6), faces: new Uint16Array([0, 1, 2]), vertexGroups: new Uint8Array(3), groups: [[0]], materialId: 0, lod: 0 }],
    geosetAnims: [], globalSequences: [], textureAnims: [], sequences: [],
  } as unknown as ConstructorParameters<typeof ModelGpu>[1];
  const gpu = new ModelGpu(gl, model);
  gpu.pose({ frame: 0, seqStart: 0, seqEnd: 0, time: 0 });
  const modes = () => (gpu as unknown as { classified(): { mode: number }[] }).classified().map((d) => d.mode);
  assert.deepEqual(modes(), [2], "no texture yet: blended");
  const opaque = { format: "bc3" as const, levels: [{ width: 4, height: 4, data: new Uint8Array(bc3(255, 255, 0)) }] };
  gpu.textures[0] = createTexture(gl, { format: "t", width: 4, height: 4, hasAlpha: true, mipCount: 1, blocks: opaque, mip() { throw new Error("no decode"); } }, { repeat: [false, false] });
  assert.deepEqual(modes(), [0], "the texture landed, with no new pose: opaque");
});
