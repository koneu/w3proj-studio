// Makes the maps for measuring the World Editor's Calculate Shadows cell by cell (war3map.shd), from flat.w3x (the
// editor's own new 64x64 Lordaeron Summer map, level 2, height 0 everywhere):
//
//   node tests/fixtures/we-specs/make-shadow-probes.mjs <w3proj cli> <game folder> [out folder] [name]
//
// The out folder is this one by default (shadow-terrain.w3x is the input of tests/we-compare/shadow-terrain.json).
//
// shadow-terrain.w3x: shapes made of corner heights and cliff levels, apart enough that their shadows don't meet
//   (corner coordinates, x east, y north; heights in world units):
//   soft step  corners x 6..14, y 6..16 raised 128 (ground height, no cliff: a 45° bank one tile wide round it)
//   cliff +1   corners x 22..30, y 6..16 one level up (Grass Cliff), as plateau.w3x
//   cliff +2   corners x 40..48, y 6..16 two levels up
//   corners    single corners raised 128 at (8,30), 256 at (22,30), 512 at (40,28)
//   ridges     y = 46, x 4..18 raised 256; x = 30, y 40..56 raised 256
//   low step   corners x 44..52, y 40..50 raised 64 (a 26.6° bank: no self-shadow at a 30° sun)
// shadow-rocks.w3x: doodads on flat ground, see DOODAD_MAPS (not committed: the doodads' rule isn't found yet).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game, outArg] = process.argv.slice(2, 5).map((p) => (p ? resolve(p) : p));
const outDir = outArg || here;
const only = process.argv[5];
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-shadow-probes.mjs <w3proj cli> <game folder> [out folder] [name]"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
const inBox = (x, y, x0, x1, y0, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
/** Ground height (world units, over the cliff level) of a corner. */
function height(x, y) {
  if (inBox(x, y, 6, 14, 6, 16)) return 128;
  if (x === 8 && y === 30) return 128;
  if (x === 22 && y === 30) return 256;
  if (x === 40 && y === 28) return 512;
  if (y === 46 && x >= 4 && x <= 18) return 256;
  if (x === 30 && y >= 40 && y <= 56) return 256;
  if (inBox(x, y, 44, 52, 40, 50)) return 64;
  return 0;
}
/** Cliff level of a corner (2: the ground of flat.w3x). */
function level(x, y) {
  if (inBox(x, y, 22, 30, 6, 16)) return 3;
  if (inBox(x, y, 40, 48, 6, 16)) return 4;
  return 2;
}
const onCliff = (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
  const tx = x + dx, ty = y + dy;
  if (tx < 0 || ty < 0 || tx >= N - 1 || ty >= N - 1) return false;
  const q = [level(tx, ty), level(tx + 1, ty), level(tx, ty + 1), level(tx + 1, ty + 1)];
  return q.some((l) => l !== q[0]);
});
/** A section's rows as the text keeps them: the top row (y = 64) first. */
const rows = (f, sep = "") => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(sep));

/** Doodad maps: each spot a doodad type, position (world), angle (degrees), variation, scale. */
const DOODAD_MAPS = {
  // LRrk (Lordaeron rock) at variation 0..9, angle 270, one every 8 tiles; then variation 0 at angles 0..315 by 45;
  // then variation 0 at angle 270 moved 4 units more east (and north) each, eight steps (the editor's save puts these
  // back on the 32 grid: it snaps doodads it opens).
  "shadow-rocks": () => {
    const spots = [];
    for (let v = 0; v < 10; v++) spots.push({ id: "LRrk", x: -3584 + (v % 5) * 1536, y: 2560 - Math.floor(v / 5) * 1024, angle: 270, variation: v });
    for (let a = 0; a < 8; a++) spots.push({ id: "LRrk", x: -3584 + (a % 4) * 2048, y: 512 - Math.floor(a / 4) * 1024, angle: a * 45, variation: 0 });
    for (let k = 0; k < 8; k++) spots.push({ id: "LRrk", x: -3584 + (k % 4) * 2048 + k * 4, y: -1536 - Math.floor(k / 4) * 1024 + k * 4, angle: 270, variation: 0 });
    return spots;
  },
};

function patchW3e(dir, terrain) {
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const sections = terrain
    ? {
      height: rows((x, y) => height(x, y) * 4, " "),
      layer: rows((x, y) => String(level(x, y))),
      "cliff-texture": rows((x, y) => (onCliff(x, y) ? "1" : "f")),
    }
    : {};
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
}

const maps = { "shadow-terrain": null, ...DOODAD_MAPS };
for (const [name, spotsOf] of Object.entries(maps)) {
  if (only && only !== name) continue;
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    patchW3e(dir, !spotsOf);
    if (spotsOf) {
      const doo = join(dir, "map", "war3map.doo.json");
      const json = JSON.parse(readFileSync(doo, "utf8"));
      spotsOf().forEach(({ id, x, y, angle, variation, scale = 1 }, n) => {
        json.doodads.push({ id, variation, position: [x, y, 0], angle: (angle * Math.PI) / 180, scale: [scale, scale, scale], skinId: id, preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [n & 255, (n >> 8) & 255, 0], extras: [] });
      });
      writeFileSync(doo, JSON.stringify(json, null, 2));
    }
    run("pack", dir, "-o", join(outDir, `${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
