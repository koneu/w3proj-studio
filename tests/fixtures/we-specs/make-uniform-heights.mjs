// Makes uniform-heights.w3x for the Set Uniform Doodad Heights spec (tests/we-compare/uniform-heights.json) from
// slope.w3x (ground rising 6 world units a corner along x, no doodads):
//
//   node tests/fixtures/we-specs/make-uniform-heights.mjs <w3proj cli> <game folder>
//
// Five hay carts (LOch) in a row along y = 0, 600 apart: three follow the ground (flags 2) and two have a height of their
// own (flags 6, fixed height) at 100 and 300 above sea level.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-uniform-heights.mjs <w3proj cli> <game folder>"); process.exit(2); }
const slope = join(here, "slope.w3x");
if (!existsSync(slope)) { console.error("slope.w3x is missing: run make-slope.mjs first (same arguments)"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

// [x, flags, z]
const CARTS = [[-1500, 2, 0], [-900, 6, 100], [-300, 2, 0], [300, 6, 300], [900, 2, 0]];

const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "uniform");
  run("unpack", join(here, "slope.w3x"), dir, "--game", game);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const file = join(dir, "map", "war3map.doo.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  CARTS.forEach(([x, flags, z], i) => doc.doodads.push({
    id: "LOch", variation: 0, position: [x + 13.5, 21.25, z], angle: 0, scale: [1, 1, 1], skinId: "LOch",
    preFlags: 4294967295, flags, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [i, 0, 0], extras: [] }));
  writeFileSync(file, JSON.stringify(doc, null, 2));
  run("pack", "--keep-objects", dir, "-o", join(here, "uniform-heights.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
