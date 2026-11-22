// How much light a shadow keeps, from two pictures of one view: Shadows on and Shadows off (we-drive's --view
// Shadows=on/off, app-drive's terrain.shadows.visible). Per channel, in linear light: the sum over the shadow's core of
// "on" over the sum of "off". The core is where the 9 x 9 box blur of the pixels' ratio (on over off, of the three
// channels' sum) is under --threshold, inside the region; a region where fewer than --min pixels are that dark has no
// core (a control: a region without a shadow must give none). Water's waves and units' animations move between two
// pictures, so a pixel's ratio scatters; the means over a core of hundreds of pixels hold (docs/testing/
// lighting-and-shadows.md, "Shadows on HD water"). Plain JavaScript, pic-compare.mjs's PNG reader.
//
//   node scripts/shadow-keep.mjs ON.png[,ON2.png…] OFF.png[,OFF2.png…] --region [NAME=]X,Y,W,H [--region …]
//                                [--threshold 0.8] [--min 30]
//
// Several pictures on one side (comma-separated: frames of the same view a moment apart) are averaged per pixel first.
//
// Prints one JSON line per region: { region, rect, pixels, kept: [r, g, b] | null }.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { decodePng, parseRegion } from "./pic-compare.mjs";

const BLUR = 9;

const toLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => toLinear(v));

/** The region's linear light, per pixel and channel (w * h * 3), the mean of the pictures given. */
function meanLinear(pictures, [x0, y0, w, h]) {
  const out = new Float64Array(w * h * 3);
  for (const img of pictures) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = ((y0 + y) * img.width + x0 + x) * 4;
      for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] += LINEAR[img.rgba[o + k]] / pictures.length;
    }
  }
  return out;
}

/** The region's mean linear light with Shadows on and off (`meanLinear`), the pictures checked. */
function sides(on, off, rect) {
  const ons = Array.isArray(on) ? on : [on], offs = Array.isArray(off) ? off : [off];
  const all = [...ons, ...offs], { width, height } = all[0] ?? {};
  if (!ons.length || !offs.length) throw new Error("shadow-keep wants at least one picture with Shadows on and one with them off");
  if (all.some((p) => p.width !== width || p.height !== height)) throw new Error(`the pictures differ in size: ${all.map((p) => `${p.width}x${p.height}`).join(", ")}`);
  if (rect[0] + rect[2] > width || rect[1] + rect[3] > height) throw new Error(`the region (${rect.join(",")}) lies outside the ${width}x${height} pictures`);
  return [meanLinear(ons, rect), meanLinear(offs, rect)];
}

/**
 * A region's shadow core (one byte per pixel of the region, row by row: 1 in the core): where the 9 x 9 box blur of
 * the pixels' ratio on over off (of the three channels' sum) is under `threshold`. Pictures as for shadowKeep.
 */
export function coreMask(on, off, rect, { threshold = 0.8 } = {}) {
  const [a, b] = sides(on, off, rect), [, , w, h] = rect;
  const ratio = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) ratio[i] = (a[i * 3] + a[i * 3 + 1] + a[i * 3 + 2]) / Math.max(b[i * 3] + b[i * 3 + 1] + b[i * 3 + 2], 1e-6);
  // its box blur, the edges repeated
  const p = BLUR >> 1, at = (x, y) => ratio[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let dy = -p; dy <= p; dy++) for (let dx = -p; dx <= p; dx++) s += at(x + dx, y + dy);
    if (s / (BLUR * BLUR) < threshold) mask[y * w + x] = 1;
  }
  return mask;
}

/**
 * The light kept in a region's shadow core: { pixels, kept } (kept null when the core has fewer than `min` pixels).
 * `on` and `off` are decoded pictures of one size ({ width, height, rgba }), or lists of them (frames of one view a
 * moment apart: their mean, which evens out the waves), `rect` [x, y, w, h]. `mask` (coreMask's) takes the core of
 * other pictures of the same view: two renderings compared over the same pixels, one of whose shadows may be too light
 * to have a core of its own.
 */
export function shadowKeep(on, off, rect, { threshold = 0.8, min = 30, mask } = {}) {
  const [a, b] = sides(on, off, rect), core = mask ?? coreMask(on, off, rect, { threshold });
  if (core.length !== rect[2] * rect[3]) throw new Error(`the mask has ${core.length} pixels, the region ${rect[2] * rect[3]}`);
  const sumOn = [0, 0, 0], sumOff = [0, 0, 0];
  let pixels = 0;
  for (let i = 0; i < core.length; i++) {
    if (!core[i]) continue;
    pixels++;
    for (let k = 0; k < 3; k++) { sumOn[k] += a[i * 3 + k]; sumOff[k] += b[i * 3 + k]; }
  }
  if (pixels < min) return { pixels, kept: null };
  return { pixels, kept: sumOn.map((s, k) => Math.round((s / Math.max(sumOff[k], 1e-9)) * 1000) / 1000) };
}

export function parseArgs(argv) {
  const opts = { files: [], regions: [], threshold: 0.8, min: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--region") opts.regions.push(parseRegion(value()));
    else if (a === "--threshold") {
      opts.threshold = Number(value());
      if (!(opts.threshold > 0 && opts.threshold < 1)) throw new Error("--threshold wants a number between 0 and 1");
    } else if (a === "--min") {
      opts.min = Number(value());
      if (!Number.isInteger(opts.min) || opts.min < 1) throw new Error("--min wants a whole number of pixels");
    } else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a} (see the top of shadow-keep.mjs)`);
    else opts.files.push(a);
  }
  if (!opts.help && opts.files.length !== 2) throw new Error("shadow-keep wants two pictures: Shadows on, Shadows off");
  if (!opts.help && !opts.regions.length) throw new Error("shadow-keep wants at least one --region");
  return opts;
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "shadow-keep.mjs") {
  let code = 0;
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log("usage: node scripts/shadow-keep.mjs ON.png OFF.png --region [NAME=]X,Y,W,H [--threshold T] [--min N]");
    else {
      const [on, off] = opts.files.map((list) => list.split(",").map((f) => {
        try { return decodePng(readFileSync(f)); } catch (e) { throw new Error(`${f}: ${e.message}`); }
      }));
      for (const { name, rect } of opts.regions) console.log(JSON.stringify({ region: name, rect, ...shadowKeep(on, off, rect, opts) }));
    }
  } catch (e) {
    console.error(`shadow-keep: ${e.message}`);
    code = 2;
  }
  process.exit(code);
}
