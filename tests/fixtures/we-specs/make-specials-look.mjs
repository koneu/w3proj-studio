// Makes target/specials-look/specials-look.w3x for the special doodad pictures (test.md "Specials against the WE"):
// plateau.w3x (level 2 with a level 3 plateau, corners x 25..39, y 27..35, a Grass Cliff face on every side) with
// special doodads (war3map.doo's second list, placed by tile) in four groups:
//   flatA  y 12: YCd1 YCd2 YCd3 YCd4 (city cliff collapses) YCl2     x 22 27 32 37 42
//   flatB  y 18: YCc1 YCc2 YCc3 YCc4 (city caves) LCc0               x 22 27 32 37 42
//   flatC  y 44: LCc2 YCg1 YCp2 YCu2 YCr2                            x 22 27 32 37 42
//   cliffs on the plateau's two-layer faces: south (y 27) YCl2 YCd2 LCc0, north (y 34) YCg2 YCc2 LCc2,
//          west (x 25) LCc0 at y 29 and YCr2 at y 32, east (x 38) YCd1 at y 29 and YCc3 at y 32
//
//   node tests/fixtures/we-specs/make-specials-look.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
//
// A tile (x, y) is world -4096 + x * 128, -4096 + y * 128. Look at a group with we-drive `--look X,Y,D` and
// app-drive `--camera we:X,Y,D`: flatA 0,-2560; flatB 0,-1792; flatC 0,1536; the plateau 0,-128.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-specials-look.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "specials-look");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const row = (ids, y) => ids.map((id, k) => ({ id, z: 0, x: 22 + 5 * k, y }));
const SPECIALS = [
  ...row(["YCd1", "YCd2", "YCd3", "YCd4", "YCl2"], 12),
  ...row(["YCc1", "YCc2", "YCc3", "YCc4", "LCc0"], 18),
  ...row(["LCc2", "YCg1", "YCp2", "YCu2", "YCr2"], 44),
  { id: "YCl2", z: 0, x: 27, y: 27 }, { id: "YCd2", z: 0, x: 31, y: 27 }, { id: "LCc0", z: 0, x: 35, y: 27 },
  { id: "YCg2", z: 0, x: 27, y: 34 }, { id: "YCc2", z: 0, x: 31, y: 34 }, { id: "LCc2", z: 0, x: 35, y: 34 },
  { id: "LCc0", z: 0, x: 25, y: 29 }, { id: "YCr2", z: 0, x: 25, y: 32 },
  { id: "YCd1", z: 0, x: 38, y: 29 }, { id: "YCc3", z: 0, x: 38, y: 32 },
];
const scratch = mkdtempSync(join(tmpdir(), "we-specials-look-"));
try {
  const dir = join(scratch, "map");
  run("unpack", join(here, "plateau.w3x"), dir, "--game", game);
  const dooFile = join(dir, "map", "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  doo.specials = SPECIALS;
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  mkdirSync(out, { recursive: true });
  run("pack", dir, "-o", join(out, "specials-look.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${join(out, "specials-look.w3x")}`);
