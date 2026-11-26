// Makes doodad-open-z.w3x (or with `wide` doodad-open-z-wide.w3x) for the open-time doodad height specs
// (tests/we-compare/doodad-open-z.json) from flat.w3x (the World Editor's own new 64x64 Lordaeron Summer map: ground 0
// on level 2):
//
//   node tests/fixtures/we-specs/make-doodad-open-z.mjs <w3proj cli> <game folder> [wide]
//
// Where does the World Editor put a doodad or destructable without a height of its own (no flag 4) when it opens a
// map? Every one here is stored at z 400, so its save shows the height it works out. The cases are those where
// smoketest_maps' heights (the editor's own: it kept them all, and put 37.5 raised copies back on them) differed from
// Studio's bilinear ground (2026-11-16):
//   A  i 4..20, j 4..20   bumpy ground (32 * ((5i + 3j) mod 7)): stone walls LTw0 and icy rocks ITcr (Elevation Sample
//                         Radius 50), trees LTlt (0), and custom destructables with other radii (brad): B000 LTlt with
//                         50, B001..B004 LTw0 with 0, 100, 200, 25
//   B  a level-3 plateau (i 26..50, j 44..56) with ramps up its south face: three cells wide (i 28..31), one column
//                         (i 36); a corner whose ramp neighbours climb along both axes (44, 42); a ramp corner whose
//                         climb has no straight cell beside it (54, 30). ZPsh (no pathing) at three places in every cell
//                         with a ramp corner, and in a few cliff cells
//   C  i 4..12, j 30..34  a plain slope with ZPsh
//   D  i 4..20, j 40..56  bumpy ground as A: the bridge YT00 (radius 100), B005 (LTw0 unchanged), LTw1 changed to radius
//                         0, LTw2 to 100, LTw3 to 25, ITw2 to 64, ITw3 to 1 (the map's original table)
// `wide` adds the ones whose ground isn't worked out (2026-11-16): the bridge YT04 (radius 200; the editor also puts it on
// another grid point than Studio), ITw0 changed to 150 and ITw1 to 128.
// Corner (i, j) is at (-4096 + 128 i, -4096 + 128 j).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
const wide = process.argv[4] === "wide";
if (!game || (process.argv[4] !== undefined && !wide)) { console.error("usage: make-doodad-open-z.mjs <w3proj cli> <game folder> [wide]"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
/** Corners: z (world, the level counted), layer, ramp. */
const corners = new Map();
const set = (i, j, c) => corners.set(`${i},${j}`, { z: 0, layer: 2, ramp: false, ...corners.get(`${i},${j}`), ...c });
const at = (i, j) => corners.get(`${i},${j}`) ?? { z: 0, layer: 2, ramp: false };
// A: bumpy ground
for (let i = 4; i <= 20; i++) for (let j = 4; j <= 20; j++) set(i, j, { z: 32 * ((5 * i + 3 * j) % 7) });
// B: the plateau, its ramps
for (let i = 26; i <= 50; i++) for (let j = 44; j <= 56; j++) set(i, j, { z: 128, layer: 3 });
const ramp = (i, j, layer) => set(i, j, { z: (layer - 2) * 128, layer, ramp: true });
for (const i of [28, 29, 30, 31, 36]) { ramp(i, 42, 2); ramp(i, 43, 2); ramp(i, 44, 3); }
// Both axes climb at (44, 42): east and north are on level 3.
ramp(44, 42, 2); ramp(43, 42, 2); ramp(44, 41, 2); ramp(45, 42, 3); ramp(44, 43, 3); set(45, 43, { z: 128, layer: 3 });
// No straight cell beside the climb at (54, 30): west is a ramp corner on level 3, the corners round that on 4 and 2.
ramp(54, 30, 2); ramp(55, 30, 2); ramp(53, 30, 3); set(53, 31, { z: 256, layer: 4 });
// D: bumpy ground again
for (let i = 4; i <= 20; i++) for (let j = 40; j <= 56; j++) set(i, j, { z: 32 * ((5 * i + 3 * j) % 7) });
// C: a plain slope
for (let i = 4; i <= 12; i++) for (let j = 30; j <= 34; j++) set(i, j, { z: 24 * (i - 4) + 10 * (j - 30) });

const X = (i) => -4096 + 128 * i;
// [id, i, j (corner coordinates, fractions allowed)]
const PLACED = [
  ["LTw0", 8, 8], ["LTw0", 10.5, 8], ["LTw0", 12, 12.5], ["LTw0", 14.5, 14.5], ["ITcr", 8, 16], ["ITcr", 12.5, 16],
  ["LTlt", 16, 8], ["LTlt", 16.5, 10.5], ["B000", 18, 8], ["B000", 18.5, 10.5], ["B001", 6, 18], ["B001", 8.5, 18],
  ["B002", 10, 18], ["B002", 12.5, 18], ["B003", 14, 18.5], ["B003", 16.5, 18], ["B004", 6, 12], ["B004", 6.5, 14.5],
  ["YT00", 8, 44], ["YT00", 12.5, 46], ["B005", 16, 44], ["B005", 18.5, 46],
  ["LTw1", 16, 50], ["LTw1", 18.5, 52], ["LTw2", 6, 54], ["LTw2", 9, 54.5],
  ["LTw3", 4.5, 47], ["LTw3", 6.5, 49.5], ["ITw2", 11, 53], ["ITw2", 13.5, 55], ["ITw3", 16, 55], ["ITw3", 18.5, 55.5],
  ...(wide ? [["YT04", 8, 50], ["YT04", 14.5, 52], ["ITw0", 11, 48], ["ITw0", 12.5, 50.5], ["ITw1", 15, 47.5], ["ITw1", 17.5, 48]] : []),
];
// ZPsh at three places in every cell with a ramp corner, and in cliff cells along the plateau's south face.
const cells = new Set();
for (const [k, c] of corners) {
  if (!c.ramp) continue;
  const [i, j] = k.split(",").map(Number);
  for (const [a, b] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) cells.add(`${i + a},${j + b}`);
}
for (const k of ["26,43", "33,43", "40,43", "50,43", "25,50", "50,50"]) cells.add(k);
for (const k of [...cells].sort()) {
  const [i, j] = k.split(",").map(Number);
  for (const [u, v] of [[0.25, 0.25], [0.75, 0.3], [0.4, 0.8]]) PLACED.push(["ZPsh", i + u, j + v]);
}
for (const [u, v] of [[4.3, 30.6], [6.5, 31.5], [9.8, 33.2], [11.1, 30.1]]) PLACED.push(["ZPsh", u, v]);

/** A section's rows as the text keeps them: the top row (y = 64) first. */
const rows = (f, sep = "") => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, i) => f(i, N - 1 - r)).join(sep));
/** A corner of a cell with corners on two levels or a ramp corner: the editor gives those a cliff texture. */
const onCliff = (i, j) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([di, dj]) => {
  const ti = i + di, tj = j + dj;
  if (ti < 0 || tj < 0 || ti + 1 >= N || tj + 1 >= N) return false;
  const cs = [at(ti, tj), at(ti + 1, tj), at(ti, tj + 1), at(ti + 1, tj + 1)];
  return new Set(cs.map((c) => c.layer)).size > 1 || cs.some((c) => c.ramp);
});
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "open-z");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  // The text's height is the stored word less 0x2000 (a quarter world unit, the level not counted); its flags the
  // corner's high nibble (1: ramp).
  const sections = {
    height: rows((i, j) => String(Math.round((at(i, j).z - (at(i, j).layer - 2) * 128) * 4)), " "),
    layer: rows((i, j) => String(at(i, j).layer)),
    flags: rows((i, j) => (at(i, j).ramp ? "1" : "0")),
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
  const brad = (value) => [{ field: "brad", type: "unreal", value, level: 0, data: 0 }];
  writeFileSync(join(dir, "map", "war3map.w3b.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3,
    original: [{ base: "LTw1", mods: brad(0) }, { base: "LTw2", mods: brad(100) }, { base: "LTw3", mods: brad(25) }, { base: "ITw0", mods: brad(150) },
      { base: "ITw1", mods: brad(128) }, { base: "ITw2", mods: brad(64) }, { base: "ITw3", mods: brad(1) }], custom: [
    { base: "LTlt", id: "B000", mods: brad(50) }, { base: "LTw0", id: "B001", mods: brad(0) }, { base: "LTw0", id: "B002", mods: brad(100) },
    { base: "LTw0", id: "B003", mods: brad(200) }, { base: "LTw0", id: "B004", mods: brad(25) }, { base: "LTw0", id: "B005", mods: [] },
  ] }, null, 2));
  const dooFile = join(dir, "map", "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  const dest = (id) => id !== "ZPsh";
  doo.doodads = PLACED.map(([id, i, j], k) => ({
    id, variation: 0, position: [X(i), X(j), 400], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: id,
    preFlags: 4294967295, flags: 2, life: dest(id) ? 100 : 255, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [k, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  run("pack", dir, "-o", join(here, wide ? "doodad-open-z-wide.w3x" : "doodad-open-z.w3x"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
