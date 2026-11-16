// Makes camps.w3x for the camp grouping spec (tests/we-compare/camps-we.json) from flat.w3x (the World Editor's own
// new 64x64 Lordaeron Summer map):
//
//   node tests/fixtures/we-specs/make-camps.mjs <w3proj cli> <game folder>
//
// Nine camps of Neutral Hostile creeps on a 3x3 grid 1200 apart (nothing of one camp within 450 of another's):
//   row y=1200 (north): pairs of murlocs (nmrl) 400, 450, 500 apart (x centres -1200, 0, 1200)
//   row y=0:            pairs 600 and 832 apart, then one murloc alone (level 1, weak)
//   [b] the second map (camps-b.w3x): pairs 650, 700, 750 / 800, 832, 900 apart, a lone murloc, a chain of three 400 apart, a lone ogre lord
//   [far d1,d2,d3,d4] camps-far-<d1-d2-d3-d4>.w3x: four pairs d apart in the corners (1700, 2800 and so on), far from the start location and each other
//   row y=-1200:        one Green Dragon (level 10), two Green Dragons (20), an ogre lord, a furbolg and a razormane (7+7+1)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-camps.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

const pair = (d) => [["nmrl", -d / 2, 0], ["nmrl", d / 2, 0]];
const second = process.argv[4] === "b";
const chain = [["nmrl", -400, 0], ["nmrl", 0, 0], ["nmrl", 400, 0]];
const far = process.argv[4] === "far" ? process.argv[5].split(",").map(Number) : null;
const FAR_SLOTS = [[-1700, 2800], [1700, 2800], [-1700, -2800], [1700, -2800]];
const CAMPS = far ? far.map((d, i) => [...FAR_SLOTS[i], pair(d)]) : second ? [
  [-1200, 1200, pair(650)], [0, 1200, pair(700)], [1200, 1200, pair(750)],
  [-1200, 0, pair(800)], [0, 0, pair(832)], [1200, 0, pair(900)],
  [-1200, -1200, [["nmrl", 0, 0]]], [0, -1200, chain], [1200, -1200, [["nogl", 0, 0]]],
] : [
  [-1200, 1200, pair(400)], [0, 1200, pair(450)], [1200, 1200, pair(500)],
  [-1200, 0, pair(600)], [0, 0, pair(832)], [1200, 0, [["nmrl", 0, 0]]],
  [-1200, -1200, [["nadr", 0, 0]]], [0, -1200, [["nadr", -40, 0], ["nadr", 40, 0]]],
  [1200, -1200, [["nogl", -60, 0], ["nfrg", 60, 0], ["nrzs", 0, 60]]],
];

const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "camps");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const file = join(dir, "map", "war3mapUnits.doo.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const template = doc.units[0];
  let n = 1;
  for (const [cx, cy, units] of CAMPS) {
    for (const [id, dx, dy] of units) {
      doc.units.push({
        ...template, id, skinId: id, position: [cx + dx, cy + dy, 0], angle: 0, player: 24,
        hp: -1, mana: -1, level: 1, gold: 0, targetAcquisition: -1, editorId: n++, trailer: [0, 0],
      });
    }
  }
  writeFileSync(file, JSON.stringify(doc, null, 2));
  run("pack", dir, "-o", join(here, far ? `camps-far-${far.join("-")}.w3x` : second ? "camps-b.w3x" : "camps.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
