// Makes camera-bounds.w3m, the input map of tests/we-compare/camera-bounds-*.json, from the empty 64x64 map (camera
// bounds x -2816..2816, y -3328..2816; playable part to 3328; map to 4096):
//
//   node tests/fixtures/we-compare/make-camera-bounds-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Inside the camera bounds, near their right side: a footman (2432, 0) and a pathless doodad LPcr (2432, -512), the
// ones the specs copy and paste. Already outside them: a footman (3136, 1024) and an LPcr (3136, -1024). And camera
// objects (LOOKS, rows of the camera palette from 1396,177 down, 13 px a row, picked as we-drive's --look does): the
// first looks at 2816, 0 from 3000 (the view the paste's clicks are aimed in: the ground on both sides of the bounds),
// the others are the views Create Camera is tried from: past the right bound (3000), inside (2700), the target inside
// with the eye south of the map (0, -3000), the target past the top bound with the eye inside (0, 2900), just past the
// right bound (2820), and a near one (2700, 300 from 500).
//
// The fifth argument is a list of looks x,y,distance (or x,y,distance,far,near with the camera's clipping) joined by ';'.
// camera-farz.w3m (tests/we-compare/camera-farz.json) is made by
//   node tests/fixtures/we-compare/make-camera-bounds-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> camera-farz.w3m \
//     "0,0,500;0,0,1000,9000,50;0,0,1650;0,0,2000,9000,50;0,0,2500;0,0,3000,9000,50;0,0,4000;0,0,5000,9000,50"
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addLookCameras, parseLook, resolveLook, terrainHead } from "../../../app/scripts/we-camera.mjs";
import { requireFresh } from "../../binfresh.mjs";

const [empty, cli, out] = process.argv.slice(2, 5).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!out) { console.error("usage: make-camera-bounds-input.mjs <empty map> <w3proj cli> <out.w3m> [looks, ';' between them]"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const UNITS = [["hfoo", 2432, 0], ["hfoo", 3136, 1024]];
const DOODADS = [["LPcr", 2432, -512], ["LPcr", 3136, -1024]];
// Another list of cameras for a measurement (the fifth argument) makes a map of its own, not the specs' input.
const LOOKS = process.argv[5]?.split(";") ?? ["2816,0,3000", "3000,0,3000", "2700,0,3000", "0,-3000,3000", "0,2900,3000", "2820,0,3000", "2700,300,500"];
const scratch = mkdtempSync(join(tmpdir(), "we-compare-cambounds-"));
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
  units.units = [template, ...UNITS.map(([id, x, y], i) => ({ ...template, id, skinId: id, position: [x, y, 0], player: 0, hp: -1, mana: -1, editorId: i + 1, trailer: [0, 0] }))];
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
  // A look of five values is x,y,distance,far,near (the camera's clipping, else the editor's 5000 / 100); fewer are parseLook's.
  const clip = LOOKS.map((l) => { const p = l.split(",").map((v) => v.trim()); return p.length === 5 ? { far: Number(p[3]), near: Number(p[4]) } : null; });
  clip.forEach((c, i) => { if (c && !(c.far > 0 && c.near > 0)) throw new Error(`look "${LOOKS[i]}": far and near must be numbers above 0`); });
  const made = addLookCameras(cameras, LOOKS.map((l, i) => resolveLook(parseLook(clip[i] ? l.split(",").slice(0, 3).join(",") : l), head)));
  clip.forEach((c, i) => { if (c) { made.cameras[i].farZ = c.far; made.cameras[i].nearZ = c.near; } });
  writeFileSync(camerasFile, `${JSON.stringify(made, null, 2)}\n`);
  run("pack", "--keep-objects", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
