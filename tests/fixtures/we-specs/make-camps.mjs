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
//   [c|d|e|f] camps-<c|d|e|f>.w3x + .layout.json: diagonal pairs, chains in every order, off-axis pairs around 832 (see GRIDS; spacing 1800)
//   row y=-1200:        one Green Dragon (nadr), two Green Dragons 80 apart, an ogre lord, a furbolg and a razormane (all
//                       written with level 1: the unit's level field is not set per creep)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";
import { modeArgs, requireValid } from "../../gen-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
// The mode: none, b, c|d|e|f or "far <1..4 distances>"; anything else must not overwrite camps.w3x.
const args = modeArgs();
requireValid(args.length === 0 || (args.length === 1 && ["b", "c", "d", "e", "f"].includes(args[0]))
  || (args[0] === "far" && args.length === 2 && args[1].split(",").length <= 4 && args[1].split(",").every((n) => Number(n) > 0 && Number.isFinite(Number(n)))),
  "usage: make-camps.mjs <w3proj cli> <game folder> [b | c | d | e | f | far d1[,d2,d3,d4]]");
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-camps.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

const pair = (d) => [["nmrl", -d / 2, 0], ["nmrl", d / 2, 0]];
const second = args[0] === "b";
const chain = [["nmrl", -400, 0], ["nmrl", 0, 0], ["nmrl", 400, 0]];
const far = args[0] === "far" ? args[1].split(",").map(Number) : null;
const FAR_SLOTS = [[-1700, 2800], [1700, 2800], [-1700, -2800], [1700, -2800]];
// [c] camps-c.w3x, [d] camps-d.w3x: the diagonal and chain cases (spacing 1800, nothing of one camp within 832 of another's)
const m = (id, dx, dy) => [id, dx, dy];
const dg = (d) => [m("nmrl", -d / 2, -d / 2), m("nmrl", d / 2, d / 2)]; // d on both axes
const dxy = (dx, dy) => [m("nmrl", -dx / 2, -dy / 2), m("nmrl", dx / 2, dy / 2)];
const SLOTS = [[-1800, 1800], [0, 1800], [1800, 1800], [-1800, 0], [0, 0], [1800, 0], [-1800, -1800], [0, -1800], [1800, -1800]];
const grid = (cases) => cases.map((c, i) => [...SLOTS[i], c]);
const xs = (...x) => x.map((v) => m("nmrl", v, 0)); // a row of murlocs at these x, in creation order
const ys = (...y) => y.map((v) => m("nmrl", 0, v));
const GRIDS = {
  f: grid([dxy(820, 100), dxy(700, 440), dxy(440, 700), dxy(826, 50), dxy(830, 40), dxy(831, 40), dxy(831, 45), dxy(100, 832), dxy(40, 831)]),
  e: grid([xs(-400, 0, 400), xs(-400, 400, 0), xs(0, -400, 400), xs(0, 400, -400), xs(400, -400, 0), xs(400, 0, -400), xs(-400, 0, 400), xs(-400, 0, 400), xs(-400, 0, 400)]),
  c: grid([dg(588), dg(589), dg(600), dg(700), dxy(800, 300), dxy(820, 150), xs(400, -400, 0), xs(0, -400, 400), xs(-400, 400, 0)]),
  d: grid([xs(0, 300, 700), xs(700, 300, 0), ys(-400, 0, 400), ys(400, -400, 0), xs(-450, -150, 150, 450), xs(0, 200, 700), xs(1000, 500, 0), xs(0, 100, 200, 300, 400), [m("nmrl", 0, 300), m("nmrl", -260, -150), m("nmrl", 260, -150)]]),
};
const grid2 = GRIDS[args[0]];
const CAMPS = grid2 ? grid2 : far ? far.map((d, i) => [...FAR_SLOTS[i], pair(d)]) : second ? [
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
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
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
  // the creeps by camp case, for the reader of the editor's minimap (read-camp-icons.py)
  if (grid2) writeFileSync(join(here, `camps-${args[0]}.layout.json`), JSON.stringify(CAMPS.map(([cx, cy, u]) => u.map(([, dx, dy]) => [cx + dx, cy + dy]))));
  run("pack", "--keep-objects", dir, "-o", join(here, grid2 ? `camps-${args[0]}.w3x` : far ? `camps-far-${far.join("-")}.w3x` : second ? "camps-b.w3x" : "camps.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
