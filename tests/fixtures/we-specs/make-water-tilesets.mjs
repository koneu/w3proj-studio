// Makes one water-depth map per tileset from flat.w3x, for picture comparisons of the water's colour:
//
//   node tests/fixtures/we-specs/make-water-tilesets.mjs <w3proj cli> <game folder> <out folder> [tileset char…]
//
// <out>/wt-<char>.w3x: the tileset's first six ground tiles (Terrain.slk order), its first two cliff types, water at
// the stored level 512 over the whole map (surface 38.4), the ground in eight bands of depth, north to south
// 4, 12, 24, 38.4, 64, 96, 200, 800 (eight corner rows each; the last takes the rest). Water.slk's own height adds to
// the surface the same on both sides of a comparison, so the depths are the bands' within it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game, out] = process.argv.slice(2, 5).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const only = process.argv.slice(5);
if (!out) { console.error("usage: make-water-tilesets.mjs <w3proj cli> <game folder> <out folder> [tileset char…]"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8", env: { ...process.env, W3PROJ_GAME: game } });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
};
const table = (file, cols) => run("game", "slk", file, "--col", cols).trim().split("\n").slice(1).map((l) => l.split("\t"));
const tiles = table("TerrainArt/Terrain.slk", "tileID").map(([id]) => id);
const cliffs = table("TerrainArt/CliffTypes.slk", "cliffID,groundTile");
const TILESETS = "ABCDFGIJKLNOQVWXYZ".split("");
const DEPTHS = [4, 12, 24, 38.4, 64, 96, 200, 800];
mkdirSync(out, { recursive: true });
for (const ch of TILESETS) {
  if (only.length && !only.includes(ch)) continue;
  const ground = tiles.filter((id) => id.startsWith(ch)).slice(0, 6);
  const own = cliffs.filter(([, g]) => g.startsWith(ch)).slice(0, 2).map(([id]) => id);
  if (ground.length < 2 || own.length < 2) { console.log(`${ch}: skipped (${ground.length} tiles, ${own.length} cliffs)`); continue; }
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir);
    const w3i = join(dir, "map", "war3map.w3i.json");
    const info = JSON.parse(readFileSync(w3i, "utf8"));
    info.tileset = ch;
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
    const heightRow = (y) => String(Math.round((38.4 - DEPTHS[Math.min(7, Math.floor(y / 8))]) * 4));
    section("height", Array.from({ length: 65 }, (_, y) => `${heightRow(y)}*65`));
    section("water", Array.from({ length: 65 }, () => "512*65"));
    section("flags", Array.from({ length: 65 }, () => "4".repeat(65)));
    section("texture", Array.from({ length: 65 }, () => "0".repeat(65)));
    writeFileSync(file, lines.join("\n"));
    run("pack", dir, "-o", join(out, `wt-${ch}.w3x`), "--force-stale");
    console.log(`${ch}: ${ground.join(" ")} / ${own.join(" ")}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
