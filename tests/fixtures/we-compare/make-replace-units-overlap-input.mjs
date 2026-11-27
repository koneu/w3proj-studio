// Makes replace-units-overlap.w3m, the input map of tests/we-compare/replace-units-overlap*.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-replace-units-overlap-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Player 1's footmen (hfoo) for Replace Units footman -> farm (hhou), gold mine (ngol) or barracks (hbar), each in a
// cell of its own, 512 apart, at (X + 20, Y + 20) off the building grids. Beside each, what its new building would meet:
//   c1 nothing; c2, c3, c4 a tree LTlt 96, 160, 224 west; c5, c6 a peasant (hpea) 96, 160 west; c7 crates LTcr 128 west;
//   c8 a farm 192 west; c9 a pathless doodad LPcr 96 west; c10 an item (ratf) 96 west; c11 a second footman 96 west
//   (both are replaced, one by one); c12 a doodad LOsh 96 west; c13 a tree 96 east; c14 a tree 96 south.
//   c15 a barracks (hbar: 8x8 pixels of no-walk in 12x12 of no-build) 224 west: a farm's 4x4 reaches its no-build ring.
// (A first version had them east, c13's west: a farm lands on the grid point nearest its footman, 20 west of it,
// so only c13's tree was under it.)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFresh } from "../../binfresh.mjs";

const [empty, cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!out) { console.error("usage: make-replace-units-overlap-input.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const CELLS = [[-1536, 512], [-1024, 512], [-512, 512], [0, 512], [512, 512], [1024, 512], [1536, 512],
  [-1536, -512], [-1024, -512], [-512, -512], [0, -512], [512, -512], [1024, -512], [1536, -512], [-1536, 1536]];
const at = (c, dx, dy) => [CELLS[c - 1][0] + 20 + dx, CELLS[c - 1][1] + 20 + dy];
const UNITS = [];
for (let c = 1; c <= 15; c++) UNITS.push(["hfoo", ...at(c, 0, 0)]);
UNITS.push(["hpea", ...at(5, -96, 0)], ["hpea", ...at(6, -160, 0)], ["hhou", ...at(8, -192, 0)], ["ratf", ...at(10, -96, 0)], ["hfoo", ...at(11, -96, 0)], ["hbar", ...at(15, -224, 0)]);
const DOODADS = [["LTlt", ...at(2, -96, 0)], ["LTlt", ...at(3, -160, 0)], ["LTlt", ...at(4, -224, 0)], ["LTcr", ...at(7, -128, 0)],
  ["LPcr", ...at(9, -96, 0)], ["LOsh", ...at(12, -96, 0)], ["LTlt", ...at(13, 96, 0)], ["LTlt", ...at(14, 0, -96)]];
const NEUTRAL_PASSIVE = 27;
const scratch = mkdtempSync(join(tmpdir(), "we-compare-replace-units-overlap-"));
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
    ...template, id, skinId: id, position: [x, y, 0], player: id === "ratf" ? NEUTRAL_PASSIVE : 0, hp: -1, mana: -1,
    ...(id === "ratf" ? { level: 0, targetAcquisition: 0 } : { level: 1, targetAcquisition: -1 }), editorId: i + 1, trailer: [0, 0],
  }))];
  writeFileSync(unitsFile, JSON.stringify(units, null, 1));
  const dooFile = join(map, "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  doo.doodads = DOODADS.map(([id, x, y], i) => ({
    id, variation: 0, position: [x, y, 0], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: id, preFlags: 4294967295,
    flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [i, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  run("pack", "--keep-objects", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
