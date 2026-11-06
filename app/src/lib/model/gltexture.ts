// One way onto the GPU for a decoded image. Block-compressed files go as they are, with the mip levels
// they ship: the GPU reads them natively, while decoding a Reforged texture here takes tens of
// milliseconds on the UI thread, hundreds of times over when a map opens. Anything else, or a GPU
// without S3TC, goes through the decoder and `generateMipmap`.

import { blockDataSize } from "../image/dxt";
import type { BlockImage, BlockLevel, DecodedImage } from "../image/index";
import type { Model } from "./mdx";

const S3TC_FORMAT = { bc1: "COMPRESSED_RGBA_S3TC_DXT1_EXT", bc2: "COMPRESSED_RGBA_S3TC_DXT3_EXT", bc3: "COMPRESSED_RGBA_S3TC_DXT5_EXT" } as const;

export interface TextureOptions {
  /** Repeat rather than clamp, along S and T. */
  repeat: [boolean, boolean];
  /** The coarsest mip level to use: deeper ones would blend what mustn't blend. */
  maxLevel?: number;
}

/** Formats a GL context has taken once, or refused. Asking is a round trip to the GPU process, which
 *  over hundreds of textures adds up; the levels are checked beforehand, so one answer per format does. */
const answers = new WeakMap<WebGL2RenderingContext, Map<BlockImage["format"], boolean>>();

/** WebGL's rule for the lower levels of an S3TC texture: a multiple of 4, or the last 1 or 2. */
const blockSized = (n: number) => n % 4 === 0 || n < 4;

/** The levels WebGL takes: from the top, as far as each has the right size and enough data. Empty
 *  when the top level itself can't go, which leaves the decoder. */
export function uploadableLevels(image: BlockImage): BlockLevel[] {
  const out: BlockLevel[] = [];
  for (const [i, l] of image.levels.entries()) {
    const top = image.levels[0];
    const rightSize = l.width === (top.width >> i || 1) && l.height === (top.height >> i || 1);
    const legal = i ? blockSized(l.width) && blockSized(l.height) : l.width % 4 === 0 && l.height % 4 === 0;
    const size = blockDataSize(image.format, l.width, l.height);
    if (!l.width || !l.height || !rightSize || !legal || l.data.length < size) break;
    out.push({ ...l, data: l.data.subarray(0, size) });
  }
  return out;
}

function parameters(gl: WebGL2RenderingContext, { repeat }: TextureOptions) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat[0] ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat[1] ? gl.REPEAT : gl.CLAMP_TO_EDGE);
}

function compressed(gl: WebGL2RenderingContext, image: DecodedImage, options: TextureOptions): WebGLTexture | null {
  const blocks = image.blocks, s3tc = blocks && gl.getExtension("WEBGL_compressed_texture_s3tc");
  if (!blocks || !s3tc) return null;
  let known = answers.get(gl);
  if (!known) answers.set(gl, (known = new Map()));
  const answer = known.get(blocks.format);
  const levels = answer === false ? [] : uploadableLevels(blocks);
  if (!levels.length) return null;
  // Whoever came before: only this upload's errors count.
  if (answer === undefined) for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++);
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const format = s3tc[S3TC_FORMAT[blocks.format]];
  levels.forEach((l, i) => gl.compressedTexImage2D(gl.TEXTURE_2D, i, format, l.width, l.height, 0, l.data));
  // A chain that stops early would otherwise leave the texture incomplete: black.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, Math.min(levels.length - 1, options.maxLevel ?? Infinity));
  parameters(gl, options);
  if (answer) return texture;
  const taken = gl.getError() === gl.NO_ERROR;
  known.set(blocks.format, taken);
  if (taken) return texture;
  gl.deleteTexture(texture);
  return null;
}

function decoded(gl: WebGL2RenderingContext, image: DecodedImage, options: TextureOptions): WebGLTexture {
  const img = image.mip(0), texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength));
  gl.generateMipmap(gl.TEXTURE_2D);
  if (options.maxLevel !== undefined) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, options.maxLevel);
  parameters(gl, options);
  return texture;
}

/** A texture for an image. It stays bound. */
export function createTexture(gl: WebGL2RenderingContext, image: DecodedImage, options: TextureOptions): WebGLTexture {
  return compressed(gl, image, options) ?? decoded(gl, image, options);
}

/** The textures a model's drawing can touch. A Reforged layer also lists a normal map, and possibly
 *  emissive and other maps, which the shader here doesn't sample: of its slots, only the diffuse (0)
 *  and ORM (2) count. A texture anything else names, like a particle emitter, counts too. */
export function drawnTextures(model: Pick<Model, "textures" | "materials" | "particleEmitters2">): Set<number> {
  const unused = new Set<number>(), used = new Set<number>();
  for (const material of model.materials) for (const layer of material.layers) {
    // Which texture an animated layer shows is only known while it plays.
    if (layer.textureTrack) return new Set(model.textures.keys());
    layer.textureIds.forEach((id, slot) => (slot === 0 || slot === 2 ? used : unused).add(id));
  }
  for (const emitter of model.particleEmitters2) used.add(emitter.textureId);
  for (const id of used) unused.delete(id);
  return new Set([...model.textures.keys()].filter((i) => !unused.has(i)));
}

/** The first mip level at least `height` tall: the cheapest one that's still sharp enough. */
export function levelFor(image: Pick<DecodedImage, "height" | "mipCount">, height: number): number {
  let level = 0;
  while (level + 1 < image.mipCount && image.height >> (level + 1) >= height) level++;
  return level;
}
