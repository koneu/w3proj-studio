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

/** Largest image checked for transparency: the ones that matter (a flat white plane) are small, and a
 *  big photo-like texture isn't worth a walk over every block. */
const OPAQUE_CHECK_PIXELS = 128 * 128;

/** Whether every texel of the file's top level is fully opaque, read off the blocks without decoding. */
export function blocksOpaque(image: BlockImage): boolean {
  const top = image.levels[0];
  if (!top) return false;
  const size = blockDataSize(image.format, top.width, top.height), d = top.data;
  if (d.length < size) return false;
  const stride = image.format === "bc1" ? 8 : 16;
  for (let o = 0; o < size; o += stride) {
    if (image.format === "bc1") {
      // Three colours and transparent black (index 3) when the first end point isn't above the second.
      if ((d[o] | (d[o + 1] << 8)) > (d[o + 2] | (d[o + 3] << 8))) continue;
      const bits = d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16) | (d[o + 7] << 24);
      for (let i = 0; i < 16; i++) if (((bits >>> (i * 2)) & 3) === 3) return false;
    } else if (image.format === "bc2") {
      for (let i = 0; i < 8; i++) if (d[o + i] !== 0xff) return false;
    } else {
      const a0 = d[o], a1 = d[o + 1];
      // Eight alpha values from the two end points (or six, with 0 and 255 at the end).
      const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
      if (a0 > a1) for (let i = 1; i < 7; i++) pal[i + 1] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
      else { for (let i = 1; i < 5; i++) pal[i + 1] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0; pal[6] = 0; pal[7] = 255; }
      const lo = d[o + 2] | (d[o + 3] << 8) | (d[o + 4] << 16), hi = d[o + 5] | (d[o + 6] << 8) | (d[o + 7] << 16);
      for (let i = 0; i < 16; i++) if (pal[((i < 8 ? lo : hi) >>> ((i & 7) * 3)) & 7] !== 255) return false;
    }
  }
  return true;
}

/** Textures whose every texel is opaque (small ones only). */
const opaque = new WeakSet<WebGLTexture>();

/** Whether a texture made by createTexture is known to have no transparency at all. Unknown counts as no. */
export function isOpaqueTexture(texture: WebGLTexture | null | undefined): boolean {
  return !!texture && opaque.has(texture);
}

/** A texture for an image. It stays bound. */
export function createTexture(gl: WebGL2RenderingContext, image: DecodedImage, options: TextureOptions): WebGLTexture {
  const small = image.width * image.height <= OPAQUE_CHECK_PIXELS;
  const viaBlocks = compressed(gl, image, options);
  const texture = viaBlocks ?? decoded(gl, image, options);
  if (small && (viaBlocks && image.blocks ? blocksOpaque(image.blocks) : !viaBlocks && !image.hasAlpha)) opaque.add(texture);
  return texture;
}

/** The textures a model's drawing can touch. A Reforged layer also lists a normal map, and possibly
 *  emissive and other maps, which the shader here doesn't sample: of its slots, only the diffuse (0)
 *  and ORM (2) count. A texture anything else names, like a particle emitter, counts too. */
/** An HD layer's emissive texture (its slot 3 of [diffuse, normal, ORM, emissive, team colour, environment]), drawn
 *  as light of its own: the Ashenvale obelisk's red runes, the totem's lamp. Null for a classic layer. */
export function emissiveSlot(model: Pick<Model, "textures">, layer: { textureIds: number[] }): number | null {
  const id = layer.textureIds.length >= 4 ? layer.textureIds[3] : -1;
  const tex = model.textures[id];
  return tex && tex.replaceableId === 0 && tex.path ? id : null;
}

export function drawnTextures(model: Pick<Model, "textures" | "materials" | "particleEmitters2">): Set<number> {
  const unused = new Set<number>(), used = new Set<number>();
  for (const material of model.materials) for (const layer of material.layers) {
    // An animated layer shows the textures its track names (a Reforged flipbook: 50 frames of the diffuse,
    // and 50 normal maps that aren't drawn); a track without values could show any.
    for (const track of [layer.textureTrack, layer.slotTracks?.[2]]) {
      if (!track) continue;
      if (!track.values?.length) return new Set(model.textures.keys());
      for (const id of track.values) used.add(id);
    }
    layer.slotTracks?.forEach((track, slot) => { if (track && slot !== 0 && slot !== 2) for (const id of track.values) unused.add(id); });
    layer.textureIds.forEach((id, slot) => (slot === 0 || slot === 2 || (slot === 3 && emissiveSlot(model, layer) === id) ? used : unused).add(id));
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
