// Makes odd-size.w3x for the Map Size spec (tests/we-compare/map-size-38x42.json) from flat.w3x (the World Editor's
// own new 64x64 Lordaeron Summer map, level 2 everywhere): the same blank map at 38x42 tiles, a size neither Studio's New
// Map nor its Map Size tab can make (both want a multiple of 4 tiles):
//
//   node tests/fixtures/we-specs/make-odd-size.mjs <w3proj cli> <game folder>
//
// The terrain is blank (every corner level 2, Lordaeron Summer dirt), the playable area keeps the 64x64 map's margins
// (6, 6, 4 and 8 tiles) with the camera bounds worked out from them as the editor's own map has them, the pathing map
// (war3map.wpm) and the shadow map (war3map.shd) are cut to the new size, all clear.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-odd-size.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const W = 38, H = 42;
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "odd-size");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);

  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const out = [];
  // The map-edge marks as the editor's own 64x64 map has them: its left and right margins' columns, rows 1 to the bottom
  // margin and the last rows from the top margin up (row 0 and the last column stay clear).
  const [left, right, top, bottom] = JSON.parse(readFileSync(join(dir, "map", "war3map.w3i.json"), "utf8")).cameraComplements;
  const marks = Array.from({ length: H + 1 }, (_, y) => Array.from({ length: W + 1 }, (_, x) =>
    x < W && (x < left || x >= W - right || (y >= 1 && y <= bottom) || y >= H + 1 - top) && y >= 1 ? "1" : "0").join(""));
  const all = { height: "0", water: "0", texture: "0", variation: "0", "cliff-variation": "0", "cliff-texture": "f", layer: "2", flags: "0" };
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[i]);
    if (m && m[1] === "water-bits") {
      out.push("[water-bits]", ...marks);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    if (m && m[1] in all) {
      out.push(`[${m[1]}] all ${all[m[1]]}`);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    if (lines[i].startsWith("corners ")) out.push(`corners ${W + 1} ${H + 1}`);
    else if (lines[i].startsWith("offset ")) out.push(`offset ${-W * 64} ${-H * 64}`);
    else out.push(lines[i]);
  }
  writeFileSync(w3e, out.join("\n"));

  const w3i = join(dir, "map", "war3map.w3i.json");
  const info = JSON.parse(readFileSync(w3i, "utf8"));
  const xmin = -W * 64 + (left + 4) * 128, xmax = W * 64 - (right + 4) * 128;
  const ymin = -H * 64 + (bottom - 2) * 128, ymax = H * 64 - (top + 6) * 128;
  info.cameraBounds = [xmin, ymin, xmax, ymax, xmin, ymax, xmax, ymin];
  info.playableWidth = W - left - right;
  info.playableHeight = H - top - bottom;
  writeFileSync(w3i, JSON.stringify(info, null, 2));

  const wpm = Buffer.alloc(16 + W * 4 * H * 4, 0x40);
  wpm.write("MP3W", 0, "latin1");
  wpm.writeUInt32LE(0, 4);
  wpm.writeUInt32LE(W * 4, 8);
  wpm.writeUInt32LE(H * 4, 12);
  writeFileSync(join(dir, "map", "war3map.wpm"), wpm);
  writeFileSync(join(dir, "map", "war3map.shd"), Buffer.alloc(W * 4 * H * 4));

  run("pack", dir, "-o", join(here, "odd-size.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
