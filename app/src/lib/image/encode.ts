// BLP1 writer with JPEG-compressed pixels, the format of the World Editor's
// minimaps (war3mapMap.blp): a baseline JPEG with four components stored as
// B, G, R, A without colour transform, one mip level. The JPEG tables (SOI,
// DQT, DHT) form the shared header; the mip holds SOF0, SOS, scan and EOI.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
];

// JPEG standard (Annex K) luminance quantization and Huffman tables.
const BASE_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
  0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
  0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
  0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
  0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
  0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
  0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
  0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** Code and length per symbol from a (bits, values) table. */
function huffmanCodes(bits: number[], vals: number[]): { code: number[]; len: number[] } {
  const code: number[] = [], len: number[] = [];
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]; i++) { code[vals[k]] = c++; len[vals[k]] = l; k++; }
    c <<= 1;
  }
  return { code, len };
}

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(code: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.n === 8) this.flushByte();
    }
  }
  private flushByte() {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0); // byte stuffing
    this.acc = 0;
    this.n = 0;
  }
  finish(): number[] {
    while (this.n) this.write(1, 1); // pad with ones
    return this.bytes;
  }
}

// Forward DCT basis: COS[u * 8 + x] = C(u)/2 · cos((2x + 1)uπ / 16).
const COS = new Float64Array(64);
for (let u = 0; u < 8; u++)
  for (let x = 0; x < 8; x++) COS[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

/** IJG quality scaling of the base table (1–100). */
function quantTable(quality: number): number[] {
  const q = Math.min(100, Math.max(1, quality));
  const s = q < 50 ? 5000 / q : 200 - 2 * q;
  return BASE_QUANT.map((v) => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
}

const segment = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];

/** A four-component baseline JPEG split into tables and frame+scan. `pixels`
 *  holds four bytes per pixel, written as components 1–4 in that order. */
export function encodeJpeg4(width: number, height: number, pixels: Uint8Array, quality = 85): { tables: Uint8Array; frame: Uint8Array } {
  const qt = quantTable(quality);
  const tables = [
    0xff, 0xd8,
    ...segment(0xdb, [0, ...ZIGZAG.map((z) => qt[z])]),
    ...segment(0xc4, [0x00, ...DC_BITS, ...DC_VALS]),
    ...segment(0xc4, [0x10, ...AC_BITS, ...AC_VALS]),
  ];
  const dc = huffmanCodes(DC_BITS, DC_VALS), ac = huffmanCodes(AC_BITS, AC_VALS);
  const out = new BitWriter();
  const pred = [0, 0, 0, 0];
  const block = new Float64Array(64), tmp = new Float64Array(64), coef = new Int32Array(64);
  const category = (v: number) => (v === 0 ? 0 : 32 - Math.clz32(Math.abs(v)));
  const bitsOf = (v: number, n: number) => (v >= 0 ? v : v + (1 << n) - 1);
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let comp = 0; comp < 4; comp++) {
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const sx = Math.min(width - 1, bx + x), sy = Math.min(height - 1, by + y);
            block[y * 8 + x] = pixels[(sy * width + sx) * 4 + comp] - 128;
          }
        // Separable 2-D DCT: rows, then columns.
        for (let y = 0; y < 8; y++)
          for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let x = 0; x < 8; x++) s += COS[u * 8 + x] * block[y * 8 + x];
            tmp[y * 8 + u] = s;
          }
        for (let u = 0; u < 8; u++)
          for (let v = 0; v < 8; v++) {
            let s = 0;
            for (let y = 0; y < 8; y++) s += COS[v * 8 + y] * tmp[y * 8 + u];
            coef[v * 8 + u] = Math.round(s / qt[v * 8 + u]);
          }
        // DC difference, then run-length coded AC in zigzag order.
        const diff = coef[0] - pred[comp];
        pred[comp] = coef[0];
        const dcat = category(diff);
        out.write(dc.code[dcat], dc.len[dcat]);
        if (dcat) out.write(bitsOf(diff, dcat), dcat);
        let run = 0;
        for (let k = 1; k < 64; k++) {
          const v = coef[ZIGZAG[k]];
          if (v === 0) { run++; continue; }
          while (run > 15) { out.write(ac.code[0xf0], ac.len[0xf0]); run -= 16; }
          const cat = category(v), sym = (run << 4) | cat;
          out.write(ac.code[sym], ac.len[sym]);
          out.write(bitsOf(v, cat), cat);
          run = 0;
        }
        if (run) out.write(ac.code[0], ac.len[0]);
      }
    }
  }
  const comps = [1, 2, 3, 4];
  const frame = [
    ...segment(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 4, ...comps.flatMap((id) => [id, 0x11, 0])]),
    ...segment(0xda, [4, ...comps.flatMap((id) => [id, 0x00]), 0, 63, 0]),
    ...out.finish(),
    0xff, 0xd9,
  ];
  return { tables: Uint8Array.from(tables), frame: Uint8Array.from(frame) };
}

/** BLP1 with one JPEG mip level and no alpha, like the World Editor's
 *  minimaps. `rgba` rows run top to bottom. */
export function encodeBlp1Jpeg(width: number, height: number, rgba: ArrayLike<number>, quality = 85): Uint8Array {
  const bgra = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    bgra[i * 4] = rgba[i * 4 + 2];
    bgra[i * 4 + 1] = rgba[i * 4 + 1];
    bgra[i * 4 + 2] = rgba[i * 4];
    bgra[i * 4 + 3] = 255;
  }
  const { tables, frame } = encodeJpeg4(width, height, bgra, quality);
  const out = new Uint8Array(160 + tables.length + frame.length);
  const v = new DataView(out.buffer);
  out.set([0x42, 0x4c, 0x50, 0x31]); // "BLP1"
  v.setUint32(4, 0, true); // JPEG
  v.setUint32(8, 0, true); // alpha bits
  v.setUint32(12, width, true);
  v.setUint32(16, height, true);
  v.setUint32(20, 3, true); // picture type, as the World Editor writes it
  v.setUint32(24, 0, true); // no mipmaps
  v.setUint32(28, 160 + tables.length, true); // mip 0 offset
  v.setUint32(92, frame.length, true); // mip 0 size
  v.setUint32(156, tables.length, true);
  out.set(tables, 160);
  out.set(frame, 160 + tables.length);
  return out;
}
