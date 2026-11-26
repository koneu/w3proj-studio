// Makes resize-objects.w3m, the input of tests/we-compare/resize-objects.json: what Map Size does to regions and camera
// objects. From the empty 64 x 64 map (map -4096..4096 both ways, camera bounds x ±2816, y -3328..2816):
//
//   node tests/fixtures/we-specs/make-resize-objects.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> [bounds]
//
// "bounds" writes resize-bounds.w3m instead (tests/we-compare/resize-bounds.json): no regions, camera objects on and
// beside the bounds a cut of 4 tiles on the left and on top makes (x -2304, y 2304), which a change of the camera
// bounds alone by one arrow click on each of those sides makes too, and on and beside the right bound that stays (2816).
// "strings" writes resize-strings.w3m (tests/we-compare/resize-strings.json): the bounds variant's map with plain texts
// in every text field of war3map.w3i (loading screen and prologue texts, a player's and a force's name besides the
// map's name, author, description and suggested players, which the empty map has as plain text already), the loading
// screen crest race 3 and the game data set 1: what Map Size does to them.
//
// Regions (named by what a cut of 4 tiles on the left and on top, to -3584 and 3584, does to them): one inside, one
// across the new left edge, one wholly in the cut part on the left, one across the new top edge, one in the north-west
// corner across both, one 32 wide ending on the new left edge, one as large as the map, one more inside. Camera
// objects: one in the middle, one in the cut part on the left, one in the cut part on top, one on the new left edge, one
// already west of the map, one between the left camera bound and where a growth by 4 tiles takes it (-3000), one just
// inside the left bound (-2800, outside it after the cut), one past the right bound (3000), one well inside.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [empty, cli] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
const variant = process.argv[4];
if (!cli || (variant !== undefined && variant !== "bounds" && variant !== "strings")) { console.error("usage: make-resize-objects.mjs <empty map> <w3proj cli> [bounds | strings]"); process.exit(2); }
const strings = variant === "strings";
const bounds = variant === "bounds" || strings;
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
// name, left, bottom, right, top
// All on the 32 grid: the World Editor rounds a region's edges to it when it opens a map (to the nearest, halves up:
// -1000 to -992, -3600 to -3584; the control spec resize-objects-open, 2026-11-18), which Studio doesn't.
const REGIONS = [
  ["inside", -992, -992, 992, 992],
  ["leftAcross", -3968, 0, -3008, 512],
  ["leftGone", -4096, -512, -3712, 0],
  ["topAcross", 0, 3008, 512, 3968],
  ["corner", -4096, 3488, -3488, 4096],
  ["thinOnEdge", -3616, 0, -3584, 96],
  ["whole", -4096, -4096, 4096, 4096],
  ["aligned", -2048, -2048, -1024, -1024],
];
// name, target x, target y
const CAMERAS = [["middle", 0, 0], ["cutLeft", -3800, 0], ["cutTop", 0, 3800], ["onEdge", -3584, 0], ["westOfMap", -5000, 0],
  ["growIn", -3000, 0], ["nearBound", -2800, 0], ["rightOut", 3000, 0], ["inside", -1000, 500]];
// The bounds variant: on the new left bound, a hair and one unit either side of it, the same on the new top bound, the
// new corner, and on the right bound that a cut on the left and top leaves (2816), and half a unit and one unit past it.
const BOUND_CAMERAS = [["onLeft", -2304, 0], ["pastLeft", -2304.5, 0], ["pastLeft1", -2305, 0], ["insideLeft", -2303.5, 0],
  ["onTop", 0, 2304], ["pastTop", 0, 2304.5], ["insideTop", 0, 2303.5], ["onCorner", -2304, 2304],
  ["onRight", 2816, 0], ["pastRight", 2816.5, 0], ["pastRight1", 2817, 0], ["middle", 0, 0]];
const scratch = mkdtempSync(join(tmpdir(), "we-specs-resize-objects-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const map = join(dir, "map");
  const regionsFile = join(map, "war3map.w3r.json");
  const regions = JSON.parse(readFileSync(regionsFile, "utf8"));
  regions.regions = (bounds ? [] : REGIONS).map(([name, left, bottom, right, top], index) => ({
    left, bottom, right, top, name, index, weather: "0x00000000", sound: "", color: { blue: 255, green: 128, red: 128, alpha: 255 },
    ...(regions.version >= 7 ? { trailer: [0, 0] } : {}),
  }));
  writeFileSync(regionsFile, JSON.stringify(regions, null, 2));
  const camerasFile = join(map, "war3map.w3c.json");
  const cameras = JSON.parse(readFileSync(camerasFile, "utf8"));
  cameras.version = 3;
  cameras.cameras = (bounds ? BOUND_CAMERAS : CAMERAS).map(([name, targetX, targetY]) => ({
    targetX, targetY, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, farZ: 5000, nearZ: 100,
    localPitch: 0, localYaw: 0, localRoll: 0, dofDistance: 0, dofScale: 0, posAbsoluteZ: 0, name, trailer: 0,
  }));
  writeFileSync(camerasFile, JSON.stringify(cameras, null, 2));
  if (strings) {
    const infoFile = join(map, "war3map.w3i.json");
    const info = JSON.parse(readFileSync(infoFile, "utf8"));
    Object.assign(info.loadingScreen, { crestRace: 3, text: "Loading text", title: "Loading title", subtitle: "Loading subtitle" });
    Object.assign(info.prologue, { text: "Prologue text", title: "Prologue title", subtitle: "Prologue subtitle" });
    info.gameDataSet = 1;
    info.players[0].name = "Plain player";
    info.forces[0].name = "Plain force";
    writeFileSync(infoFile, JSON.stringify(info, null, 2));
  }
  run("pack", dir, "-o", join(here, strings ? "resize-strings.w3m" : bounds ? "resize-bounds.w3m" : "resize-objects.w3m"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
