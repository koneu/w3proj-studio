// pic-compare.mjs: its PNG reader against the app's PNG writer and against rows written with each of PNG's filters,
// the region means and differences, the difference picture, and the exit code by the tolerance.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { deflateSync } from "node:zlib";
import { crc32, encodePng as appEncodePng } from "../src/lib/image/png";
import { compareRegions, decodePng, diffPicture, encodePng, parseArgs, parseRegion, run, sampleRegions } from "./pic-compare.mjs";

/** A picture whose pixels differ everywhere (so a wrong filter or offset shows). */
function pattern(width, height, seed = 0) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + seed * 11 + ((i >> 5) * 13)) & 255;
  return rgba;
}

function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  b.set(data, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

/** A PNG of RGB rows written with filter `filter(y)` (the encoder's side of PNG's filters, written out here). */
function filteredRgbPng(width, height, rgb, filter) {
  const bpp = 3, stride = width * 3, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filter(y);
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = rgb[y * stride + i];
      const a = i >= bpp ? rgb[y * stride + i - bpp] : 0, b = y ? rgb[(y - 1) * stride + i] : 0;
      const c = y && i >= bpp ? rgb[(y - 1) * stride + i - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("decodePng reads what the app's PNG writer writes, compressed or stored", async () => {
  const rgba = pattern(7, 5);
  for (const compress of [true, false]) {
    const got = decodePng(await appEncodePng(7, 5, rgba, { compress }));
    assert.equal(got.width, 7);
    assert.equal(got.height, 5);
    assert.deepEqual([...got.rgba], [...rgba], `compress ${compress}`);
  }
});

test("decodePng undoes each of PNG's row filters (RGB, no alpha: opaque)", () => {
  const width = 6, height = 10, rgb = pattern(width, height, 3).subarray(0, width * height * 3);
  const got = decodePng(filteredRgbPng(width, height, rgb, (y) => y % 5));
  for (let p = 0; p < width * height; p++) {
    assert.deepEqual([...got.rgba.subarray(p * 4, p * 4 + 4)], [rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2], 255], `pixel ${p}`);
  }
});

test("decodePng refuses what isn't a PNG it can read, without hanging", () => {
  assert.throws(() => decodePng(Buffer.from("hello world")), /not a PNG/);
  const good = filteredRgbPng(4, 4, pattern(4, 4).subarray(0, 48), () => 0);
  assert.throws(() => decodePng(good.subarray(0, 40)), /no pixels/);
  assert.throws(() => decodePng(good.subarray(0, 50)), /past its end/);
  // A whole IDAT whose deflate stream stops early.
  const ihdr0 = good.subarray(8, 33), idatLen = good.readUInt32BE(33), stream = good.subarray(41, 41 + idatLen);
  const cut = Buffer.concat([good.subarray(0, 8), ihdr0, chunk("IDAT", stream.subarray(0, stream.length - 6)), chunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(cut), /can't be unpacked|cut short/);
  const badFilter = Buffer.from(good);
  // A filter type of 9 in the first row: rewrite the IDAT.
  const raw = Buffer.alloc((12 + 1) * 4);
  raw[0] = 9;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([badFilter.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(png), /filter 9/);
  const huge = Buffer.alloc(13);
  huge.writeUInt32BE(100000, 0); huge.writeUInt32BE(100000, 4); huge.set([8, 6, 0, 0, 0], 8);
  assert.throws(() => decodePng(Buffer.concat([badFilter.subarray(0, 8), chunk("IHDR", huge), chunk("IEND", Buffer.alloc(0))])), /isn't taken/);
});

test("encodePng round-trips through decodePng", () => {
  const rgba = pattern(9, 4, 1);
  const got = decodePng(encodePng(9, 4, rgba));
  assert.deepEqual([...got.rgba], [...rgba]);
});

test("compareRegions: means per region, their difference, and the mean absolute difference", () => {
  const w = 4, h = 2;
  const a = { width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(100) };
  const b = { width: w, height: h, rgba: new Uint8Array(a.rgba) };
  // The right half of b is 40 brighter in red only.
  for (let y = 0; y < h; y++) for (let x = 2; x < 4; x++) b.rgba[(y * w + x) * 4] = 140;
  const [all, left, right] = compareRegions(a, b, [{ name: "all", rect: [0, 0, 4, 2] }, parseRegion("left=0,0,2,2"), parseRegion("right=2,0,2,2")]);
  assert.deepEqual(all.meanA, [100, 100, 100]);
  assert.deepEqual(all.meanB, [120, 100, 100]);
  assert.deepEqual(all.meanDelta, [20, 0, 0]);
  assert.equal(all.mad, 6.67, "40 in one channel of half the pixels: 40 / 6");
  assert.equal(left.mad, 0);
  assert.equal(right.mad, 13.33);
  assert.throws(() => compareRegions(a, { ...b, width: 3 }, []), /differ in size/);
  assert.throws(() => compareRegions(a, b, [parseRegion("3,0,2,2")]), /outside/);
});

test("sampleRegions covers the picture with the whole and a 3x3 grid", () => {
  const r = sampleRegions(1184, 844);
  assert.deepEqual(r.map((x) => x.name), ["all", "top-left", "top", "top-right", "left", "centre", "right", "bottom-left", "bottom", "bottom-right"]);
  const grid = r.slice(1);
  assert.equal(grid.reduce((s, x) => s + x.rect[2] * x.rect[3], 0), 1184 * 844, "the grid's cells add up to the picture");
});

test("parseRegion and parseArgs refuse what they don't know", () => {
  assert.deepEqual(parseRegion("10,20,30,40"), { name: "10,20,30,40", rect: [10, 20, 30, 40] });
  assert.throws(() => parseRegion("1,2,3"), /X,Y,W,H/);
  assert.throws(() => parseRegion("a=1,2,0,4"), /X,Y,W,H/);
  assert.throws(() => parseArgs(["a.png"]), /two pictures/);
  assert.throws(() => parseArgs(["a.png", "b.png", "--what"]), /unknown option/);
  assert.equal(parseArgs(["a.png", "b.png", "--tolerance", "3"]).tolerance, 3);
});

test("run: exit code by the tolerance, and the difference picture", () => {
  const dir = scratchDir("pic-compare-");
  try {
    const w = 6, h = 6, base = pattern(w, h);
    const other = new Uint8Array(base);
    for (let i = 0; i < other.length; i += 4) other[i] = Math.min(255, other[i] + 30);
    writeFileSync(join(dir, "a.png"), encodePng(w, h, base));
    writeFileSync(join(dir, "b.png"), encodePng(w, h, other));
    const lines = [];
    const files = [join(dir, "a.png"), join(dir, "b.png")];
    assert.equal(run({ files, regions: [], sample: false, diff: join(dir, "d.png"), tolerance: 20 }, (o) => lines.push(o)), 0);
    assert.equal(lines.at(-1).within, true);
    assert.equal(run({ files, regions: [], sample: true, diff: null, tolerance: 1 }, () => {}), 1, "the same pictures fail a tighter tolerance");
    assert.equal(run({ files: [files[0], files[0]], regions: [], sample: true, diff: null, tolerance: 0 }, () => {}), 0, "a picture matches itself");
    const d = decodePng(readFileSync(join(dir, "d.png")));
    const expected = diffPicture(decodePng(encodePng(w, h, base)), decodePng(encodePng(w, h, other)));
    assert.deepEqual([...d.rgba], [...expected.rgba]);
    assert.ok(d.rgba[0] > 0 && d.rgba[1] === 0, "red differs, green doesn't");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A PNG with the given colour type and depth whose rows (filter 0) hold `rows` (one array of sample bytes per row). */
function rawPng({ width, height, depth, colour, rows, plte, trns, interlace = 0 }) {
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([depth, colour, 0, 0, interlace], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr),
    ...(plte ? [chunk("PLTE", Buffer.from(plte))] : []), ...(trns ? [chunk("tRNS", Buffer.from(trns))] : []),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("decodePng: grey (type 0), grey with alpha (4), palette (3) with and without tRNS, 16 bits, and what it refuses", () => {
  // Type 0: grey becomes R=G=B, opaque. Control: two pixels with different values.
  const grey = decodePng(rawPng({ width: 2, height: 1, depth: 8, colour: 0, rows: [[10, 200]] }));
  assert.deepEqual([...grey.rgba], [10, 10, 10, 255, 200, 200, 200, 255]);
  // Type 4: the second sample is alpha.
  const ga = decodePng(rawPng({ width: 2, height: 1, depth: 8, colour: 4, rows: [[10, 20, 200, 99]] }));
  assert.deepEqual([...ga.rgba], [10, 10, 10, 20, 200, 200, 200, 99]);
  // Type 3: palette entries, alpha from tRNS for the first entries and opaque after it.
  const plte = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const pal = decodePng(rawPng({ width: 3, height: 1, depth: 8, colour: 3, rows: [[0, 1, 2]], plte, trns: [50, 60] }));
  assert.deepEqual([...pal.rgba], [1, 2, 3, 50, 4, 5, 6, 60, 7, 8, 9, 255]);
  assert.equal(decodePng(rawPng({ width: 1, height: 1, depth: 8, colour: 3, rows: [[2]], plte })).rgba[3], 255, "no tRNS: opaque");
  // A palette index past the palette, a palette PNG without its palette, a palette of 4 bits.
  assert.throws(() => decodePng(rawPng({ width: 1, height: 1, depth: 8, colour: 3, rows: [[3]], plte })), /palette index 3/);
  assert.throws(() => decodePng(rawPng({ width: 1, height: 1, depth: 8, colour: 3, rows: [[0]] })), /without its palette/);
  assert.throws(() => decodePng(rawPng({ width: 1, height: 1, depth: 4, colour: 3, rows: [[0]], plte })), /bit depth 4/);
  // 16 bits: the high byte of each sample (RGB, 2 bytes each).
  const deep = decodePng(rawPng({ width: 1, height: 1, depth: 16, colour: 2, rows: [[0x12, 0xff, 0x34, 0x00, 0x56, 0x80]] }));
  assert.deepEqual([...deep.rgba], [0x12, 0x34, 0x56, 255]);
  // Interlaced pictures are refused, not read as if they weren't (control: the same picture, not interlaced, reads).
  const flat = { width: 1, height: 1, depth: 8, colour: 0, rows: [[7]] };
  assert.equal(decodePng(rawPng(flat)).rgba[0], 7);
  assert.throws(() => decodePng(rawPng({ ...flat, interlace: 1 })), /interlaced/);
  // A colour type that isn't one.
  assert.throws(() => decodePng(rawPng({ ...flat, colour: 5 })), /colour type 5/);
});
