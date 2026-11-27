// Makes minimap-tiles-<name>.w3x from flat.w3x (Lordaeron Summer; its own ground list is Ldrt Ldro Ldrg Lrok Lgrs Lgrd):
//
//   node tests/fixtures/we-specs/make-minimap-tiles.mjs <w3proj cli> <game folder> [name…]
//
// For reading which texture the World Editor's minimap shows for a tile whose four corners differ: the whole map is
// the playable area (camera complements 0, 64 x 64 tiles, 4 pixels a tile at 256), no doodads.
//   rand   every corner one of the six textures by a seeded random number: 4096 tiles with mostly four different corners
//   blobs  the same in squares of 4 x 4 corners (a tile on a square's edge has two to four textures): terrain-like
//   impulse  Lgrs everywhere with Lrok at a few corners (one, two, four, nine): what one corner draws
//   blight  Lgrs in the north half, Ldrt in the south, the west half blighted: Export Minimap's Include Blight
// (the text rows of war3map.w3e.txt run from the north)
// Names given: only those maps are made.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";
import { modeArgs, requireValid } from "../../gen-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const only = modeArgs();
if (!game) { console.error("usage: make-minimap-tiles.mjs <w3proj cli> <game folder> [name…]"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

/** Seeded random numbers (mulberry32), the same on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const N = 65;
const MAPS = {
  rand: () => { const r = rng(1); return Array.from({ length: N }, () => Array.from({ length: N }, () => Math.floor(r() * 6))); },
  blobs: () => {
    const r = rng(2), cell = new Map();
    const at = (bx, by) => { const k = `${bx},${by}`; if (!cell.has(k)) cell.set(k, Math.floor(r() * 6)); return cell.get(k); };
    return Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => at(Math.floor(x / 4), Math.floor(y / 4))));
  },
  // Lgrs everywhere with Lrok at a few corners, 20 corners apart: one, two side by side, two one above the other, two
  // diagonal, a block of 2 x 2, a block of 3 x 3 (what one corner draws, and what a tile with a mixed ring draws).
  impulse: () => {
    const grid = Array.from({ length: N }, () => new Array(N).fill(4));
    const patterns = [[[0, 0]], [[0, 0], [1, 0]], [[0, 0], [0, 1]], [[0, 0], [1, 1]], [[0, 0], [1, 0], [0, 1], [1, 1]],
      [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]];
    patterns.forEach((p, k) => { for (const [dx, dy] of p) grid[12 + 24 * Math.floor(k / 3) + dy][10 + 20 * (k % 3) + dx] = 3; });
    return grid;
  },
  // Quarters for Export Minimap's Include Blight: Lgrs in the north half, Ldrt in the south, the west half blighted
  // (FLAGS below), so each texture shows blighted and not.
  blight: () => Array.from({ length: N }, (_, y) => new Array(N).fill(y < 32 ? 4 : 0)),
};
/** Corner flags per map (rows from the north, one character per corner as war3map.w3e.txt writes them: 2 is blight). */
const FLAGS = {
  blight: () => Array.from({ length: N }, () => Array.from({ length: N }, (_, x) => (x < 32 ? 2 : 0))),
};
requireValid(only.every((n) => Object.hasOwn(MAPS, n)), `unknown map ${only.filter((n) => !Object.hasOwn(MAPS, n)).join(" ")}; usage: make-minimap-tiles.mjs <w3proj cli> <game folder> [${Object.keys(MAPS).join(" | ")}]…`);
for (const [name, make] of Object.entries(MAPS)) {
  if (only.length && !only.includes(name)) continue;
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    const file = join(dir, "map", "war3map.w3e.txt");
    const lines = readFileSync(file, "utf8").split("\n");
    // The corners' map-edge bits (the margins of flat.w3x) all off: no margin.
    const bits = lines.findIndex((l) => l.startsWith("[water-bits]"));
    if (bits < 0) throw new Error("no [water-bits] section in the w3e text");
    lines.splice(bits + 1, N, ...Array.from({ length: N }, () => "0".repeat(N)));
    const at = lines.findIndex((l) => l.startsWith("[texture]"));
    if (at < 0) throw new Error("no [texture] section in the w3e text");
    const grid = make();
    // Rows of the text run from the north (its first row is the map's top).
    lines.splice(at, 1, "[texture]", ...grid.map((row) => row.map((t) => t.toString(16)).join("")));
    if (FLAGS[name]) {
      const f = lines.findIndex((l) => l.startsWith("[flags]"));
      if (f < 0 || lines[f] !== "[flags] all 0") throw new Error("flat.w3x's w3e text has no plain [flags] all 0 line");
      lines.splice(f, 1, "[flags]", ...FLAGS[name]().map((row) => row.join("")));
    }
    writeFileSync(file, lines.join("\n"));
    const w3i = join(dir, "map", "war3map.w3i.json");
    const info = JSON.parse(readFileSync(w3i, "utf8"));
    info.cameraComplements = [0, 0, 0, 0];
    info.playableWidth = 64;
    info.playableHeight = 64;
    info.cameraBounds = [-3584, -4096, 3584, 3584, -3584, 3584, 3584, -4096];
    writeFileSync(w3i, JSON.stringify(info, null, 2));
    run("pack", "--keep-objects", dir, "-o", join(here, `minimap-tiles-${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
