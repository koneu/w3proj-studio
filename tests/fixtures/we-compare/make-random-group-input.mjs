// Makes random-group.w3m, the input map of tests/we-compare/random-group-scatter.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-random-group-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// One random group ("Three", number 0) with one unit position and three lines of different units (footman, knight,
// rifleman), and a camera object looking at 0, 0 from 2000 (picked on the editor's camera palette as we-drive's --look
// picks its own: row 1), made by we-camera.mjs as --look makes them. The map's start location stays.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addLookCameras, parseLook, resolveLook, terrainHead } from "../../../app/scripts/we-camera.mjs";

const [empty, cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-random-group-input.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const LOOKS = ["0,0,2000"];
const GROUP = { number: 0, name: "Three", positions: [0], lines: [{ chance: 34, ids: ["hfoo"] }, { chance: 33, ids: ["hkni"] }, { chance: 33, ids: ["hrif"] }] };
const scratch = mkdtempSync(join(tmpdir(), "we-compare-random-group-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
  const map = join(dir, "map");
  const infoFile = join(map, "war3map.w3i.json");
  const info = JSON.parse(readFileSync(infoFile, "utf8"));
  info.unitTables = [GROUP];
  writeFileSync(infoFile, JSON.stringify(info, null, 1));
  // One placed unit of the group at 0, 0 (Player 1), modelled on the map's start location as the editor wrote it.
  const unitsFile = join(map, "war3mapUnits.doo.json");
  const units = JSON.parse(readFileSync(unitsFile, "utf8"));
  const template = units.units[0];
  units.units.push({
    ...template, id: "uDNR", skinId: "uDNR", position: [0, 0, 0], player: 0, hp: -1, mana: -1, level: 1, gold: 12500,
    targetAcquisition: -1, randomType: 1, randomGroup: 0, randomPosition: 0, editorId: 1, trailer: [0, 0],
  });
  delete units.units[1].randomLevel;
  delete units.units[1].randomClass;
  writeFileSync(unitsFile, JSON.stringify(units, null, 1));
  const head = terrainHead(readFileSync(join(map, "war3map.w3e.txt"), "utf8"));
  const camerasFile = join(map, "war3map.w3c.json");
  const cameras = JSON.parse(readFileSync(camerasFile, "utf8"));
  writeFileSync(camerasFile, `${JSON.stringify(addLookCameras(cameras, LOOKS.map((s) => resolveLook(parseLook(s), head))), null, 2)}\n`);
  run("pack", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
