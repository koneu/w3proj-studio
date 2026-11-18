// Makes building-ground.w3x for the building heights spec (tests/we-compare/building-ground.json) from flat.w3x (the
// World Editor's own new 64x64 Lordaeron Summer map, level 2 everywhere):
//
//   node tests/fixtures/we-specs/make-building-ground.mjs <w3proj cli> <game folder>
//
// The ground is one plane that rises 16 a tile eastwards and 8 a tile northwards (corner x, y from the south-west:
// 16 x + 8 y, at most 1536: the editor reads a ground height past 2048 as 4096 lower), so the height a sample a few
// units off a building's centre reads tells how far off it is and in which direction. On it, every unit stored at
// z 999 (the editor's save writes each one at the height it works out): a footman (bilinear, the control), player
// buildings (farm, town hall, barracks, orc burrow), neutral buildings (goblin merchant at four facings and at a placed
// scale of 2, gold mine at two facings, mercenary camp, tavern), custom ones (a goblin merchant with Scaling Value 2,
// a gold mine with the merchant's model and the reverse, a merchant with Can Build On, a gold mine without it, a
// merchant with the gold mine's abilities and the reverse, a merchant with Pathing - Placement Prevented By
// "unbuildable", a gold mine without it), and non-buildings: gryphons, naga, turtles at two facings, a red dragon and
// a transport ship on land.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-building-ground.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

/** The units: id, x, y, facing in degrees, owner. */
export const UNITS = [
  ["hfoo", -2560, -2560, 270, 0],
  ["hhou", -1920, -2560, 270, 0],
  ["htow", -1024, -2560, 270, 0],
  ["hbar", 0, -2560, 270, 0],
  ["otrb", 896, -2560, 270, 0],
  ["ngme", -2496, -1216, 270, 27],
  ["ngme", -1472, -1216, 0, 27],
  ["ngme", -448, -1216, 45, 27],
  ["ngme", 576, -1216, 90, 27],
  ["ngol", -2560, 256, 270, 27],
  ["ngol", -1536, 256, 0, 27],
  ["nmer", -448, 192, 270, 27],
  ["ntav", 576, 192, 270, 27],
  ["n000", -2496, 1600, 270, 27],
  ["n001", -1536, 1536, 270, 27],
  ["n002", -448, 1600, 270, 27],
  ["n003", 576, 1600, 270, 27],
  ["n004", 1600, 1536, 270, 27],
  ["n005", 1600, 192, 270, 27],
  ["n006", 1600, -1216, 270, 27],
  ["n007", 2624, -1216, 270, 27],
  ["n008", 2624, 192, 270, 27],
  ["ngme", 2624, 1600, 270, 27, 2],
  ["hgry", -2560, 2560, 270, 0],
  ["hgry", -1920, 2560, 45, 0],
  ["nnmg", -1280, 2560, 270, 0],
  ["nnmg", -640, 2560, 45, 0],
  ["ntrt", 0, 2560, 270, 27],
  ["ntrt", 640, 2560, 45, 27],
  ["nrdk", 1280, 2560, 30, 27],
  ["hbot", 1920, 2560, 270, 0],
];

/** The custom types of the bumpy map: the elevation sample fields (Art - Elevation - Sample Points uept, Sample
 *  Radius uerd) and the collision size (ucol) changed on a building and on units. */
const BUMPY_CUSTOM = [
  { base: "ngme", id: "n100", mods: [{ field: "uept", type: "int", value: 0 }] },
  { base: "ngme", id: "n101", mods: [{ field: "uept", type: "int", value: 2 }] },
  { base: "ngme", id: "n102", mods: [{ field: "uerd", type: "real", value: 100 }] },
  { base: "ngol", id: "n103", mods: [{ field: "uept", type: "int", value: 4 }] },
  { base: "hfoo", id: "h100", mods: [{ field: "uept", type: "int", value: 4 }] },
  { base: "ntrt", id: "n105", mods: [{ field: "uerd", type: "real", value: 200 }] },
  { base: "ntrt", id: "n106", mods: [{ field: "ucol", type: "unreal", value: 16 }] },
  { base: "ngme", id: "n107", mods: [{ field: "ucol", type: "unreal", value: 100 }] },
  { base: "ntrt", id: "n108", mods: [{ field: "uept", type: "int", value: 2 }] },
  { base: "ntrt", id: "n109", mods: [{ field: "usca", type: "real", value: 2 }] },
  { base: "ngme", id: "n110", mods: [{ field: "uept", type: "int", value: 3 }] },
  { base: "hfoo", id: "h101", mods: [{ field: "uept", type: "int", value: 1 }] },
  { base: "hfoo", id: "h102", mods: [{ field: "uept", type: "int", value: 4 }, { field: "ucol", type: "unreal", value: 0 }] },
  { base: "hfoo", id: "h103", mods: [{ field: "uept", type: "int", value: 3 }] },
  { base: "hfoo", id: "h104", mods: [{ field: "uept", type: "int", value: 8 }] },
];
/** The types on the bumpy map, four of each at random places and facings. */
const BUMPY_TYPES = ["hfoo", "hkni", "hhou", "htow", "ngme", "ngol", "nmer", "ntav", "ntrt", "ntrg", "ntrh", "nrdk", "nadk", "hgry", "nnmg", "hbot",
  ...BUMPY_CUSTOM.slice(0, 10).map((c) => c.id), "hmtt", ...BUMPY_CUSTOM.slice(10).map((c) => c.id)];

/** A small seeded random generator (mulberry32), so the map comes out the same each time. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** flat.w3x with its ground heights from `heightOf(x, y)` (corner x, y from the south-west, whole units) and the units
 *  [id, x, y, facing in degrees, owner, placed scale] stored at z 999, packed to `out`. */
function makeMap(out, heightOf, units, custom) {
  const dir = join(scratch, "map");
  rmSync(dir, { recursive: true, force: true });
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith("[height]"));
  if (at < 0) throw new Error("no [height] section in the w3e text");
  // Rows run from the north; the file's height is a quarter unit.
  const rows = Array.from({ length: 65 }, (_, r) => Array.from({ length: 65 }, (_, x) => String(4 * heightOf(x, 64 - r))).join(" "));
  lines.splice(at, 1, "[height]", ...rows);
  writeFileSync(w3e, lines.join("\n"));

  const file = join(dir, "map", "war3mapUnits.doo.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const template = doc.units[0];
  for (const [i, [id, x, y, facing, player, scale = 1]] of units.entries()) {
    doc.units.push({ ...template, id, skinId: id, position: [x, y, 999], angle: (facing * Math.PI) / 180, scale: [scale, scale, scale], player, editorId: i + 1, trailer: [0, 0] });
  }
  writeFileSync(file, JSON.stringify(doc, null, 2));
  writeFileSync(join(dir, "map", "war3map.w3u.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom }, null, 2));
  run("pack", dir, "-o", join(here, out), "--force-stale");
}

const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const custom = [
    { base: "ngme", id: "n000", mods: [{ field: "usca", type: "real", value: 2 }] },
    { base: "ngol", id: "n001", mods: [{ field: "umdl", type: "string", value: "buildings\\other\\Merchant\\Merchant.mdl" }] },
    { base: "ngme", id: "n002", mods: [{ field: "umdl", type: "string", value: "buildings\\other\\GoldMine\\GoldMine.mdl" }] },
    { base: "ngme", id: "n003", mods: [{ field: "ucbo", type: "int", value: 1 }] },
    { base: "ngol", id: "n004", mods: [{ field: "ucbo", type: "int", value: 0 }] },
    { base: "ngme", id: "n005", mods: [{ field: "uabi", type: "string", value: "Agld,Avul" }] },
    { base: "ngol", id: "n006", mods: [{ field: "uabi", type: "string", value: "Avul" }] },
    { base: "ngme", id: "n007", mods: [{ field: "upap", type: "string", value: "unbuildable" }] },
    { base: "ngol", id: "n008", mods: [{ field: "upap", type: "string", value: "_" }] },
  ];
  makeMap("building-ground.w3x", (x, y) => 16 * x + 8 * y, UNITS, custom);

  // The bumpy map: every corner at a random height from 0 to 255, so a sample a few units off a unit's centre
  // reads another height than the bilinear one at the centre, in whatever direction it is.
  const random = seeded(20261118);
  const heights = Array.from({ length: 65 * 65 }, () => Math.floor(random() * 256));
  const bumpy = [];
  BUMPY_TYPES.forEach((id, t) => {
    for (let k = 0; k < 4; k++) {
      const cell = t * 4 + k, cx = cell % 11, cy = Math.floor(cell / 11);
      const x = -2816 + cx * 512 + Math.round((random() - 0.5) * 256), y = -2816 + cy * 512 + Math.round((random() - 0.5) * 256);
      bumpy.push([id, x, y, Math.round(random() * 360), /^[hn]\d/.test(id) || /^(hfoo|hkni|hhou|htow|hgry|hbot)$/.test(id) ? 0 : 27]);
    }
  });
  makeMap("unit-ground-bumpy.w3x", (x, y) => heights[y * 65 + x], bumpy, BUMPY_CUSTOM);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
