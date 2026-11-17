// Compares two minimap pictures (TGA, BLP or PNG: the app's own decoder) of the same size, for the World Editor's
// Export Minimap / war3mapMap.blp against Studio's: the mean absolute and signed difference per channel, over the whole
// picture and over the pixels that aren't black (the unplayed margin), and the share of pixels within 8 per channel.
//
//   node scripts/minimap-diff.mjs A B [--flipB]   (--flipB: B's rows are upside down, e.g. a bottom-up TGA read as is)
//
// Prints one JSON line. Exit 2 when a picture can't be read or the sizes differ.

import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { decodePng } from "./pic-compare.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The app's image decoder (lib/image), bundled once into a temporary file. */
export async function imageDecoder() {
  const { build } = await import("esbuild");
  const out = join(tmpdir(), `minimap-diff-decoder-${process.pid}.mjs`);
  await build({
    stdin: { contents: `export { decodeImage } from "./src/lib/image/index";`, resolveDir: resolve(here, ".."), loader: "ts" },
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  });
  try { return (await import(pathToFileURL(out).href)).decodeImage; } finally { rmSync(out, { force: true }); }
}

/** { width, height, rgba } of a picture file. */
export function load(decode, file) {
  if (/\.png$/i.test(file)) return decodePng(readFileSync(file));
  return decode(new Uint8Array(readFileSync(file)), file).mip(0);
}

/** Per channel mean |a-b| and mean (a-b) over the pixels `keep(i)` accepts, and how many were counted. */
export function diffStats(a, b, keep = () => true) {
  const abs = [0, 0, 0], sgn = [0, 0, 0];
  let n = 0, close = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if (!keep(i)) continue;
    n++;
    let ok = true;
    for (let k = 0; k < 3; k++) {
      const d = a.rgba[i * 4 + k] - b.rgba[i * 4 + k];
      abs[k] += Math.abs(d); sgn[k] += d;
      if (Math.abs(d) > 8) ok = false;
    }
    if (ok) close++;
  }
  const f = (v) => v.map((x) => +(x / Math.max(1, n)).toFixed(2));
  return { n, mad: f(abs), mean: f(sgn), within8: +(close / Math.max(1, n)).toFixed(3) };
}

export function flipRows(img) {
  const rgba = new Uint8Array(img.rgba.length), row = img.width * 4;
  for (let y = 0; y < img.height; y++) rgba.set(img.rgba.subarray(y * row, (y + 1) * row), (img.height - 1 - y) * row);
  return { ...img, rgba };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flip = process.argv.includes("--flipB");
  try {
    if (args.length !== 2) throw new Error("usage: minimap-diff.mjs A B [--flipB]");
    const decode = await imageDecoder();
    const a = load(decode, args[0]);
    let b = load(decode, args[1]);
    if (flip) b = flipRows(b);
    if (a.width !== b.width || a.height !== b.height) throw new Error(`sizes differ: ${a.width}x${a.height} against ${b.width}x${b.height}`);
    const lit = (i) => a.rgba[i * 4] + a.rgba[i * 4 + 1] + a.rgba[i * 4 + 2] > 0 || b.rgba[i * 4] + b.rgba[i * 4 + 1] + b.rgba[i * 4 + 2] > 0;
    console.log(JSON.stringify({ size: [a.width, a.height], all: diffStats(a, b), lit: diffStats(a, b, lit) }));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
