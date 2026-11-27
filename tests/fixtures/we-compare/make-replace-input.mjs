// Makes replace-units.w3m, the input map of tests/we-compare/replace-units.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-replace-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Player 1's footmen off the 64 grid, one with both halves of a grid step (2016, -1056: 31.5 and -16.5 steps), for
// the editor's Advanced > Replace Units to turn into gold mines (a 16x16 pathing texture: the 64 grid).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFresh } from "../../binfresh.mjs";

const [empty, cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!out) { console.error("usage: make-replace-input.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const FOOTMEN = [[1000, 300], [-1010, -470], [1530, 1530], [33, -95], [2016, -1056]];
const scratch = mkdtempSync(join(tmpdir(), "we-compare-replace-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const map = join(dir, "map");
  const unitsFile = join(map, "war3mapUnits.doo.json");
  const units = JSON.parse(readFileSync(unitsFile, "utf8"));
  // The map's own start location stays (the editor makes one where the map has none, and Studio another).
  const template = units.units[0];
  units.units = [template, ...FOOTMEN.map(([x, y], i) => ({ ...template, id: "hfoo", skinId: "hfoo", position: [x, y, 0], player: 0, hp: -1, mana: -1, editorId: i + 1, trailer: [0, 0] }))];
  writeFileSync(unitsFile, JSON.stringify(units, null, 1));
  run("pack", "--keep-objects", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
