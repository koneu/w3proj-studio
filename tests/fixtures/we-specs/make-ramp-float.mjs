// Makes ramp-float.w3x for tests/we-compare/ramp-float.json from flat.w3x (the World Editor's own new 64x64 Lordaeron
// Summer map: ground 0 on level 2, water word 0 everywhere, a level of -89.6):
//
//   node tests/fixtures/we-specs/make-ramp-float.mjs <w3proj cli> <game folder>
//
// A floating doodad (lily pad LPfp) stands on the water of the corner nearest to it when that corner is wet and its water
// is above its ground (lib/terrain/w3e.ts floatingLevelAt, measured on flat ground). On a ramp's middle corner, which the
// editor draws half a level (64) up (rampLift), is that lift part of "its ground"? A level-3 plateau (corners i 24..36,
// j 44..52) with a ramp three tiles wide up its south face (i 28..31: j 42 and 43 ramp corners on level 2, j 44 on 3,
// as make-doodad-open-z.mjs's), so the corners (28..31, 43) are lifted 64. The corners i 26..33, j 40..43 are wet; the
// water by column on row 43: i 28 and 30 at 32 (between the ground 0 and the lifted 64), i 29 at 80 (above both), i 31 at
// -20 (below both); row 42 (not lifted) and the rest at 32. Lily pads (flags 2, stored at z 400) on and beside those
// corners. Corner (i, j) is at (-4096 + 128 i, -4096 + 128 j).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli");
if (!game) { console.error("usage: make-ramp-float.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
/** Corners: ground (world, the level not counted), layer, ramp, wet, water level (world). */
const corners = new Map();
const set = (i, j, c) => corners.set(`${i},${j}`, { ...at(i, j), ...c });
const at = (i, j) => corners.get(`${i},${j}`) ?? { ground: 0, layer: 2, ramp: false, wet: false, water: -89.6 };
for (let i = 24; i <= 36; i++) for (let j = 44; j <= 52; j++) set(i, j, { layer: 3 });
for (const i of [28, 29, 30, 31]) { set(i, 42, { ramp: true }); set(i, 43, { ramp: true }); set(i, 44, { ramp: true }); }
for (let i = 26; i <= 33; i++) for (let j = 40; j <= 43; j++) set(i, j, { wet: true, water: 32 });
set(29, 43, { water: 80 });
set(31, 43, { water: -20 });

const X = (i) => -4096 + 128 * i;
// [i, j]: on the lifted corners, beside them (nearest still them), on the row below (not lifted), off the ramp.
const PADS = [[28, 43], [29, 43], [30, 43], [31, 43], [30.3, 43.2], [29.6, 42.8], [30, 42], [31.2, 41.9], [27, 43], [32.4, 41]];

const rows = (f, sep = "") => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, i) => f(i, N - 1 - r)).join(sep));
/** A corner of a tile with corners on two levels or a ramp corner: the editor gives those a cliff texture. */
const onCliff = (i, j) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([di, dj]) => {
  const ti = i + di, tj = j + dj;
  if (ti < 0 || tj < 0 || ti + 1 >= N || tj + 1 >= N) return false;
  const cs = [at(ti, tj), at(ti + 1, tj), at(ti, tj + 1), at(ti + 1, tj + 1)];
  return new Set(cs.map((c) => c.layer)).size > 1 || cs.some((c) => c.ramp);
});
const scratch = mkdtempSync(join(tmpdir(), "we-specs-ramp-float-"));
try {
  const dir = join(scratch, "ramp-float");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  // Height: the stored word less 0x2000 (quarter units, the level not counted); water: (level + 89.6) * 4; flags: the
  // corner's high nibble (1 ramp, 4 water).
  const sections = {
    height: rows((i, j) => String(Math.round(at(i, j).ground * 4)), " "),
    water: rows((i, j) => String(Math.round((at(i, j).water + 89.6) * 4)), " "),
    layer: rows((i, j) => String(at(i, j).layer)),
    flags: rows((i, j) => String((at(i, j).ramp ? 1 : 0) | (at(i, j).wet ? 4 : 0))),
    "cliff-texture": rows((i, j) => (onCliff(i, j) ? "1" : "f")),
  };
  const out = [];
  for (let k = 0; k < lines.length; k++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[k]);
    if (m && m[1] in sections) {
      out.push(`[${m[1]}]`, ...sections[m[1]]);
      while (k + 1 < lines.length && lines[k + 1] !== "" && !lines[k + 1].startsWith("[")) k++;
      continue;
    }
    out.push(lines[k]);
  }
  writeFileSync(w3e, out.join("\n"));
  const dooFile = join(dir, "map", "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  doo.doodads = PADS.map(([i, j], k) => ({
    id: "LPfp", variation: 0, position: [X(i), X(j), 400], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: "LPfp",
    preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [k, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  run("pack", dir, "-o", join(here, "ramp-float.w3x"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
