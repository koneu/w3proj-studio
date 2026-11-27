// Makes paste-centre.w3m, the input map of tests/we-compare/paste-centre.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-paste-centre-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Objects to copy and paste, off the 64 grid, in the view of a camera object looking at 0, 200 from 4000, all well
// inside the view (a box select near its top edge scrolls the view; picked on the camera palette as we-drive's --look
// does): single doodads in a row at y 1000 (a pathless LPcr, a barrel LTbs with a 2x2 texture, a tree LTlt 4x4, a
// doodad LOsh 2x2), groups at y 650 (barrel + LPcr, two LPcr,
// LOsh + tree, barrel + tree), units at y -650 (a footman, an item ratf, a farm hhou 4x4, footman + farm, footman +
// item). The editor moves each doodad with a texture onto its grid when it loads the map; the rest stay where they are.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addLookCameras, parseLook, resolveLook, terrainHead } from "../../../app/scripts/we-camera.mjs";
import { requireFresh } from "../../binfresh.mjs";

const [empty, cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!out) { console.error("usage: make-paste-centre-input.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const DOODADS = [
  ["LPcr", -901.3, 1013.7], ["LTbs", -500, 1000], ["LTlt", -100, 1000], ["LOsh", 300, 1000],
  ["LTbs", -900, 650], ["LPcr", -783.6, 701.2],
  ["LPcr", -405.1, 640.3], ["LPcr", -291.7, 688.9],
  ["LOsh", 100, 650], ["LTlt", 230, 650],
  ["LTbs", 600, 650], ["LTlt", 730, 650],
];
const UNITS = [
  ["hfoo", -900.4, -650.6], ["ratf", -550.2, -640.9], ["hhou", -200, -650],
  ["hfoo", 150.7, -650.3], ["hhou", 290, -650],
  ["hfoo", 600.9, -650.2], ["ratf", 700.3, -610.7],
];
const NEUTRAL_PASSIVE = 27;
const scratch = mkdtempSync(join(tmpdir(), "we-compare-paste-"));
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
  const head = terrainHead(readFileSync(join(map, "war3map.w3e.txt"), "utf8"));
  const camerasFile = join(map, "war3map.w3c.json");
  const cameras = JSON.parse(readFileSync(camerasFile, "utf8"));
  writeFileSync(camerasFile, `${JSON.stringify(addLookCameras(cameras, [resolveLook(parseLook("0,200,4000"), head)]), null, 2)}\n`);
  run("pack", "--keep-objects", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
