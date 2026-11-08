// Compares two pictures (PNG) of the same size, e.g. Studio's terrain view (app-drive.mjs --view-size 1184x844 --shot)
// and the World Editor's (we-drive.mjs --shot): the mean colour of each region in both, how far apart those are, the
// mean absolute difference of the pixels, and a picture of the differences. The exit code says whether every region
// is within the tolerance. Plain JavaScript (node's zlib), no Pillow.
//
//   node scripts/pic-compare.mjs a.png b.png [options]
//
// Options:
//   --region [NAME=]X,Y,W,H   a region in pixels (repeatable); without any region (and without --sample) the whole picture
//   --sample            named regions: the whole picture ("all") and a 3x3 grid of it (top-left, top, top-right, left,
//                       centre, right, bottom-left, bottom, bottom-right)
//   --diff FILE.png     write the difference picture: per pixel |a - b| for each channel, times 4 (so small differences
//                       show), regions outlined in yellow
//   --tolerance T       the largest mean absolute difference (0..255, over the channels) a region may have (default 8)
//
// Prints one JSON line per region ({ region, rect, meanA, meanB, meanDelta, mad, within }), then a summary
// ({ size, tolerance, worst, within, diff }). Exit code: 0 all regions within the tolerance, 1 not, 2 the pictures
// can't be compared (unreadable, different sizes, a region outside them).

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = "89504e470d0a1a0a";
/** More pixels than any screen picture: refused rather than allocated. */
const MAX_PIXELS = 1 << 26;

/** Decodes a PNG (greyscale, RGB, palette, with alpha or not; 8 or 16 bits; not interlaced) to { width, height, rgba }. */
export function decodePng(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 8 || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== SIGNATURE) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, head = null, palette = null, trns = null;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (at + 12 + len > bytes.length) throw new Error(`the PNG's ${type} chunk runs past its end`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      if (len < 13) throw new Error("a short IHDR");
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      head = { width: d.getUint32(0), height: d.getUint32(4), depth: data[8], colour: data[9], interlace: data[12] };
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (!head) throw new Error("no IHDR in the PNG");
  const { width, height, depth, colour, interlace } = head;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (!channels) throw new Error(`PNG colour type ${colour} isn't one`);
  if (depth !== 8 && depth !== 16) throw new Error(`PNG bit depth ${depth} isn't supported (8 or 16)`);
  if (colour === 3 && (depth !== 8 || !palette)) throw new Error("a palette PNG without its palette or not 8 bits");
  if (interlace) throw new Error("interlaced PNGs aren't supported");
  if (!width || !height || width * height > MAX_PIXELS) throw new Error(`a PNG of ${width}x${height} pixels isn't taken`);
  if (!idat.length) throw new Error("no pixels (IDAT) in the PNG");
  const bpp = channels * (depth / 8), stride = width * bpp;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 1 });
  } catch (e) {
    throw new Error(`the PNG's pixels can't be unpacked: ${e.message}`);
  }
  if (raw.length < (stride + 1) * height) throw new Error("the PNG's pixels are cut short");
  // Undo the row filters in place: each row starts with its filter type.
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? px[row + i - bpp] : 0, b = y ? px[up + i] : 0, c = y && i >= bpp ? px[up + i - bpp] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`PNG row filter ${filter} isn't one`);
      px[row + i] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  const step = depth / 8; // 16 bits: the high byte
  for (let p = 0; p < width * height; p++) {
    const s = p * bpp, o = p * 4;
    const ch = (k) => px[s + k * step];
    if (colour === 0 || colour === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = ch(0);
      rgba[o + 3] = colour === 4 ? ch(1) : 255;
    } else if (colour === 2 || colour === 6) {
      rgba[o] = ch(0); rgba[o + 1] = ch(1); rgba[o + 2] = ch(2);
      rgba[o + 3] = colour === 6 ? ch(3) : 255;
    } else {
      const i = px[s];
      if (i * 3 + 2 >= palette.length) throw new Error(`palette index ${i} past the PNG's palette`);
      rgba[o] = palette[i * 3]; rgba[o + 1] = palette[i * 3 + 1]; rgba[o + 2] = palette[i * 3 + 2];
      rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
    }
  }
  return { width, height, rgba };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Encodes RGBA pixels as an 8-bit RGBA PNG (no row filters). */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "latin1");
    b.set(data, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from(SIGNATURE, "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The named regions of --sample: the whole picture and a 3x3 grid. */
export function sampleRegions(width, height) {
  const xs = [0, Math.round(width / 3), Math.round((2 * width) / 3), width];
  const ys = [0, Math.round(height / 3), Math.round((2 * height) / 3), height];
  const names = [["top-left", "top", "top-right"], ["left", "centre", "right"], ["bottom-left", "bottom", "bottom-right"]];
  const out = [{ name: "all", rect: [0, 0, width, height] }];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push({ name: names[r][c], rect: [xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]] });
  return out;
}

/** "[NAME=]X,Y,W,H" as { name, rect }. */
export function parseRegion(spec) {
  const eq = spec.indexOf("=");
  const name = eq < 0 ? spec : spec.slice(0, eq), nums = eq < 0 ? spec : spec.slice(eq + 1);
  const rect = nums.split(",").map((s) => Number(s.trim()));
  if (rect.length !== 4 || rect.some((v) => !Number.isInteger(v) || v < 0) || rect[2] < 1 || rect[3] < 1) {
    throw new Error(`a region is [NAME=]X,Y,W,H in whole pixels, not ${spec}`);
  }
  return { name, rect };
}

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Compares two decoded pictures in each region: mean colour (RGB, 0..255) of each, the difference of those means, and
 * the mean absolute difference of the pixels (over pixels and the three channels). Alpha is left out.
 */
export function compareRegions(a, b, regions) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`the pictures differ in size: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  return regions.map(({ name, rect }) => {
    const [x0, y0, w, h] = rect;
    if (x0 + w > a.width || y0 + h > a.height) throw new Error(`the region ${name} (${rect.join(",")}) lies outside the ${a.width}x${a.height} pictures`);
    const sa = [0, 0, 0], sb = [0, 0, 0];
    let abs = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const o = (y * a.width + x) * 4;
        for (let k = 0; k < 3; k++) {
          sa[k] += a.rgba[o + k];
          sb[k] += b.rgba[o + k];
          abs += Math.abs(a.rgba[o + k] - b.rgba[o + k]);
        }
      }
    }
    const n = w * h;
    const meanA = sa.map((s) => r2(s / n)), meanB = sb.map((s) => r2(s / n));
    return { region: name, rect, meanA, meanB, meanDelta: meanA.map((v, k) => r2(meanB[k] - v)), mad: r2(abs / (n * 3)) };
  });
}

/** The difference picture: |a - b| per channel times 4, opaque, with the regions' outlines in yellow. */
export function diffPicture(a, b, regions = []) {
  const out = new Uint8Array(a.width * a.height * 4);
  for (let p = 0; p < a.width * a.height; p++) {
    const o = p * 4;
    for (let k = 0; k < 3; k++) out[o + k] = Math.min(255, Math.abs(a.rgba[o + k] - b.rgba[o + k]) * 4);
    out[o + 3] = 255;
  }
  const mark = (x, y) => { const o = (y * a.width + x) * 4; out[o] = 255; out[o + 1] = 230; out[o + 2] = 0; };
  for (const { rect: [x0, y0, w, h] } of regions) {
    if (w === a.width && h === a.height) continue;
    for (let x = x0; x < x0 + w; x++) { mark(x, y0); mark(x, y0 + h - 1); }
    for (let y = y0; y < y0 + h; y++) { mark(x0, y); mark(x0 + w - 1, y); }
  }
  return { width: a.width, height: a.height, rgba: out };
}

export function parseArgs(argv) {
  const opts = { files: [], regions: [], sample: false, diff: null, tolerance: 8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--region") opts.regions.push(parseRegion(value()));
    else if (a === "--sample") opts.sample = true;
    else if (a === "--diff") opts.diff = value();
    else if (a === "--tolerance") {
      opts.tolerance = Number(value());
      if (!(opts.tolerance >= 0)) throw new Error("--tolerance wants a number from 0 to 255");
    } else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a} (see the top of pic-compare.mjs)`);
    else opts.files.push(a);
  }
  if (!opts.help && opts.files.length !== 2) throw new Error("pic-compare wants two pictures");
  return opts;
}

/** Runs the comparison; returns the exit code (0 within, 1 not), printing JSON lines through `print`. */
export function run(opts, print = (o) => console.log(JSON.stringify(o))) {
  const [a, b] = opts.files.map((f) => {
    try { return decodePng(readFileSync(f)); } catch (e) { throw new Error(`${f}: ${e.message}`); }
  });
  const regions = [...(opts.sample ? sampleRegions(a.width, a.height) : []), ...opts.regions];
  if (!regions.length) regions.push({ name: "all", rect: [0, 0, a.width, a.height] });
  const results = compareRegions(a, b, regions);
  let within = true, worst = null;
  for (const r of results) {
    r.within = r.mad <= opts.tolerance;
    within &&= r.within;
    if (!worst || r.mad > worst.mad) worst = { region: r.region, mad: r.mad };
    print(r);
  }
  if (opts.diff) writeFileSync(opts.diff, encodePng(a.width, a.height, diffPicture(a, b, regions).rgba));
  print({ size: [a.width, a.height], tolerance: opts.tolerance, worst, within, diff: opts.diff });
  return within ? 0 : 1;
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "pic-compare.mjs") {
  let code;
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log("usage: node scripts/pic-compare.mjs a.png b.png [--region [NAME=]X,Y,W,H]... [--sample] [--diff FILE] [--tolerance T]");
      code = 0;
    } else code = run(opts);
  } catch (e) {
    console.error(`pic-compare: ${e.message}`);
    code = 2;
  }
  process.exit(code);
}
