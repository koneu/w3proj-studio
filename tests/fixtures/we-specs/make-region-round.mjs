// Makes region-round.w3m, the input of tests/we-compare/region-round.json: regions whose edges are off the 32 grid,
// to see what the World Editor's open and save do to them (bugs.md "The WE rounds region edges to the 32 grid"). From
// the empty 64 x 64 map (map -4096..4096 both ways):
//
//   node tests/fixtures/we-specs/make-region-round.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli>
//
// Each region's name says what it holds: halves (an edge 16 past the grid, both signs), just under and over a half
// (15.9, 16.1), a region thinner than the grid (8 wide), one whose edges round to the same line (left 40, right 50),
// fractions, one touching the map's edges by less than a cell, and two whose left and right (bottom and top) both round
// to one line (40..47, -47..-40).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [empty, cli] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
if (!cli) { console.error("usage: make-region-round.mjs <empty map> <w3proj cli>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
// name, left, bottom, right, top
const REGIONS = [
  ["halvesPos", 16, 48, 112, 1008],
  ["halvesNeg", -1008, -112, -48, -16],
  ["nearHalf", 15.9, 16.1, 47.9, 48.1],
  ["nearHalfNeg", -16.1, -15.9, -48.1 + 64, -47.9 + 64],
  ["thin", 200, 200, 208, 400],
  ["sameLine", 40, 300, 50, 500],
  ["fractions", -1000.25, -3600.75, 100.5, 333.3],
  ["edges", -4090, -4095.5, 4090, 4095.5],
  ["collapse", 40, 600, 47, 700],
  ["collapseNeg", -1000, -47, -900, -40],
];
const scratch = mkdtempSync(join(tmpdir(), "we-specs-region-round-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const regionsFile = join(dir, "map", "war3map.w3r.json");
  const regions = JSON.parse(readFileSync(regionsFile, "utf8"));
  regions.regions = REGIONS.map(([name, left, bottom, right, top], index) => ({
    left, bottom, right, top, name, index, weather: "0x00000000", sound: "", color: { blue: 255, green: 128, red: 128, alpha: 255 },
    ...(regions.version >= 7 ? { trailer: [0, 0] } : {}),
  }));
  writeFileSync(regionsFile, JSON.stringify(regions, null, 2));
  run("pack", dir, "-o", join(here, "region-round.w3m"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${join(here, "region-round.w3m")}`);
