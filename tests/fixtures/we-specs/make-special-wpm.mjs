// Makes special-wpm.w3x for tests/we-compare/special-wpm.json (bugs.md "Pathing residuals after special stamping"):
// flat.w3x (the World Editor's own new 64x64 Lordaeron Summer map, level 2) with special doodads (war3map.doo's second
// list, placed by tile) on tiles that have a lone high corner (one corner on level 3), on flat ground and by a cliff:
//   flat   rows y 10 (YCr1), 16 (YCp1), 22 (LCc0); x 8, 14, ..., 50: the lone high corner at the special's tile plus
//          OFFSETS[k] (k = the column), so each column puts it in another place under the footprint
//   cliff  a level 3 plateau on corners x 8..56, y 40..50 (Grass Cliff on its cliff corners); rows y 37 (YCr1, YCp1,
//          LCc0 in front of its south face, x 10, 18, 26) and y 40 (the same on the face, x 34, 42, 50), each with a lone
//          high corner at its tile plus (1, -1) in front of the face
//
//   node tests/fixtures/we-specs/make-special-wpm.mjs <w3proj cli> <game folder> [grid ID]
//
// `grid ID` writes special-wpm-grid-ID.w3x instead: 37 copies of the special ID on flat ground (tiles x 6, 13, ..., 48;
// y 6, 13, ..., 41), the first without a lone high corner, the others each with one at the special's tile plus
// (dx, dy), dx and dy -1..4 (the footprint's corners and the ring round them), row by row.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";
import { modeArgs, requireValid } from "../../gen-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cliArg, gameArg] = process.argv.slice(2);
const [cli, game] = [cliArg, gameArg].map((p) => (p ? resolve(p) : p));
const args = modeArgs();
const [mode, gridId] = args;
requireValid(!!game && (args.length === 0 || (args.length === 2 && mode === "grid" && /^[A-Za-z0-9]{4}$/.test(gridId))),
  "usage: make-special-wpm.mjs <w3proj cli> <game folder> [grid ID]");
requireFresh(cli, "cli");
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
const specials = [];
const lone = new Set();
let plateau = () => false;
let outName = "special-wpm.w3x";
if (mode === "grid") {
  outName = `special-wpm-grid-${gridId}.w3x`;
  const offsets = [null];
  for (let dy = -1; dy <= 4; dy++) for (let dx = -1; dx <= 4; dx++) offsets.push([dx, dy]);
  offsets.forEach((o, k) => {
    const x = 6 + 7 * (k % 7), y = 6 + 7 * Math.floor(k / 7);
    specials.push({ id: gridId, z: 0, x, y });
    if (o) lone.add(`${x + o[0]},${y + o[1]}`);
  });
} else {
  const IDS = ["YCr1", "YCp1", "LCc0"];
  const OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, -1], [2, 0], [0, 2], [-1, 1]];
  IDS.forEach((id, r) => OFFSETS.forEach(([dx, dy], k) => {
    const x = 8 + 6 * k, y = 10 + 6 * r;
    specials.push({ id, z: 0, x, y });
    lone.add(`${x + dx},${y + dy}`);
  }));
  IDS.forEach((id, k) => {
    for (const [x, y] of [[10 + 8 * k, 37], [34 + 8 * k, 40]]) {
      specials.push({ id, z: 0, x, y });
      lone.add(`${x + 1},${y - 1}`);
    }
  });
  plateau = (x, y) => x >= 8 && x <= 56 && y >= 40 && y <= 50;
}
const high = (x, y) => plateau(x, y) || lone.has(`${x},${y}`);
/** A corner of a tile with corners on both levels. */
const onCliff = (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
  const tx = x + dx, ty = y + dy;
  const q = [high(tx, ty), high(tx + 1, ty), high(tx, ty + 1), high(tx + 1, ty + 1)];
  return q.some(Boolean) && !q.every(Boolean);
});
/** A section's rows as the text keeps them: the top row (y = 64) first. */
const rows = (f) => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(""));
const scratch = mkdtempSync(join(tmpdir(), "we-special-wpm-"));
try {
  const dir = join(scratch, "map");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const sections = {
    layer: rows((x, y) => (high(x, y) ? "3" : "2")),
    "cliff-texture": rows((x, y) => (onCliff(x, y) ? "1" : "f")),
  };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[i]);
    if (m && m[1] in sections) {
      out.push(`[${m[1]}]`, ...sections[m[1]]);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    out.push(lines[i]);
  }
  writeFileSync(w3e, out.join("\n"));
  const dooFile = join(dir, "map", "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  doo.specials = specials;
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  run("pack", dir, "-o", join(here, outName), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${join(here, outName)}`);
