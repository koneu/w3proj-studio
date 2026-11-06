// S3TC / RGTC block decoders (BC1–BC5) to RGBA8.

export type BlockFormat = "bc1" | "bc2" | "bc3" | "bc4" | "bc5";

export function blockBytes(f: BlockFormat): number {
  return f === "bc1" || f === "bc4" ? 8 : 16;
}

export function blockDataSize(f: BlockFormat, width: number, height: number): number {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes(f);
}

function rgb565(c: number, out: number[], o: number) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
  out[o + 3] = 255;
}

/** Colour part of BC1/2/3: 16 RGBA texels into `px`. */
function colorBlock(d: Uint8Array, o: number, px: number[], allowPunchThrough: boolean) {
  const c0 = d[o] | (d[o + 1] << 8);
  const c1 = d[o + 2] | (d[o + 3] << 8);
  const pal: number[] = new Array(16);
  rgb565(c0, pal, 0);
  rgb565(c1, pal, 4);
  if (c0 > c1 || !allowPunchThrough) {
    for (let i = 0; i < 3; i++) {
      pal[8 + i] = (2 * pal[i] + pal[4 + i] + 1) / 3 | 0;
      pal[12 + i] = (pal[i] + 2 * pal[4 + i] + 1) / 3 | 0;
    }
    pal[11] = pal[15] = 255;
  } else {
    for (let i = 0; i < 3; i++) pal[8 + i] = (pal[i] + pal[4 + i]) >> 1;
    pal[11] = 255;
    pal[12] = pal[13] = pal[14] = pal[15] = 0;
  }
  const bits = d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16) | (d[o + 7] << 24);
  for (let i = 0; i < 16; i++) {
    const idx = (bits >>> (i * 2)) & 3;
    for (let k = 0; k < 4; k++) px[i * 4 + k] = pal[idx * 4 + k];
  }
}

/** BC4-style interpolated single channel: 16 values into `out[i * stride + ch]`. */
function alphaBlock(d: Uint8Array, o: number, out: number[], ch: number) {
  const a0 = d[o], a1 = d[o + 1];
  const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal[i + 1] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
  else {
    for (let i = 1; i < 5; i++) pal[i + 1] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0;
    pal[6] = 0;
    pal[7] = 255;
  }
  // 48 bits of 3-bit indices, little endian.
  const lo = d[o + 2] | (d[o + 3] << 8) | (d[o + 4] << 16);
  const hi = d[o + 5] | (d[o + 6] << 8) | (d[o + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const src = i < 8 ? lo : hi;
    out[i * 4 + ch] = pal[(src >> ((i % 8) * 3)) & 7];
  }
}

export function decodeBlocks(f: BlockFormat, data: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  const bsize = blockBytes(f);
  if (data.length < bw * bh * bsize) throw new Error(`${f} data truncated`);
  const out = new Uint8ClampedArray(width * height * 4);
  const px: number[] = new Array(64).fill(0);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * bsize;
      switch (f) {
        case "bc1":
          colorBlock(data, o, px, true);
          break;
        case "bc2":
          colorBlock(data, o + 8, px, false);
          for (let i = 0; i < 16; i++) {
            const nib = (data[o + (i >> 1)] >> ((i & 1) * 4)) & 15;
            px[i * 4 + 3] = nib * 17;
          }
          break;
        case "bc3":
          colorBlock(data, o + 8, px, false);
          alphaBlock(data, o, px, 3);
          break;
        case "bc4":
          alphaBlock(data, o, px, 0);
          for (let i = 0; i < 16; i++) { px[i * 4 + 1] = px[i * 4 + 2] = px[i * 4]; px[i * 4 + 3] = 255; }
          break;
        case "bc5":
          alphaBlock(data, o, px, 0);
          alphaBlock(data, o + 8, px, 1);
          for (let i = 0; i < 16; i++) {
            // Reconstruct Z of a tangent-space normal for display.
            const x = px[i * 4] / 127.5 - 1, y = px[i * 4 + 1] / 127.5 - 1;
            px[i * 4 + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) + 1) * 127.5);
            px[i * 4 + 3] = 255;
          }
          break;
      }
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= height) break;
        for (let x = 0; x < 4; x++) {
          const pxX = bx * 4 + x;
          if (pxX >= width) break;
          const s = (y * 4 + x) * 4, d = (py * width + pxX) * 4;
          out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
        }
      }
    }
  }
  return out;
}
