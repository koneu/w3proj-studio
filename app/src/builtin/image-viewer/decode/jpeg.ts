// Minimal JPEG decoder that returns raw component samples.
//
// BLP1 textures store 4-channel (BGRA) JPEGs without any colour transform.
// Browsers treat 4-channel JPEGs as CMYK, so BLP needs its own decoder.
// Supports Huffman baseline, extended and progressive JPEG (SOF0/1/2) with
// any sampling factors and restart intervals. Arithmetic coding is rejected.
//
// Scans accumulate quantised coefficients per block; the inverse DCT runs
// once at the end, which serves baseline and progressive alike.

export interface JpegImage {
  width: number;
  height: number;
  components: number;
  /** Interleaved samples, `components` bytes per pixel. */
  data: Uint8Array;
}

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
]);

// IDCT basis: COS[x * 8 + u] = C(u)/2 * cos((2x + 1) u π / 16)
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++)
  for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

interface Huffman {
  maxcode: Int32Array; // per length 1..16, -1 if none
  valptr: Int32Array;
  mincode: Int32Array;
  values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1];
    if (n) {
      valptr[l] = k;
      mincode[l] = code;
      code += n;
      k += n;
      maxcode[l] = code - 1;
    }
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, values };
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Quantised coefficients in natural order, 64 per block. */
  coeffs: Int32Array;
  pred: number;
}

interface Scan {
  comps: Component[];
  ss: number;
  se: number;
  ah: number;
  al: number;
  progressive: boolean;
}

export function decodeJpeg(buf: Uint8Array): JpegImage {
  const qt: Int32Array[] = [];
  const dcTables: Huffman[] = [];
  const acTables: Huffman[] = [];
  let comps: Component[] = [];
  let width = 0, height = 0, hmax = 1, vmax = 1, mcusX = 0, mcusY = 0;
  let restartInterval = 0;
  let progressive = false;
  let frameSeen = false;
  const u16 = (o: number) => (buf[o] << 8) | buf[o + 1];

  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a JPEG (missing SOI)");
  let p = 2;

  while (p < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const marker = buf[p + 1];
    p += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      if (marker === 0xff) p--;
      continue;
    }
    if (marker === 0xd9) break; // EOI
    const len = u16(p);
    const seg = p + 2, end = p + len;
    switch (marker) {
      case 0xdb: { // DQT
        let o = seg;
        while (o < end) {
          const pq = buf[o] >> 4, tq = buf[o] & 15;
          o++;
          const t = new Int32Array(64); // natural order
          for (let i = 0; i < 64; i++) {
            t[ZIGZAG[i]] = pq ? u16(o) : buf[o];
            o += pq ? 2 : 1;
          }
          qt[tq] = t;
        }
        break;
      }
      case 0xc4: { // DHT
        let o = seg;
        while (o < end) {
          const tc = buf[o] >> 4, th = buf[o] & 15;
          const counts = buf.subarray(o + 1, o + 17);
          const total = counts.reduce((a, b) => a + b, 0);
          const values = buf.slice(o + 17, o + 17 + total);
          (tc ? acTables : dcTables)[th] = buildHuffman(counts, values);
          o += 17 + total;
        }
        break;
      }
      case 0xc0:
      case 0xc1:
      case 0xc2: { // SOF baseline / extended / progressive
        if (buf[seg] !== 8) throw new Error(`unsupported JPEG precision ${buf[seg]}`);
        progressive = marker === 0xc2;
        height = u16(seg + 1);
        width = u16(seg + 3);
        const n = buf[seg + 5];
        comps = [];
        for (let i = 0; i < n; i++) {
          const o = seg + 6 + i * 3;
          comps.push({ id: buf[o], h: buf[o + 1] >> 4 || 1, v: buf[o + 1] & 15 || 1, tq: buf[o + 2], td: 0, ta: 0, blocksPerLine: 0, blocksPerColumn: 0, coeffs: new Int32Array(0), pred: 0 });
        }
        hmax = Math.max(...comps.map((c) => c.h));
        vmax = Math.max(...comps.map((c) => c.v));
        mcusX = Math.ceil(width / (8 * hmax));
        mcusY = Math.ceil(height / (8 * vmax));
        for (const c of comps) {
          c.blocksPerLine = mcusX * c.h;
          c.blocksPerColumn = mcusY * c.v;
          c.coeffs = new Int32Array(c.blocksPerLine * c.blocksPerColumn * 64);
        }
        frameSeen = true;
        break;
      }
      case 0xc3: case 0xc5: case 0xc6: case 0xc7: case 0xc9: case 0xca: case 0xcb: case 0xcd: case 0xce: case 0xcf:
        throw new Error(`unsupported JPEG process (SOF 0x${marker.toString(16)})`);
      case 0xdd: // DRI
        restartInterval = u16(seg);
        break;
      case 0xda: { // SOS
        if (!frameSeen) throw new Error("scan before frame header");
        const ns = buf[seg];
        const scomps: Component[] = [];
        for (let i = 0; i < ns; i++) {
          const id = buf[seg + 1 + i * 2], tables = buf[seg + 2 + i * 2];
          const c = comps.find((c) => c.id === id);
          if (!c) throw new Error(`scan references unknown component ${id}`);
          c.td = tables >> 4;
          c.ta = tables & 15;
          scomps.push(c);
        }
        const o = seg + 1 + ns * 2;
        const scan: Scan = { comps: scomps, ss: buf[o], se: buf[o + 1], ah: buf[o + 2] >> 4, al: buf[o + 2] & 15, progressive };
        if (!progressive) { scan.ss = 0; scan.se = 63; scan.ah = scan.al = 0; }
        p = decodeScan(buf, end, scan, dcTables, acTables, restartInterval, mcusX, mcusY, width, height, hmax, vmax);
        continue;
      }
      default:
        break; // APPn, COM, …
    }
    p = end;
  }
  if (!frameSeen) throw new Error("JPEG has no frame header");

  // Dequantise + inverse DCT into per-component planes.
  const planes = comps.map((c) => {
    const q = qt[c.tq];
    if (!q) throw new Error("missing quantisation table");
    const stride = c.blocksPerLine * 8;
    const plane = new Uint8Array(stride * c.blocksPerColumn * 8);
    const tmp = new Float64Array(64);
    for (let row = 0; row < c.blocksPerColumn; row++)
      for (let col = 0; col < c.blocksPerLine; col++) {
        const b = (row * c.blocksPerLine + col) * 64;
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            let s = 0;
            for (let u = 0; u < 8; u++) {
              const v = c.coeffs[b + y * 8 + u];
              if (v) s += COS[x * 8 + u] * v * q[y * 8 + u];
            }
            tmp[y * 8 + x] = s;
          }
        const base = row * 8 * stride + col * 8;
        for (let x = 0; x < 8; x++)
          for (let y = 0; y < 8; y++) {
            let s = 0;
            for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x];
            const val = Math.round(s + 128);
            plane[base + y * stride + x] = val < 0 ? 0 : val > 255 ? 255 : val;
          }
      }
    return plane;
  });

  // Upsample and interleave.
  const n = comps.length;
  const out = new Uint8Array(width * height * n);
  for (let ci = 0; ci < n; ci++) {
    const c = comps[ci], plane = planes[ci];
    const stride = c.blocksPerLine * 8;
    const sx = c.h / hmax, sy = c.v / vmax;
    for (let y = 0; y < height; y++) {
      const row = ((y * sy) | 0) * stride;
      for (let x = 0; x < width; x++) out[(y * width + x) * n + ci] = plane[row + ((x * sx) | 0)];
    }
  }
  return { width, height, components: n, data: out };
}

function decodeScan(
  buf: Uint8Array, start: number, scan: Scan, dcTables: Huffman[], acTables: Huffman[],
  restartInterval: number, mcusX: number, mcusY: number, width: number, height: number, hmax: number, vmax: number,
): number {
  let pos = start, bitBuf = 0, bitCnt = 0, eobrun = 0;
  const readBit = (): number => {
    if (bitCnt === 0) {
      let b = buf[pos];
      if (b === 0xff) {
        const next = buf[pos + 1];
        if (next === 0) pos += 2;
        else b = 0; // hit a marker: feed zeros
      } else if (pos < buf.length) pos++;
      else b = 0;
      bitBuf = b;
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const receive = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };
  const extend = (v: number, n: number) => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decode = (t: Huffman | undefined): number => {
    if (!t) throw new Error("missing Huffman table");
    let code = readBit(), l = 1;
    while (code > t.maxcode[l]) {
      code = (code << 1) | readBit();
      if (++l > 16) throw new Error("bad Huffman code");
    }
    return t.values[t.valptr[l] + code - t.mincode[l]];
  };

  const { ss, se, ah, al } = scan;

  // Each decoder fills one block at offset `b` of component `c`.
  const baseline = (c: Component, b: number) => {
    const co = c.coeffs;
    const t = decode(dcTables[c.td]);
    c.pred += extend(receive(t), t);
    co[b] = c.pred;
    const ac = acTables[c.ta];
    for (let k = 1; k < 64; ) {
      const rs = decode(ac);
      const r = rs >> 4, s = rs & 15;
      if (s === 0) {
        if (r !== 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      co[b + ZIGZAG[k]] = extend(receive(s), s);
      k++;
    }
  };
  const dcFirst = (c: Component, b: number) => {
    const t = decode(dcTables[c.td]);
    c.pred += extend(receive(t), t);
    c.coeffs[b] = c.pred * (1 << al);
  };
  const dcRefine = (c: Component, b: number) => {
    if (readBit()) c.coeffs[b] |= 1 << al;
  };
  const acFirst = (c: Component, b: number) => {
    if (eobrun > 0) { eobrun--; return; }
    const ac = acTables[c.ta];
    for (let k = ss; k <= se; ) {
      const rs = decode(ac);
      const r = rs >> 4, s = rs & 15;
      if (s === 0) {
        if (r < 15) {
          eobrun = (1 << r) - 1;
          if (r) eobrun += receive(r);
          break;
        }
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      c.coeffs[b + ZIGZAG[k]] = extend(receive(s), s) * (1 << al);
      k++;
    }
  };
  const acRefine = (c: Component, b: number) => {
    // Mirrors libjpeg's decode_mcu_AC_refine.
    const co = c.coeffs;
    const p1 = 1 << al, m1 = -1 << al;
    const refine = (z: number) => {
      if (readBit() && (co[z] & p1) === 0) co[z] += co[z] >= 0 ? p1 : m1;
    };
    let k = ss;
    if (eobrun <= 0) {
      const ac = acTables[c.ta];
      for (; k <= se; k++) {
        const rs = decode(ac);
        let r = rs >> 4;
        let s = rs & 15;
        if (s) s = readBit() ? p1 : m1;
        else if (r !== 15) {
          eobrun = 1 << r;
          if (r) eobrun += receive(r);
          break;
        }
        do {
          const z = b + ZIGZAG[k];
          if (co[z] !== 0) refine(z);
          else if (--r < 0) break;
          k++;
        } while (k <= se);
        if (s && k <= 63) co[b + ZIGZAG[k]] = s;
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const z = b + ZIGZAG[k];
        if (co[z] !== 0) refine(z);
      }
      eobrun--;
    }
  };

  const block: (c: Component, b: number) => void = !scan.progressive
    ? baseline
    : ss === 0
      ? (ah === 0 ? dcFirst : dcRefine)
      : (ah === 0 ? acFirst : acRefine);

  const restart = () => {
    bitCnt = 0;
    eobrun = 0;
    if (buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7) pos += 2;
    for (const c of scan.comps) c.pred = 0;
  };
  const at = (c: Component, row: number, col: number) => (row * c.blocksPerLine + col) * 64;

  for (const c of scan.comps) c.pred = 0;
  let n = 0;
  if (scan.comps.length === 1) {
    // Non-interleaved: the component's own block grid, clipped to the image.
    const c = scan.comps[0];
    const bw = Math.ceil(Math.ceil((width * c.h) / hmax) / 8);
    const bh = Math.ceil(Math.ceil((height * c.v) / vmax) / 8);
    for (let row = 0; row < bh; row++)
      for (let col = 0; col < bw; col++) {
        if (restartInterval && n && n % restartInterval === 0) restart();
        block(c, at(c, row, col));
        n++;
      }
  } else {
    for (let my = 0; my < mcusY; my++)
      for (let mx = 0; mx < mcusX; mx++) {
        if (restartInterval && n && n % restartInterval === 0) restart();
        for (const c of scan.comps)
          for (let v = 0; v < c.v; v++)
            for (let h = 0; h < c.h; h++) block(c, at(c, my * c.v + v, mx * c.h + h));
        n++;
      }
  }

  // Continue parsing at the next real marker.
  while (pos < buf.length - 1 && !(buf[pos] === 0xff && buf[pos + 1] !== 0 && !(buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7))) pos++;
  return pos;
}
