// Makes replace-units-newring.w3m, the input map of tests/we-compare/replace-units-newring.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-replace-units-newring-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Replace Units footman -> altar (halt, 10x10Simple: red 6x6 in the middle, blue two cells round it) where the NEW
// building's blue ring, not its red part, reaches into another building's red: does the editor count the new
// building's own no-build cells against the others? Each footman on a 128 grid point of its own cell, a farm (hhou,
// 4x4 solid red) west of it at d (the farm's red edge d - 64 from the footman, the altar's red edge 96, its blue 160):
//   n1 d 160 (the reds touch, the blue covers the farm's two east columns), n2 d 192 (blue 32 into the farm's red, a
//   cell of red between), n3 d 224 (the blue reaches the farm's edge: the control), n4 the farm d 192 south of the
//   footman instead of west, n5 d 288 (far: the control), n6 d 128 (the reds overlap: refused either way).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFresh } from "../../binfresh.mjs";

const [empty, cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-replace-units-newring-input.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const CELLS = [[-1024, 1024], [0, 1024], [1024, 1024], [-1024, -512], [0, -512], [1024, -512]];
/** The farm's offset from its footman. */
const FARMS = [[-160, 0], [-192, 0], [-224, 0], [0, -192], [-288, 0], [-128, 0]];
const UNITS = [];
CELLS.forEach(([x, y]) => UNITS.push(["hfoo", x, y]));
CELLS.forEach(([x, y], i) => UNITS.push(["hhou", x + FARMS[i][0], y + FARMS[i][1]]));
const scratch = mkdtempSync(join(tmpdir(), "we-compare-replace-units-newring-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const map = join(dir, "map");
  const unitsFile = join(map, "war3mapUnits.doo.json");
  const units = JSON.parse(readFileSync(unitsFile, "utf8"));
  const template = units.units[0];
  // The map's own start location stays (the editor makes one where the map has none, and Studio another).
  units.units = [template, ...UNITS.map(([id, x, y], i) => ({
    ...template, id, skinId: id, position: [x, y, 0], player: 0, hp: -1, mana: -1, level: 1, targetAcquisition: -1, editorId: i + 1, trailer: [0, 0],
  }))];
  writeFileSync(unitsFile, JSON.stringify(units, null, 1));
  run("pack", "--keep-objects", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
