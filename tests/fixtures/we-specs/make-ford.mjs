// Makes ford.w3x for the ship rule spec (tests/we-compare/ford-wpm.json) from flat.w3x (the World Editor's own new
// 64x64 Lordaeron Summer map, level 2 everywhere):
//
//   node tests/fixtures/we-specs/make-ford.mjs <w3proj cli> <game folder>
//
// One water surface over corner rows 20 to 44 (stored level 360: 90 - 89.6 = 0.4 world units, Lordaeron's water lies
// 89.6 below its stored level), the ground under it lowered in bands of three corner columns from column 8 eastwards,
// so the water gets deeper band by band: 2.4, 6.4, 12.4, 20.4, 30.4, 38.4, 45.4, 50.4, 51.4, 51.9, 52.4, 53.4, 56.4,
// 70.4, 102.4, 160.4 world units (the band of column 8 + 3i has DEPTHS[i]). A band's two inner tiles (columns 8 + 3i
// to 10 + 3i) are all of one depth. The stored war3map.wpm is flat.w3x's (all dry ground): the pack keeps it stale, so
// the World Editor's save shows the pathing map it makes itself.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const DEPTHS = [2.4, 6.4, 12.4, 20.4, 30.4, 38.4, 45.4, 50.4, 51.4, 51.9, 52.4, 53.4, 56.4, 70.4, 102.4, 160.4];
const WATER = 360, FIRST = 8, ROWS = [20, 44];

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-ford.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
/** Replaces the "[name] all v" line of a section with 65 rows from `row(y)`. */
const section = (lines, name, row) => {
  const at = lines.findIndex((l) => l.startsWith(`[${name}]`));
  if (at < 0 || !/ all /.test(lines[at])) throw new Error(`no "[${name}] all" line in the w3e text`);
  lines.splice(at, 1, `[${name}]`, ...Array.from({ length: 65 }, (_, y) => row(y)));
};
const wet = (y) => y >= ROWS[0] && y <= ROWS[1];
// Ground under the water: depth = (WATER - height) / 4 - 89.6, so height = WATER - 4 (depth + 89.6).
const ground = (x) => {
  const band = Math.floor((x - FIRST) / 3);
  return band >= 0 && band < DEPTHS.length ? Math.round(WATER - 4 * (DEPTHS[band] + 89.6)) : 0;
};
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "ford");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const file = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(file, "utf8").split("\n");
  section(lines, "height", (y) => Array.from({ length: 65 }, (_, x) => (wet(y) ? ground(x) : 0)).join(" "));
  section(lines, "water", () => Array.from({ length: 65 }, () => WATER).join(" "));
  section(lines, "flags", (y) => (wet(y) ? "4" : "0").repeat(65));
  writeFileSync(file, lines.join("\n"));
  run("pack", dir, "-o", join(here, "ford.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
