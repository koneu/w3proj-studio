// Makes the inputs of the doodad-open-z-*-tweak specs (tests/we-compare/doodad-open-z-real.json) into <repo>/target/doodad-open-z/
// from maps of smoketest_maps (the user's, never committed):
//
//   node tests/fixtures/we-specs/make-doodad-open-z-real.mjs <w3proj cli> <game folder> <smoketest_maps folder>
//
// snowarebay-tweak.w3x, autumnleaves-tweak.w3x, firebrand-tweak.w3x, hammerfall-tweak.w3x: the map unpacked, the listed
// doodads' stored z raised by 37.5, packed. The World Editor keeps a stored height that is its own ground's and works out
// one that isn't again on opening (doodad-open-z-snow-tweak, 2026-11-16): where it puts these is its ground there.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const [cli, game, maps] = process.argv.slice(2, 5).map((p) => (p ? resolve(p) : p));
if (!maps) { console.error("usage: make-doodad-open-z-real.mjs <w3proj cli> <game folder> <smoketest_maps folder>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const out = join(repo, "target", "doodad-open-z");
mkdirSync(out, { recursive: true });

// [output, map under smoketest_maps, doodad indices]: walls, gates and icy rocks (Elevation Sample Radius 50), tree
// walls and doodads on ramps, the ones Studio's ground put elsewhere than the stored height.
const MAPS = [
  ["snowarebay-tweak.w3x", "4v4_SnowareBay_w3c_260125_1357_5658.w3x", [482, 652, 1181, 2588, 2596, 2600, 2606, 2731, 2828, 3409, 5505, 5663]],
  ["autumnleaves-tweak.w3x", "blizzard/(2)AutumnLeaves_S2_v2.0.w3x", [51, 110, 541, 543, 579, 580, 786, 796, 981, 1016, 1272, 2213, 2367, 4818]],
  ["firebrand-tweak.w3x", "new(er)_maps/Firebrand Exarchate Race.w3x", [570, 572, 3796, 4794]],
  ["hammerfall-tweak.w3x", "blizzard/(2)Hammerfall_S3.w3x", [98, 530, 533]],
];
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  for (const [name, map, picks] of MAPS) {
    const dir = join(scratch, name);
    run("unpack", join(maps, map), dir, "--game", game);
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    const file = join(dir, "map", "war3map.doo.json");
    const doo = JSON.parse(readFileSync(file, "utf8"));
    for (const i of picks) doo.doodads[i].position[2] += 37.5;
    writeFileSync(file, JSON.stringify(doo, null, 1));
    // Heights don't change pathing, shadows or the minimap: the map's own are kept.
    run("pack", dir, "-o", join(out, name), "--force-stale");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
