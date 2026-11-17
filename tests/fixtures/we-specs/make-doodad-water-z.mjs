// Makes doodad-water-z.w3x for the floating-doodad specs (tests/we-compare/doodad-water-z.json) from flat.w3x (the World
// Editor's own new 64x64 Lordaeron Summer map: ground 0 on level 2, the water's word 0 everywhere, a level of -89.6):
//
//   node tests/fixtures/we-specs/make-doodad-water-z.mjs <w3proj cli> <game folder>
//
// Where does the editor put a doodad of a type with `floats` 1 (Doodads.slk: LPfp lily pads, ZWsw seaweed) that has no
// height of its own (flags 2)? EchoIsles fits "on the water level of the corner nearest to it when that corner's water
// is above its ground, else on the ground": these patches tell the cases apart. Corner (i, j) is at
// (-4096 + 128 i, -4096 + 128 j); each patch is corners i0..i0+4, j0..j0+4.
//   A  i 8,  j 8   bed -128, water -89.6 above it, no water flag            (does the flag count?)
//   B  i 16, j 8   bed -128, water -89.6, water flag                        (the plain case; ZPsh, a non-floating control)
//   C  i 24, j 8   ground 0, water -89.6 below it, water flag               (ground)
//   D  i 32, j 8   columns alternate: even i bed -128 wet, odd i ground 0 dry (ties between two corners along x)
//   T  i 32, j 16  rows alternate the same way                              (ties along y)
//   E  i 44, j 8   level 3 with height -128 (ground 0 with the level), water -49.6, water flag  (does the level count?)
//   J  i 8,  j 20  bed -128 wet, the water's level by column: -89.6, -59.6, -29.6, 0.4, 30.4  (whose level?)
//   H  i 60, j 8   (to the map's east edge) bed -128 wet                    (the last column of corners)
// Doodads stored at z 37.5 unless said (the editor's save shows what it works out, not what the file had), a tree LTlt on
// dry ground (its nudge step is 64, so Select All + Numpad 6 moves all by 64), a fixed lily pad (flags 6, z 50) in B,
// and a lily pad and a ZPsh on dry ground.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-doodad-water-z.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
/** Corner overrides: ground (world, without the level), water level (world), wet, layer. */
const corners = new Map();
const set = (i, j, c) => corners.set(`${i},${j}`, { ground: 0, water: -89.6, wet: false, layer: 2, ...corners.get(`${i},${j}`), ...c });
const patch = (i0, j0, f) => { for (let i = i0; i <= i0 + 4; i++) for (let j = j0; j <= j0 + 4; j++) set(i, j, f(i, j)); };
patch(8, 8, () => ({ ground: -128 }));
patch(16, 8, () => ({ ground: -128, wet: true }));
patch(24, 8, () => ({ wet: true }));
patch(32, 8, (i) => (i % 2 === 0 ? { ground: -128, wet: true } : {}));
patch(32, 16, (_, j) => (j % 2 === 0 ? { ground: -128, wet: true } : {}));
patch(44, 8, () => ({ ground: -128 + 128, layer: 3, water: -49.6, wet: true }));
patch(8, 20, (i) => ({ ground: -128, wet: true, water: -89.6 + 30 * (i - 8) }));
for (let i = 60; i <= 64; i++) for (let j = 8; j <= 12; j++) set(i, j, { ground: -128, wet: true });

const X = (i) => -4096 + 128 * i;
// [id, i, j (corner coordinates, fractions allowed), z, flags, life (100), scale ([1, 1, 1])]
const DOODADS = [
  ["LTlt", 32, 40, 0, 2],
  ["LPfp", 9.3, 10.2, 37.5, 2], ["ZWsw", 10.6, 10.7, 37.5, 2],                       // A
  ["LPfp", 17.3, 10.2, 37.5, 2], ["ZWsw", 18.6, 10.7, 37.5, 2], ["ZPsh", 17.4, 11.4, 37.5, 2],
  ["LPfp", 17.2, 9.3, 50, 6], ["LPfp", 18.2, 11.6, -128, 2],                           // B
  ["LPfp", 25.3, 10.2, 37.5, 2],                                                      // C
  ["LPfp", 32.5, 10, 37.5, 2], ["LPfp", 33.5, 11, 37.5, 2], ["LPfp", 33, 9, 37.5, 2],
  ["LPfp", 34, 10.3, 37.5, 2], ["LPfp", 32.3, 11.6, 37.5, 2],                          // D: ties now, ties after the nudge
  ["LPfp", 33.2, 16.5, 37.5, 2], ["LPfp", 34.7, 17.5, 37.5, 2], ["LPfp", 35.4, 18.5, 37.5, 2], // T
  ["LPfp", 45.3, 10.2, 37.5, 2], ["ZWsw", 46.2, 11.3, 37.5, 2],                        // E
  ["LPfp", 9.3, 22, 37.5, 2], ["LPfp", 9.7, 22.3, 37.5, 2], ["LPfp", 10.6, 21.4, 37.5, 2], ["ZWsw", 11.4, 23, 37.5, 2], // J
  ["LPfp", 62.9, 10, 37.5, 2], ["ZWsw", 63.3, 10.6, 37.5, 2],                          // H: past 63.5 after the nudge
  ["LPfp", 20, 30, 37.5, 2], ["ZPsh", 22, 30, 37.5, 2],                                // dry ground
  // Appended (the indices above stay): a non-floating doodad on D's slope (whose ground: the editor's between
  // corners), life and scale (ZPsh and LPfp 0.8 to 1.2), a fixed one with life 0, a destructable with life 50.
  ["ZPsh", 32.3, 9.4, 37.5, 2],
  ["ZPsh", 20, 32, 37.5, 2, 50, [3, 0.2, 1]], ["LPfp", 22, 32, 37.5, 6, 0, [0.5, 1.1, 1.3]],
  ["LTlt", 36, 40, 37.5, 2, 50],
];

/** A section's rows as the text keeps them: the top row (y = 64) first. */
const rows = (f, sep = "") => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, i) => f(i, N - 1 - r)).join(sep));
const at = (i, j) => corners.get(`${i},${j}`) ?? { ground: 0, water: -89.6, wet: false, layer: 2 };
/** A corner of a tile with corners on two levels. */
const onCliff = (i, j) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([di, dj]) => {
  const ti = i + di, tj = j + dj;
  if (ti < 0 || tj < 0 || ti + 1 >= N || tj + 1 >= N) return false;
  const levels = new Set([at(ti, tj), at(ti + 1, tj), at(ti, tj + 1), at(ti + 1, tj + 1)].map((c) => c.layer));
  return levels.size > 1;
});
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "water-z");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  // The text's height is the stored word less 0x2000 (a quarter world unit, the level not counted), its water the stored
  // level less 0x2000 (world level + 89.6, times 4), its flags the corner's high nibble (4: water).
  const sections = {
    height: rows((i, j) => String(Math.round((at(i, j).ground - (at(i, j).layer - 2) * 128) * 4)), " "),
    water: rows((i, j) => String(Math.round((at(i, j).water + 89.6) * 4)), " "),
    layer: rows((i, j) => String(at(i, j).layer)),
    flags: rows((i, j) => (at(i, j).wet ? "4" : "0")),
    // Grass Cliff (cliff type 1) on the corners of E's cliff, as the editor's Cliff Increase leaves them (make-plateau.mjs).
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
  doo.doodads = DOODADS.map(([id, i, j, z, flags, life = 100, scale = [1, 1, 1]], k) => ({
    id, variation: 0, position: [X(i), X(j), z], angle: (270 * Math.PI) / 180, scale, skinId: id,
    preFlags: 4294967295, flags, life, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [k, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  run("pack", dir, "-o", join(here, "doodad-water-z.w3x"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
