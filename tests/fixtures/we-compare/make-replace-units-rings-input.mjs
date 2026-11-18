// Makes replace-units-rings.w3m, the input map of tests/we-compare/replace-units-rings.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-replace-units-rings-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Replace Units footman -> farm (hhou, 4x4 solid: it lands on the grid point 20 west of its footman) beside buildings
// whose pathing texture has a no-build (blue) ring round its no-walk (red) part, other than the barracks, gold mine and
// farm of replace-units-overlap: each footman at (X + 20, Y + 20) of its own cell, the building west of it at
// (X + 20 - d, Y + 20) so the farm reaches 16 into its ring's outer side, not its red part (r1 to r4), or misses the
// ring by 16 (r5, r6, the controls):
//   r1 altar halt (10x10Simple: red 6x6, blue 2 cells round) d 208; r2 town hall htow (16x16Simple, red 12x12) d 304;
//   r3 tree of life etol (12x12TreeOfLife, red 8x8) d 240; r4 necropolis unpl (UndeadNecropolis: red 8x8, blue 4 cells
//   west and east) d 288; r5 necropolis d 336; r6 town hall d 336.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFresh } from "../../binfresh.mjs";

const [empty, cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-replace-units-rings-input.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const CELLS = [[-1024, 1024], [0, 1024], [1024, 1024], [-1024, -512], [0, -512], [1024, -512]];
const NEIGHBOURS = [["halt", 208], ["htow", 304], ["etol", 240], ["unpl", 288], ["unpl", 336], ["htow", 336]];
const UNITS = [];
CELLS.forEach(([x, y]) => UNITS.push(["hfoo", x + 20, y + 20]));
CELLS.forEach(([x, y], i) => UNITS.push([NEIGHBOURS[i][0], x + 20 - NEIGHBOURS[i][1], y + 20]));
const scratch = mkdtempSync(join(tmpdir(), "we-compare-replace-units-rings-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
  const map = join(dir, "map");
  const unitsFile = join(map, "war3mapUnits.doo.json");
  const units = JSON.parse(readFileSync(unitsFile, "utf8"));
  const template = units.units[0];
  // The map's own start location stays (the editor makes one where the map has none, and Studio another).
  units.units = [template, ...UNITS.map(([id, x, y], i) => ({
    ...template, id, skinId: id, position: [x, y, 0], player: 0, hp: -1, mana: -1, level: 1, targetAcquisition: -1, editorId: i + 1, trailer: [0, 0],
  }))];
  writeFileSync(unitsFile, JSON.stringify(units, null, 1));
  run("pack", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
