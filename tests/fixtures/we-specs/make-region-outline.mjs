// Makes region-outline.w3m: regions that cross the playable map's edge, to measure the region outline's width and where it
// runs against the World Editor (lowprio-bugs.md "Region outline"). From region-round.w3m (the empty 64 x 64 map, map
// -4096..4096, playable -3584..3584 as the picture shows):
//
//   node tests/fixtures/we-specs/make-region-outline.mjs <w3proj cli>
//
// "west" crosses the west edge (x -3584) and "south" the south edge (y -3584), pure yellow; "inside" lies wholly in the
// playable part, pure red, for the line's width there.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = process.argv[2] ? resolve(process.argv[2]) : null;
if (!cli) { console.error("usage: make-region-outline.mjs <w3proj cli>"); process.exit(2); }
requireFresh(cli, "cli");
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
// name, left, bottom, right, top, red, green, blue
const REGIONS = [
  ["west", -3968, -640, -3200, 640, 255, 255, 0],
  ["south", -640, -3968, 640, -3200, 255, 255, 0],
  ["inside", 640, -320, 1408, 320, 255, 0, 0],
];
const scratch = mkdtempSync(join(tmpdir(), "we-specs-region-outline-"));
try {
  const dir = join(scratch, "p");
  run("unpack", join(here, "region-round.w3m"), dir, "--game", "none");
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const file = join(dir, "map", "war3map.w3r.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.regions = REGIONS.map(([name, left, bottom, right, top, red, green, blue], index) => ({
    left, bottom, right, top, name, index, weather: "0x00000000", sound: "", color: { blue, green, red, alpha: 255 },
    ...(doc.version >= 7 ? { trailer: [0, 0] } : {}),
  }));
  writeFileSync(file, JSON.stringify(doc, null, 2));
  run("pack", "--keep-objects", dir, "-o", join(here, "region-outline.w3m"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${join(here, "region-outline.w3m")}`);
