// Makes building-turn-<name>.w3m, the inputs of tests/we-compare/building-turn.json, from edge-last-step.w3m (made by
// make-edge-input.mjs): its farm hhou at (3136, -1024) replaced by another object at the same place, so the spec's box
// select of the farm (and the camera object the spec looks through) takes it:
//
//   node tests/fixtures/we-compare/make-building-turn-input.mjs <w3proj cli>
//
//   mine   a gold mine ngol of Neutral Passive (player 15)
//   tavern a tavern ntav of Neutral Passive
//   hall   a town hall htow of player 1 (index 0)
//   peon   a peasant hpea of player 1 (a unit, the control)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli");
if (!cli) { console.error("usage: make-building-turn-input.mjs <w3proj cli>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const VARIANTS = { mine: ["ngol", 15], tavern: ["ntav", 15], hall: ["htow", 0], peon: ["hpea", 0] };
for (const [name, [id, player]] of Object.entries(VARIANTS)) {
  const scratch = mkdtempSync(join(tmpdir(), "we-compare-building-turn-"));
  try {
    const dir = join(scratch, "p");
    run("unpack", join(here, "edge-last-step.w3m"), dir, "--game", "none");
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    const file = join(dir, "map", "war3mapUnits.doo.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const farm = doc.units.find((u) => u.id === "hhou");
    if (!farm) throw new Error("edge-last-step.w3m has no farm");
    Object.assign(farm, { id, skinId: id, player, ...(id === "ngol" ? { gold: 12500 } : {}) });
    writeFileSync(file, JSON.stringify(doc, null, 1));
    run("pack", "--keep-objects", dir, "-o", join(here, `building-turn-${name}.w3m`));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
