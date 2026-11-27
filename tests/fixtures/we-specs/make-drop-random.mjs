// Makes target/drop-random/drop-random.w3x for the question whether the World Editor's item set dialog offers a random
// item's equipment type and tag (test.md "A drop table's random item (Y?I?)"; docs/testing/branch-rounds.md "Branch
// we-batch-5"): flat.w3x with a footman of player 1 at 0,0 whose own item drops hold two sets: a random permanent item
// of level 2 (YiI2) at 50 %, and a random item of any class and level (YYI/) at 100 %; drop-random-4.w3x the same
// footman with four sets: YiI2, YiI2, YiI2 and YjI3, each alone at 100 %.
//
//   node tests/fixtures/we-specs/make-drop-random.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-drop-random.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "drop-random");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const scratch = mkdtempSync(join(tmpdir(), "we-drop-random-"));
try {
  const dir = join(scratch, "map");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const file = join(dir, "map", "war3mapUnits.doo.json");
  const doo = JSON.parse(readFileSync(file, "utf8"));
  // Subversion 11 (item tables, hero attributes): every object with all its fields.
  const unit = (id, x, y, more) => ({
    id, variation: 0, position: [x, y, 0], angle: 4.712389, scale: [1, 1, 1], skinId: id, preFlags: 4294967295, flags: 2,
    player: 0, unknown1: 0, unknown2: 0, hp: -1, mana: -1, itemTable: -1, itemSets: [], gold: 0, targetAcquisition: -1,
    level: 1, strength: 0, agility: 0, intelligence: 0, inventory: [], abilities: [], randomType: 0, randomLevel: "010000",
    randomClass: 0, color: -1, waygate: -1, editorId: 0, trailer: [0, 0], extras: [], ...more,
  });
  doo.subversion = 11;
  mkdirSync(out, { recursive: true });
  // drop-random-4.w3x: four sets of one item each, YiI2, YiI2, YiI2, YjI3 (rows of the dialog's tree 32 px apart).
  for (const [name, sets] of [
    ["drop-random.w3x", [[{ id: "YiI2", chance: 50 }], [{ id: "YYI/", chance: 100 }]]],
    ["drop-random-4.w3x", ["YiI2", "YiI2", "YiI2", "YjI3"].map((id) => [{ id, chance: 100 }])],
  ]) {
    doo.units = [
      unit("sloc", 0, -256, { targetAcquisition: 0, level: 0, editorId: 0 }),
      unit("hfoo", 0, 0, { itemSets: sets, editorId: 1 }),
    ];
    writeFileSync(file, JSON.stringify(doo, null, 1));
    run("pack", "--keep-objects", dir, "-o", join(out, name), "--force-stale");
    console.log(`made ${join(out, name)}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
