// Makes one water-depth map per tileset from flat.w3x, for picture comparisons of the water's colour:
//
//   node tests/fixtures/we-specs/make-water-tilesets.mjs <w3proj cli> <game folder> <out folder> [tileset char…]
//
// <out>/wt-<char>.w3x: the tileset's first six ground tiles (Terrain.slk order), its first two cliff types, water at
// the stored level 512 over the whole map (surface 38.4), the ground in eight bands of depth, north to south
// 4, 12, 24, 38.4, 64, 96, 200, 800 (eight corner rows each; the last takes the rest). Water.slk's own height adds to
// the surface the same on both sides of a comparison, so the depths are the bands' within it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game, out] = process.argv.slice(2, 5).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
// --dry: <out>/nv-<char>.w3x instead, the tileset's tiles and cliffs on flat.w3x's dry, flat ground (its first tile
// everywhere, the 6-tile border kept): for the naval view's border on each tileset.
const dry = process.argv.includes("--dry");
// --shore: <out>/ws-<char>.w3x instead, for the border's shade over land and water and the View layers over the border:
// the north half dry ground 64 above the water's surface, the south half water 24 deep (corner rows 32..47 from the
// north) and 96 deep (the rest), flat.w3x's border kept (6, 6, 4, 8 tiles), so land and water both run into the west and
// east border, land into the north one and water into the south one; and two regions, a yellow one across the south
// border (x -1024..1024, y -4096..-2816) and a red one across the west border over land (x -4096..-2560, y 1024..2048).
const shore = process.argv.includes("--shore");
if (dry && shore) { console.error("make-water-tilesets.mjs: --dry and --shore are two different maps"); process.exit(2); }
// --cliffs ID,ID…: that cliff list instead of the tileset's first two (with --dry: <out>/nv-<char>-<ID>-<ID>….w3x), for
// the water brush's cliff type on a list without the tileset's own (water-cliff-append: CAgr,CLdi on Lordaeron).
const cliffsAt = process.argv.indexOf("--cliffs");
const cliffList = cliffsAt >= 0 ? (process.argv[cliffsAt + 1] ?? "").split(",").filter(Boolean) : null;
if (cliffList && !cliffList.length) { console.error("make-water-tilesets.mjs: --cliffs wants a list, e.g. CAgr,CLdi"); process.exit(2); }
// --depths D,D…: the wt- map's bands at these depths instead (up to eight, north to south; the last takes the rest),
// as <out>/wt-<char>-<D>-<D>….w3x: for the HD water's colour over deep water (branch hd-deep-water: 64 to 200).
const depthsAt = process.argv.indexOf("--depths");
const depthList = depthsAt >= 0 ? (process.argv[depthsAt + 1] ?? "").split(",").filter(Boolean).map(Number) : null;
if (depthList && (!depthList.length || depthList.length > 8 || depthList.some((d) => !Number.isFinite(d) || d < 0 || d > 1000))) {
  console.error("make-water-tilesets.mjs: --depths wants one to eight depths of 0 to 1000, e.g. 64,96,128,160,200,800"); process.exit(2);
}
// --reflectivity N: the w3i's HD water reflectivity N (0 to 100; the name gets -r<N>): 0 draws the bed and the water's own
// colour alone, without the sky's reflection.
const reflectAt = process.argv.indexOf("--reflectivity");
const reflectivity = reflectAt >= 0 ? Number(process.argv[reflectAt + 1]) : null;
if (reflectAt >= 0 && !(Number.isInteger(reflectivity) && reflectivity >= 0 && reflectivity <= 100)) {
  console.error("make-water-tilesets.mjs: --reflectivity wants a whole number of 0 to 100"); process.exit(2);
}
// --tint R,G,B: the w3i's water tint (0 to 255 each; stored blue, green, red, alpha 255) with its flag 0x10000 on (the
// name gets -t<R>-<G>-<B>): for the HD water's colour under a tint (branch we-remeasure-hd).
const tintAt = process.argv.indexOf("--tint");
const tint = tintAt >= 0 ? (process.argv[tintAt + 1] ?? "").split(",").map(Number) : null;
if (tint && (tint.length !== 3 || tint.some((v) => !(Number.isInteger(v) && v >= 0 && v <= 255)))) {
  console.error("make-water-tilesets.mjs: --tint wants red, green and blue of 0 to 255, e.g. 255,64,64"); process.exit(2);
}
if ((depthList || reflectAt >= 0 || tint) && (dry || shore)) { console.error("make-water-tilesets.mjs: --depths, --reflectivity and --tint are for the wt- maps"); process.exit(2); }
const VALUED = new Set(["--cliffs", "--depths", "--reflectivity", "--tint"]);
const only = process.argv.slice(5).filter((a, i, all) => a !== "--dry" && a !== "--shore" && !VALUED.has(a) && !VALUED.has(all[i - 1]));
if (!out) { console.error("usage: make-water-tilesets.mjs <w3proj cli> <game folder> <out folder> [--dry | --shore] [tileset char…]"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8", env: { ...process.env, W3PROJ_GAME: game } });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
};
const table = (file, cols) => run("game", "slk", file, "--col", cols).trim().split("\n").slice(1).map((l) => l.split("\t"));
const tiles = table("TerrainArt/Terrain.slk", "tileID").map(([id]) => id);
const cliffs = table("TerrainArt/CliffTypes.slk", "cliffID,groundTile");
const TILESETS = "ABCDFGIJKLNOQVWXYZ".split("");
const DEPTHS = depthList ?? [4, 12, 24, 38.4, 64, 96, 200, 800];
mkdirSync(out, { recursive: true });
for (const ch of TILESETS) {
  if (only.length && !only.includes(ch)) continue;
  const ground = tiles.filter((id) => id.startsWith(ch)).slice(0, 6);
  const own = cliffList ?? cliffs.filter(([, g]) => g.startsWith(ch)).slice(0, 2).map(([id]) => id);
  if (ground.length < 2 || own.length < 2) { console.log(`${ch}: skipped (${ground.length} tiles, ${own.length} cliffs)`); continue; }
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir);
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    const w3i = join(dir, "map", "war3map.w3i.json");
    const info = JSON.parse(readFileSync(w3i, "utf8"));
    info.tileset = ch;
    // The w3i flag 0x0008 follows the w3e's custom tilesets flag (set to 1 below), as the editor's save leaves it
    // (tilesetflag.ts): without it an open and save alone differs there (water-cliff-append-open, 2026-11-19). Only the
    // --cliffs maps: the wt-, nv- and ws- maps of the specs were made without it.
    if (cliffList) info.flags = (info.flags | 0x0008) >>> 0;
    if (reflectivity !== null) {
      if (!info.water || typeof info.water !== "object") throw new Error("flat.w3x's w3i has no water block for --reflectivity");
      info.water.reflectivity = reflectivity;
    }
    if (tint) {
      info.waterTint = [tint[2], tint[1], tint[0], 255];
      info.flags = (info.flags | 0x10000) >>> 0;
    }
    writeFileSync(w3i, JSON.stringify(info));
    const file = join(dir, "map", "war3map.w3e.txt");
    const lines = readFileSync(file, "utf8").split("\n");
    const set = (prefix, to) => {
      const at = lines.findIndex((l) => l.startsWith(prefix));
      if (at < 0) throw new Error(`no "${prefix}" line in the w3e text`);
      lines[at] = to;
    };
    set("tileset ", `tileset ${ch}`);
    set("custom-tilesets ", "custom-tilesets 1");
    set("ground ", `ground ${ground.join(" ")}`);
    set("cliffs ", `cliffs ${own.join(" ")}`);
    const section = (name, rows) => {
      const at = lines.findIndex((l) => l.startsWith(`[${name}]`));
      if (at < 0) throw new Error(`no [${name}] section`);
      let end = at + 1;
      while (end < lines.length && !lines[end].startsWith("[")) end++;
      lines.splice(at, end - at, `[${name}]`, ...rows, "");
    };
    // Rows are written north first (the text's order). Band k: rows 8k..8k+7 from the north, the last takes the rest.
    if (shore) {
      // Rows north first: 0..31 dry, 32..47 24 deep, 48..64 96 deep (surface 38.4 at the stored level 512).
      const depthOf = (y) => (y < 32 ? -64 : y < 48 ? 24 : 96);
      section("height", Array.from({ length: 65 }, (_, y) => `${Math.round((38.4 - depthOf(y)) * 4)}*65`));
      section("water", Array.from({ length: 65 }, () => "512*65"));
      section("flags", Array.from({ length: 65 }, (_, y) => (y < 32 ? "0" : "4").repeat(65)));
      section("texture", Array.from({ length: 65 }, () => "0".repeat(65)));
      const regionsFile = join(dir, "map", "war3map.w3r.json");
      const regions = JSON.parse(readFileSync(regionsFile, "utf8"));
      const region = (name, index, [left, bottom, right, top], [red, green, blue]) => ({
        left, bottom, right, top, name, index, weather: "0x00000000", sound: "", color: { blue, green, red, alpha: 255 },
        ...(regions.version >= 7 ? { trailer: [0, 0] } : {}),
      });
      regions.regions = [
        region("yellowSouth", 0, [-1024, -4096, 1024, -2816], [255, 255, 0]),
        region("redWest", 1, [-4096, 1024, -2560, 2048], [255, 0, 0]),
      ];
      writeFileSync(regionsFile, JSON.stringify(regions, null, 2));
    } else if (!dry) {
      const heightRow = (y) => String(Math.round((38.4 - DEPTHS[Math.min(DEPTHS.length - 1, Math.floor(y / 8))]) * 4));
      section("height", Array.from({ length: 65 }, (_, y) => `${heightRow(y)}*65`));
      section("water", Array.from({ length: 65 }, () => "512*65"));
      section("flags", Array.from({ length: 65 }, () => "4".repeat(65)));
      section("texture", Array.from({ length: 65 }, () => "0".repeat(65)));
    }
    writeFileSync(file, lines.join("\n"));
    const suffix = (cliffList ? `-${cliffList.join("-")}` : "") + (depthList ? `-${depthList.join("-")}` : "") + (reflectivity !== null ? `-r${reflectivity}` : "") + (tint ? `-t${tint.join("-")}` : "");
    run("pack", "--keep-objects", dir, "-o", join(out, `${dry ? "nv" : shore ? "ws" : "wt"}-${ch}${suffix}.w3x`), "--force-stale");
    console.log(`${ch}: ${ground.join(" ")} / ${own.join(" ")}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
