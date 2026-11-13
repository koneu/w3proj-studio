// Makes mine-start-grid.w3m, the input map of tests/we-compare/mine-start-grid.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-mine-start-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Player 1's start location at -2141, 675 and four Neutral Passive gold mines off the grid, and two camera objects (the
// views the spec's clicks are aimed in, picked on the editor's camera palette as we-drive's --look picks its own:
// rows 1 and 2), made by we-camera.mjs as --look makes them.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addLookCameras, parseLook, resolveLook, terrainHead } from "../../../app/scripts/we-camera.mjs";

const [empty, cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-mine-start-input.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const UNITS = [["sloc", -2141, 675, 0], ["ngol", 1000, 300, 27], ["ngol", -1000, -1000, 27], ["ngol", 3250, -1000, 27], ["ngol", 1700, 2900, 27]];
const LOOKS = ["1000,300,2000", "-2141,675,2000"];
const scratch = mkdtempSync(join(tmpdir(), "we-compare-mine-start-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
  const map = join(dir, "map");
  const unitsFile = join(map, "war3mapUnits.doo.json");
  const units = JSON.parse(readFileSync(unitsFile, "utf8"));
  // The map's own start location is the template: its fields as the editor wrote them (a gold mine's as the editor
  // places one: Neutral Passive, level 1, hit points and mana -1, 12500 gold).
  const template = units.units[0];
  units.units = UNITS.map(([id, x, y, player], i) => ({
    ...template, id, skinId: id, position: [x, y, 0], player, editorId: i, trailer: [0, 0],
    ...(id === "ngol" ? { hp: -1, mana: -1, level: 1, gold: 12500, targetAcquisition: -1 } : {}),
  }));
  writeFileSync(unitsFile, JSON.stringify(units, null, 1));
  const head = terrainHead(readFileSync(join(map, "war3map.w3e.txt"), "utf8"));
  const camerasFile = join(map, "war3map.w3c.json");
  const cameras = JSON.parse(readFileSync(camerasFile, "utf8"));
  writeFileSync(camerasFile, `${JSON.stringify(addLookCameras(cameras, LOOKS.map((s) => resolveLook(parseLook(s), head))), null, 2)}\n`);
  run("pack", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
