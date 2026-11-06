// Texture decoders for BLP (1/2), DDS and TGA → RGBA8 mip levels.

import { blockDataSize, decodeBlocks, type BlockFormat } from "./dxt.ts";
import { decodeJpeg } from "./jpeg.ts";

export interface Mip {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** One mip level as the file stores it. */
export interface BlockLevel {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A block-compressed image: what a GPU can read without decoding. */
export interface BlockImage {
  format: "bc1" | "bc2" | "bc3";
  levels: BlockLevel[];
}

export interface DecodedImage {
  /** Human-readable format description, e.g. "BLP1 JPEG, 8-bit alpha". */
  format: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  /** Mip levels that could be located; decoded on demand. */
  mipCount: number;
  mip(level: number): Mip;
  /** The file's own blocks, where it has any a GPU reads as they are. */
  blocks?: BlockImage;
}

/** As much as a graphics card takes. The sizes come from the file, and decoding allocates and walks them. */
const MAX_SIDE = 16384;

function checkSize(width: number, height: number) {
  if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(`image of ${width}×${height}`);
}

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const magic = (b: Uint8Array) => String.fromCharCode(b[0], b[1], b[2], b[3]);

export function decodeImage(bytes: Uint8Array, name = ""): DecodedImage {
  const m = magic(bytes);
  if (m === "BLP1") return decodeBlp1(bytes);
  if (m === "BLP2") return decodeBlp2(bytes);
  if (m === "DDS ") return decodeDds(bytes);
  if (/\.tga$/i.test(name) || looksLikeTga(bytes)) return decodeTga(bytes);
  throw new Error(`unrecognised image format (magic ${JSON.stringify(m)})`);
}

function cached(count: number, decode: (level: number) => Mip): (level: number) => Mip {
  const cache = new Map<number, Mip>();
  return (level) => {
    if (level < 0 || level >= count) throw new Error(`mip ${level} out of range`);
    let m = cache.get(level);
    if (!m) cache.set(level, (m = decode(level)));
    return m;
  };
}

/** Mip levels whose offset/size entries point inside the file. */
function mipTable(b: Uint8Array, offsetsAt: number, sizesAt: number, w: number, h: number, hasMips: boolean) {
  checkSize(w, h);
  const levels: { offset: number; size: number; width: number; height: number }[] = [];
  for (let i = 0; i < (hasMips ? 16 : 1); i++) {
    const offset = u32(b, offsetsAt + i * 4), size = u32(b, sizesAt + i * 4);
    const width = Math.max(1, w >> i), height = Math.max(1, h >> i);
    if (!size || offset + size > b.length) break;
    levels.push({ offset, size, width, height });
    if (width === 1 && height === 1) break;
  }
  return levels;
}

/** Palettized pixels + separate alpha plane (BLP1 and BLP2 share this). */
function palettized(b: Uint8Array, palAt: number, data: Uint8Array, w: number, h: number, alphaBits: number): Uint8ClampedArray {
  const n = w * h;
  if (data.length < n) throw new Error("palettized data truncated");
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = palAt + data[i] * 4;
    out[i * 4] = b[p + 2];
    out[i * 4 + 1] = b[p + 1];
    out[i * 4 + 2] = b[p];
    let a = 255;
    if (alphaBits === 8) a = data[n + i] ?? 255;
    else if (alphaBits === 4) a = (((data[n + (i >> 1)] ?? 255) >> ((i & 1) * 4)) & 15) * 17;
    else if (alphaBits === 1) a = ((data[n + (i >> 3)] ?? 255) >> (i & 7)) & 1 ? 255 : 0;
    out[i * 4 + 3] = a;
  }
  return out;
}

/** WC3 only knows 0, 1, 4 and 8 alpha bits; other header values occur in the
 *  wild and behave like the nearest lower one. */
function normalizeAlphaBits(bits: number): number {
  return bits >= 8 ? 8 : bits >= 4 ? 4 : bits >= 1 ? 1 : 0;
}

function decodeBlp1(b: Uint8Array): DecodedImage {
  const compression = u32(b, 4);
  const rawAlpha = u32(b, 8);
  const width = u32(b, 12), height = u32(b, 16);
  const hasMips = u32(b, 24) !== 0;
  const levels = mipTable(b, 28, 92, width, height, hasMips);
  if (!levels.length) throw new Error("BLP1 has no readable mip levels");

  if (compression === 0) {
    const headerSize = u32(b, 156);
    const header = b.subarray(160, 160 + headerSize);
    return {
      format: `BLP1 JPEG, ${rawAlpha ? `${rawAlpha}-bit alpha` : "no alpha"}`,
      width, height, hasAlpha: rawAlpha > 0, mipCount: levels.length,
      mip: cached(levels.length, (i) => {
        const l = levels[i];
        const jpeg = new Uint8Array(header.length + l.size);
        jpeg.set(header);
        jpeg.set(b.subarray(l.offset, l.offset + l.size), header.length);
        const img = decodeJpeg(jpeg);
        // Channels are stored as B, G, R, A without colour conversion.
        const n = l.width * l.height;
        const out = new Uint8ClampedArray(n * 4);
        for (let y = 0; y < l.height; y++)
          for (let x = 0; x < l.width; x++) {
            const s = (Math.min(y, img.height - 1) * img.width + Math.min(x, img.width - 1)) * img.components;
            const d = (y * l.width + x) * 4;
            out[d] = img.data[s + 2] ?? img.data[s];
            out[d + 1] = img.data[s + 1] ?? img.data[s];
            out[d + 2] = img.data[s];
            out[d + 3] = rawAlpha && img.components > 3 ? img.data[s + 3] : 255;
          }
        return { width: l.width, height: l.height, rgba: out };
      }),
    };
  }
  if (compression === 1) {
    const alphaBits = normalizeAlphaBits(rawAlpha);
    return {
      format: `BLP1 palettized, ${alphaBits ? `${alphaBits}-bit alpha` : "no alpha"}`,
      width, height, hasAlpha: alphaBits > 0, mipCount: levels.length,
      mip: cached(levels.length, (i) => {
        const l = levels[i];
        return { width: l.width, height: l.height, rgba: palettized(b, 156, b.subarray(l.offset, l.offset + l.size), l.width, l.height, alphaBits) };
      }),
    };
  }
  throw new Error(`unknown BLP1 compression ${compression}`);
}

function decodeBlp2(b: Uint8Array): DecodedImage {
  const type = u32(b, 4);
  const encoding = b[8], alphaDepth = b[9], alphaType = b[10], hasMips = b[11] !== 0;
  const width = u32(b, 12), height = u32(b, 16);
  const levels = mipTable(b, 20, 84, width, height, hasMips);
  if (!levels.length) throw new Error("BLP2 has no readable mip levels");
  if (type === 0) throw new Error("BLP2 JPEG is not supported");
  const slice = (i: number) => b.subarray(levels[i].offset, levels[i].offset + levels[i].size);

  let format: string;
  let blockFormat: BlockImage["format"] | undefined;
  let decode: (i: number) => Uint8ClampedArray;
  if (encoding === 1) {
    format = `BLP2 palettized, ${alphaDepth}-bit alpha`;
    decode = (i) => palettized(b, 148, slice(i), levels[i].width, levels[i].height, normalizeAlphaBits(alphaDepth));
  } else if (encoding === 2) {
    const f = alphaType === 7 ? "bc3" : alphaType === 1 ? "bc2" : "bc1";
    blockFormat = f;
    format = `BLP2 ${f === "bc1" ? "DXT1" : f === "bc2" ? "DXT3" : "DXT5"}`;
    decode = (i) => decodeBlocks(f, slice(i), levels[i].width, levels[i].height);
  } else if (encoding === 3) {
    format = "BLP2 BGRA8";
    decode = (i) => {
      const s = slice(i);
      if (s.length < levels[i].width * levels[i].height * 4) throw new Error("BGRA data truncated");
      const out = new Uint8ClampedArray(levels[i].width * levels[i].height * 4);
      for (let p = 0; p < out.length; p += 4) { out[p] = s[p + 2]; out[p + 1] = s[p + 1]; out[p + 2] = s[p]; out[p + 3] = s[p + 3]; }
      return out;
    };
  } else throw new Error(`unknown BLP2 encoding ${encoding}`);
  return {
    format, width, height, hasAlpha: alphaDepth > 0, mipCount: levels.length,
    mip: cached(levels.length, (i) => ({ width: levels[i].width, height: levels[i].height, rgba: decode(i) })),
    blocks: blockFormat && { format: blockFormat, levels: levels.map((l, i) => ({ width: l.width, height: l.height, data: slice(i) })) },
  };
}

const DXGI: Record<number, BlockFormat | "rgba" | "bgra"> = {
  70: "bc1", 71: "bc1", 72: "bc1", 73: "bc2", 74: "bc2", 75: "bc2", 76: "bc3", 77: "bc3", 78: "bc3",
  79: "bc4", 80: "bc4", 82: "bc5", 83: "bc5", 28: "rgba", 29: "rgba", 87: "bgra", 91: "bgra",
};
const FOURCC: Record<string, BlockFormat> = {
  DXT1: "bc1", DXT2: "bc2", DXT3: "bc2", DXT4: "bc3", DXT5: "bc3", ATI1: "bc4", BC4U: "bc4", ATI2: "bc5", BC5U: "bc5",
};

function decodeDds(b: Uint8Array): DecodedImage {
  const height = u32(b, 12), width = u32(b, 16);
  checkSize(width, height);
  const mipCount = Math.min(Math.max(1, u32(b, 28)), 16);
  const pfFlags = u32(b, 80);
  const fourcc = String.fromCharCode(b[84], b[85], b[86], b[87]);
  let dataAt = 128;
  let kind: BlockFormat | "rgba" | "bgra" | "masks";
  let label: string;
  if (pfFlags & 4) {
    if (fourcc === "DX10") {
      const dxgi = u32(b, 128);
      dataAt = 148;
      const k = DXGI[dxgi];
      if (!k) throw new Error(`DDS DXGI format ${dxgi} is not supported${dxgi === 98 || dxgi === 99 ? " (BC7)" : ""}`);
      kind = k;
      label = `DDS DX10 (DXGI ${dxgi})`;
    } else {
      const k = FOURCC[fourcc];
      if (!k) throw new Error(`DDS FourCC ${fourcc} is not supported`);
      kind = k;
      label = `DDS ${fourcc}`;
    }
  } else {
    kind = "masks";
    label = `DDS uncompressed ${u32(b, 88)}-bit`;
  }

  const bpp = u32(b, 88);
  if (kind === "masks" && ![8, 16, 24, 32].includes(bpp)) throw new Error(`DDS with ${bpp} bits per pixel`);
  const masks = [u32(b, 92), u32(b, 96), u32(b, 100), pfFlags & 1 ? u32(b, 104) : 0];
  const levelSize = (w: number, h: number) =>
    kind === "rgba" || kind === "bgra" ? w * h * 4 : kind === "masks" ? w * h * (bpp >> 3) : blockDataSize(kind, w, h);

  const levels: { offset: number; width: number; height: number }[] = [];
  let o = dataAt;
  for (let i = 0; i < mipCount; i++) {
    const w = Math.max(1, width >> i), h = Math.max(1, height >> i);
    const size = levelSize(w, h);
    if (o + size > b.length) break;
    levels.push({ offset: o, width: w, height: h });
    o += size;
  }
  if (!levels.length) throw new Error("DDS data truncated");

  const channel = (v: number, mask: number) => {
    if (!mask) return 255;
    const shift = Math.clz32(mask & -mask) ^ 31;
    const max = mask >>> shift;
    return Math.round((((v & mask) >>> shift) * 255) / max);
  };
  return {
    format: label, width, height,
    hasAlpha: kind === "bc2" || kind === "bc3" || kind === "rgba" || kind === "bgra" || (kind === "masks" && masks[3] !== 0) || kind === "bc1",
    mipCount: levels.length,
    mip: cached(levels.length, (i) => {
      const l = levels[i];
      const n = l.width * l.height;
      let rgba: Uint8ClampedArray;
      if (kind === "rgba" || kind === "bgra") {
        const s = b.subarray(l.offset, l.offset + n * 4);
        rgba = new Uint8ClampedArray(s);
        if (kind === "bgra") for (let p = 0; p < rgba.length; p += 4) { rgba[p] = s[p + 2]; rgba[p + 2] = s[p]; }
      } else if (kind === "masks") {
        const bytes = bpp >> 3;
        rgba = new Uint8ClampedArray(n * 4);
        for (let p = 0; p < n; p++) {
          let v = 0;
          for (let k = 0; k < bytes; k++) v |= b[l.offset + p * bytes + k] << (8 * k);
          v >>>= 0;
          for (let c = 0; c < 4; c++) rgba[p * 4 + c] = channel(v, masks[c]);
        }
      } else rgba = decodeBlocks(kind, b.subarray(l.offset), l.width, l.height);
      return { width: l.width, height: l.height, rgba };
    }),
    blocks: kind === "bc1" || kind === "bc2" || kind === "bc3" ? {
      format: kind,
      levels: levels.map((l) => ({ width: l.width, height: l.height, data: b.subarray(l.offset, l.offset + levelSize(l.width, l.height)) })),
    } : undefined,
  };
}

function looksLikeTga(b: Uint8Array): boolean {
  return b.length > 18 && [1, 2, 3, 9, 10, 11].includes(b[2]) && [8, 15, 16, 24, 32].includes(b[16]);
}

function decodeTga(b: Uint8Array): DecodedImage {
  const idLen = b[0], cmapType = b[1], type = b[2];
  const cmapFirst = b[3] | (b[4] << 8), cmapLen = b[5] | (b[6] << 8), cmapDepth = b[7];
  const width = b[12] | (b[13] << 8), height = b[14] | (b[15] << 8);
  const bpp = b[16], desc = b[17];
  const alphaBits = desc & 15;
  const topDown = (desc & 0x20) !== 0;
  const rle = type >= 9;
  const base = type & 7; // 1 colour-mapped, 2 true colour, 3 grey
  if (![1, 2, 3].includes(base)) throw new Error(`unsupported TGA type ${type}`);

  let p = 18 + idLen;
  const cmapBytes = Math.ceil(cmapDepth / 8);
  const cmap = cmapType ? b.subarray(p, p + cmapLen * cmapBytes) : null;
  p += cmapType ? cmapLen * cmapBytes : 0;

  const pixelBytes = Math.ceil(bpp / 8);
  const readColor = (src: Uint8Array, o: number, depth: number, out: Uint8ClampedArray, d: number, hasAlpha: boolean) => {
    if (depth === 8) { out[d] = out[d + 1] = out[d + 2] = src[o]; out[d + 3] = 255; }
    else if (depth === 15 || depth === 16) {
      const v = src[o] | (src[o + 1] << 8);
      out[d] = ((v >> 10) & 31) * 255 / 31; out[d + 1] = ((v >> 5) & 31) * 255 / 31; out[d + 2] = (v & 31) * 255 / 31;
      out[d + 3] = depth === 16 && hasAlpha ? (v & 0x8000 ? 255 : 0) : 255;
    } else {
      out[d] = src[o + 2]; out[d + 1] = src[o + 1]; out[d + 2] = src[o];
      out[d + 3] = depth === 32 && hasAlpha ? src[o + 3] : 255;
    }
  };

  const n = width * height;
  checkSize(width, height);
  // At best a run of 128 pixels takes two bytes. Cut-off files stay readable, so this isn't exact.
  if (n > b.length * 64) throw new Error(`TGA of ${width}×${height} in ${b.length} bytes`);
  // Decode the pixel stream (raw or RLE) into storage order.
  const stream = new Uint8Array(n * pixelBytes);
  if (rle) {
    let i = 0;
    while (i < stream.length && p < b.length) {
      const h = b[p++];
      const count = (h & 0x7f) + 1;
      if (h & 0x80) {
        const px = b.subarray(p, p + pixelBytes);
        p += pixelBytes;
        for (let k = 0; k < count && i < stream.length; k++, i += pixelBytes) stream.set(px, i);
      } else {
        const len = Math.min(count * pixelBytes, stream.length - i);
        stream.set(b.subarray(p, p + len), i);
        p += count * pixelBytes;
        i += len;
      }
    }
  } else stream.set(b.subarray(p, p + stream.length));

  const rgba = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (srcRow * width + x) * pixelBytes, d = (y * width + x) * 4;
      if (base === 1 && cmap) {
        const idx = (pixelBytes === 2 ? stream[s] | (stream[s + 1] << 8) : stream[s]) - cmapFirst;
        readColor(cmap, idx * cmapBytes, cmapDepth, rgba, d, true);
      } else readColor(stream, s, bpp, rgba, d, alphaBits > 0 || bpp === 32);
    }
  }
  const kind = base === 1 ? "colour-mapped" : base === 3 ? "greyscale" : "true colour";
  return {
    format: `TGA ${kind}${rle ? " RLE" : ""}, ${bpp}-bit`, width, height,
    hasAlpha: bpp === 32 || alphaBits > 0, mipCount: 1,
    mip: () => ({ width, height, rgba }),
  };
}
