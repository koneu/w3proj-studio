// Makes water-shadows.w3x for measuring HD model shadows over water against the World Editor's game view, from
// flat.w3x (the editor's own new 64x64 Lordaeron Summer map, level 2, height 0):
//
//   node tests/fixtures/we-specs/make-water-shadows.mjs <w3proj cli> <game folder> [out folder] [--time N] [--tileset T]
//
// --time N writes war3mapExtra.txt's TimeOfDay (Scenario > Map Preferences > Time of Day: 1 dawn, 2 noon, 3 dusk,
// 4 midnight) and names the map water-shadows-t<N>.w3x; --tileset B (Barrens), A (Ashenvale), N (Northrend), ...
// puts the map on that tileset's first six ground textures and its two plain cliffs (w3e and w3i), named
// water-shadows-<T>[-t<N>].w3x. --depth D makes the shallow lake D deep (default 30; 1..60), named ...-d<D>.w3x;
// --deep D the deep lake (default 100; 61..400), ...-D<D>.w3x; --low-flyers puts the gryphons at (-512, 448) and (1280, 256),
// so their shadows lie in the lakes (named ...-g.w3x); --lake-trees adds a tree LTlt in each lake, at (-512, 0) and
// (1408, 0), whose shadows (still, unlike the units', which move with their animations) fall on the water (...-T.w3x);
// --lake-tree-scale S (1..4, whole) scales those two trees, so their shadows reach out of deep water and cover more of
// it (...-T-s<S>.w3x); --no-units leaves the footmen and gryphons out, so only the trees cast shadows (...-U.w3x).
//
// Two lakes on the flat ground (corner coordinates, x east, y north; the world is (corner - 32) * 128):
//   shallow  corners x 26..34, y 30..38, 30 deep (level 120)
//   deep     corners x 38..48, y 30..38, 100 deep (level 190)
// and, in world units: footmen on land at (-1024, 0), in the shallow lake (-256, 256) and in the deep one
// (1024, 256), gryphons flying over the shallow lake (0, 640) and the deep one (1280, 640), tree LTlt at
// (-1024, 512) and (256, -384). The out folder is target/water-shadows of the checkout by default.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  return value;
};
const time = option("--time"), tileset = option("--tileset"), depth = option("--depth"), deep = option("--deep"), treeScale = option("--lake-tree-scale");
const lowFlyers = argv.includes("--low-flyers");
if (lowFlyers) argv.splice(argv.indexOf("--low-flyers"), 1);
const lakeTrees = argv.includes("--lake-trees");
if (lakeTrees) argv.splice(argv.indexOf("--lake-trees"), 1);
const noUnits = argv.includes("--no-units");
if (noUnits) argv.splice(argv.indexOf("--no-units"), 1);
const inRange = (v, lo, hi) => v === undefined || (/^\d+$/.test(v) && +v >= lo && +v <= hi);
const [cli, game, outArg] = argv.slice(0, 3).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const usage = "usage: make-water-shadows.mjs <w3proj cli> <game folder> [out folder] [--time 1-4] [--tileset LETTER] [--depth 1-60] [--deep 61-400] [--low-flyers] [--lake-trees] [--lake-tree-scale 1-4] [--no-units]";
if (!game || (time !== undefined && !/^[1-4]$/.test(time)) || (tileset !== undefined && !/^[A-Z]$/.test(tileset)) || !inRange(depth, 1, 60) || !inRange(deep, 61, 400) || !inRange(treeScale, 1, 4) || (treeScale && !lakeTrees)) { console.error(usage); process.exit(2); }
// the plain ground (six textures) and cliffs of a tileset, by its letter
const TILESETS = {
  B: { ground: "Bdrt Bdrh Bdrr Bdrg Bdsr Bdsd", cliffs: "CBde CBgr" },
  A: { ground: "Adrt Adrd Agrs Arck Agrd Avin", cliffs: "CAdi CAgr" },
  N: { ground: "Ndrt Ndrd Nrck Ngrs Nice Nsnw", cliffs: "CNdi CNsn" },
  F: { ground: "Fdrt Fdro Fdrg Frok Fgrs Fgrd", cliffs: "CFdi CFgr" },
  W: { ground: "Wdrt Wdro Wsng Wrok Wgrs Wsnw", cliffs: "CWgr CWsn" },
};
if (tileset && !TILESETS[tileset]) { console.error(`unknown tileset ${tileset}: ${Object.keys(TILESETS).join(", ")}`); process.exit(2); }
const outName = `water-shadows${tileset ? `-${tileset}` : ""}${time ? `-t${time}` : ""}${depth ? `-d${depth}` : ""}${deep ? `-D${deep}` : ""}${lowFlyers ? "-g" : ""}${lakeTrees ? "-T" : ""}${treeScale ? `-s${treeScale}` : ""}${noUnits ? "-U" : ""}.w3x`;
const outDir = outArg || resolve(here, "..", "..", "..", "target", "water-shadows");
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
const rows = (f, sep = "") => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(sep));
// the surface is the stored level less 89.6, so levels of 120 and 190 are 30 and 100 deep over ground 0
const WATER_SHALLOW = depth ? 89.6 + Number(depth) : 120, WATER_DEEP = deep ? 89.6 + Number(deep) : 190;
const lake = (x, y) => (y >= 30 && y <= 38 ? (x >= 26 && x <= 34 ? WATER_SHALLOW : x >= 38 && x <= 48 ? WATER_DEEP : 0) : 0);

const scratch = mkdtempSync(join(tmpdir(), "we-specs-water-shadows-"));
try {
  const dir = join(scratch, "map");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const sections = {
    // the text keeps the water level in world units x 4
    water: rows((x, y) => Math.round(lake(x, y) * 4), " "),
    flags: rows((x, y) => (lake(x, y) ? "4" : "0")),
  };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[i]);
    if (m && m[1] in sections) {
      out.push(`[${m[1]}]`, ...sections[m[1]]);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    if (tileset && /^tileset /.test(lines[i])) out.push(`tileset ${tileset}`);
    else if (tileset && /^ground /.test(lines[i])) out.push(`ground ${TILESETS[tileset].ground}`);
    else if (tileset && /^cliffs /.test(lines[i])) out.push(`cliffs ${TILESETS[tileset].cliffs}`);
    else out.push(lines[i]);
  }
  writeFileSync(w3e, out.join("\n"));
  if (tileset) {
    const w3iFile = join(dir, "map", "war3map.w3i.json");
    const w3i = JSON.parse(readFileSync(w3iFile, "utf8"));
    w3i.tileset = tileset;
    writeFileSync(w3iFile, JSON.stringify(w3i, null, 2));
  }
  if (time) writeFileSync(join(dir, "map", "war3mapExtra.txt"), `[MapExtraInfo]\nTimeOfDay=${time}\n\n`);

  const unitsFile = join(dir, "map", "war3mapUnits.doo.json");
  const units = JSON.parse(readFileSync(unitsFile, "utf8"));
  const template = units.units[0];
  const placed = [["hfoo", -1024, 0, 0], ["hfoo", -256, 256, 0], ["hfoo", 1024, 256, 0], ...(lowFlyers ? [["hgry", -512, 448, 0], ["hgry", 1280, 256, 0]] : [["hgry", 0, 640, 0], ["hgry", 1280, 640, 0]])];
  if (!noUnits) placed.forEach(([id, x, y, z], k) => units.units.push({ ...template, id, skinId: id, position: [x, y, z], player: 0, editorId: k + 1, trailer: [0, 0] }));
  writeFileSync(unitsFile, JSON.stringify(units, null, 2));

  const dooFile = join(dir, "map", "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  const s = Number(treeScale ?? 1);
  [[-1024, 512, 1], [256, -384, 1], ...(lakeTrees ? [[-512, 0, s], [1408, 0, s]] : [])].forEach(([x, y, scale], k) => doo.doodads.push({
    id: "LTlt", variation: 0, position: [x, y, 0], angle: 0, scale: [scale, scale, scale], skinId: "LTlt", preFlags: 4294967295, flags: 2,
    life: 100, itemTable: -1, itemSets: [], editorId: 100 + k, trailer: [k, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 2));

  mkdirSync(outDir, { recursive: true });
  run("pack", "--keep-objects", dir, "-o", join(outDir, outName), "--force-stale");
  console.log(`made ${join(outDir, outName)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
