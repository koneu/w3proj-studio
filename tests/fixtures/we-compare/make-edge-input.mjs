// Makes edge-last-step.w3m, the input map of tests/we-compare/edge-last-step.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-edge-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Near the map's right edge (4096; playable part 3328): a footman (3200, 512), a farm hhou (3136, -1024), a tree
// LTlt (3584, 1024) and a pathless LPcr (3584, -512); and a camera object looking at 3456, 0 from 3000 (the view the
// spec's box selects are aimed in, picked on the camera palette as we-drive's --look does).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addLookCameras, parseLook, resolveLook, terrainHead } from "../../../app/scripts/we-camera.mjs";

const [empty, cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-edge-input.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const UNITS = [["hfoo", 3200, 512], ["hhou", 3136, -1024]];
const DOODADS = [["LTlt", 3584, 1024], ["LPcr", 3584, -512]];
const scratch = mkdtempSync(join(tmpdir(), "we-compare-edge-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
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
  writeFileSync(camerasFile, `${JSON.stringify(addLookCameras(cameras, [resolveLook(parseLook("3456,0,3000"), head)]), null, 2)}\n`);
  run("pack", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
