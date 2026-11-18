// Makes water-shadows.w3x for measuring HD model shadows over water against the World Editor's game view, from
// flat.w3x (the editor's own new 64x64 Lordaeron Summer map, level 2, height 0):
//
//   node tests/fixtures/we-specs/make-water-shadows.mjs <w3proj cli> <game folder> [out folder]
//
// Two lakes on the flat ground (corner coordinates, x east, y north; the world is (corner - 32) * 128):
//   shallow  corners x 26..34, y 30..38, 30 deep (level 120)
//   deep     corners x 38..48, y 30..38, 100 deep (level 190)
// and, in world units: footmen on land at (-1024, 0), in the shallow lake (-256, 256) and in the deep one
// (1024, 256), gryphons flying over the shallow lake (0, 640) and the deep one (1280, 640), tree LTlt at
// (-1024, 512) and (256, -384). The out folder is target/water-shadows of the checkout by default.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game, outArg] = process.argv.slice(2, 5).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-water-shadows.mjs <w3proj cli> <game folder> [out folder]"); process.exit(2); }
const outDir = outArg || resolve(here, "..", "..", "..", "target", "water-shadows");
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
const rows = (f, sep = "") => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(sep));
// the surface is the stored level less 89.6, so levels of 120 and 190 are 30 and 100 deep over ground 0
const WATER_SHALLOW = 120, WATER_DEEP = 190;
const lake = (x, y) => (y >= 30 && y <= 38 ? (x >= 26 && x <= 34 ? WATER_SHALLOW : x >= 38 && x <= 48 ? WATER_DEEP : 0) : 0);

const scratch = mkdtempSync(join(tmpdir(), "we-specs-water-shadows-"));
try {
  const dir = join(scratch, "map");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const sections = {
    // the text keeps the water level in world units x 4
    water: rows((x, y) => lake(x, y) * 4, " "),
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
    out.push(lines[i]);
  }
  writeFileSync(w3e, out.join("\n"));

  const unitsFile = join(dir, "map", "war3mapUnits.doo.json");
  const units = JSON.parse(readFileSync(unitsFile, "utf8"));
  const template = units.units[0];
  const placed = [["hfoo", -1024, 0, 0], ["hfoo", -256, 256, 0], ["hfoo", 1024, 256, 0], ["hgry", 0, 640, 0], ["hgry", 1280, 640, 0]];
  placed.forEach(([id, x, y, z], k) => units.units.push({ ...template, id, skinId: id, position: [x, y, z], player: 0, editorId: k + 1, trailer: [0, 0] }));
  writeFileSync(unitsFile, JSON.stringify(units, null, 2));

  const dooFile = join(dir, "map", "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  [[-1024, 512], [256, -384]].forEach(([x, y], k) => doo.doodads.push({
    id: "LTlt", variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1], skinId: "LTlt", preFlags: 4294967295, flags: 2,
    life: 100, itemTable: -1, itemSets: [], editorId: 100 + k, trailer: [k, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 2));

  mkdirSync(outDir, { recursive: true });
  run("pack", dir, "-o", join(outDir, "water-shadows.w3x"), "--force-stale");
  console.log(`made ${join(outDir, "water-shadows.w3x")}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
