// Makes the cliff-ground-*.w3x inputs of tests/we-compare/cliff-ground.json from flat.w3x (the World Editor's own new
// 64x64 Lordaeron Summer map, level 2 everywhere, ground Ldrt Ldro Ldrg Lrok Lgrs Lgrd, cliffs CLdi CLgr): does the
// editor's save add a cliff type's ground tile (CliffTypes.slk groundTile) that the ground list lacks, and when?
//
//   node tests/fixtures/we-specs/make-cliff-ground.mjs <w3proj cli> <game folder>
//
// Each variant is the plateau of make-plateau.mjs (level 3 on corners x 25..39, y 27..35) or no plateau, with:
//   unused      cliffs CLdi CLgr CAdi, the plateau's cliff corners CLgr (CAdi listed, not used)
//   used        cliffs CLdi CLgr CAdi, the plateau's cliff corners CAdi (example map 29's case)
//   flat        cliffs CLdi CLgr CAdi, no plateau, CAdi on a 3x3 block of flat corners only
//   nolgrs      ground without Lgrs, cliffs CLdi CLgr, the plateau's cliff corners CLgr
//   nolgrs-off  ground without Lgrs, cliffs CLdi CLgr, the plateau's cliff corners CLdi (CLgr listed, not used)
//   full        custom-tilesets 1, 16 ground tiles without Adrt, cliffs CLdi CLgr CAdi, the plateau CAdi
//   nolgrs1, nolgrs1-off, north-high, north-low, f-only, two: custom-tilesets 1, see `variants`
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cliArg, gameArg] = process.argv.slice(2);
const [cli, game] = [cliArg, gameArg].map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli");
if (!game) { console.error("usage: make-cliff-ground.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65, X0 = 25, X1 = 39, Y0 = 27, Y1 = 35;
const high = (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
const onCliff = (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
  const tx = x + dx, ty = y + dy;
  const q = [high(tx, ty), high(tx + 1, ty), high(tx, ty + 1), high(tx + 1, ty + 1)];
  return q.some(Boolean) && !q.every(Boolean);
});
const rows = (f) => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(""));
const SIX = "Ldrt Ldro Ldrg Lrok Lgrs Lgrd";
const FULL = "Ldrt Ldro Ldrg Lrok Lgrs Lgrd Fdrt Fdro Fgrs Wsnw Wgrs Bdrt Bgrr Ndrt Nsnw Vgrs";
const variants = {
  unused: { ground: SIX, cliffs: "CLdi CLgr CAdi", plateau: true, type: "1" },
  used: { ground: SIX, cliffs: "CLdi CLgr CAdi", plateau: true, type: "2" },
  flat: { ground: SIX, cliffs: "CLdi CLgr CAdi", plateau: false, type: "2" },
  nolgrs: { ground: "Ldrt Ldro Ldrg Lrok Lgrd", cliffs: "CLdi CLgr", plateau: true, type: "1" },
  "nolgrs-off": { ground: "Ldrt Ldro Ldrg Lrok Lgrd", cliffs: "CLdi CLgr", plateau: true, type: "0" },
  full: { ground: FULL, cliffs: "CLdi CLgr CAdi", plateau: true, type: "2", custom: true },
  // custom-tilesets 1 from here on (with 0 the save writes the tileset's own list whole, Lgrs included).
  "nolgrs1": { ground: "Ldrt Ldro Ldrg Lrok Lgrd", cliffs: "CLdi CLgr", plateau: true, type: "1", custom: true },
  "nolgrs1-off": { ground: "Ldrt Ldro Ldrg Lrok Lgrd", cliffs: "CLdi CLgr", plateau: true, type: "0", custom: true },
  // CAdi only on the north face's high corners (y 35: the bottom-left corners of the face's cliff tiles) or only on
  // its low corners (y 36: top corners of those tiles, bottom-left of no cliff tile); the other cliff corners CLgr.
  "north-high": { ground: SIX, cliffs: "CLdi CLgr CAdi", plateau: true, type: (x, y) => (y === 35 && x >= 26 && x <= 38 ? "2" : "1"), custom: true },
  "north-low": { ground: SIX, cliffs: "CLdi CLgr CAdi", plateau: true, type: (x, y) => (y === 36 && x >= 26 && x <= 38 ? "2" : "1"), custom: true },
  // Every cliff corner 15 (f): the type a cliff tile with corner 15 counts as (CLdi, the first, by Studio's drawing).
  "f-only": { ground: "Ldro Ldrg Lrok Lgrs Lgrd", cliffs: "CLdi CLgr", plateau: true, type: "f", custom: true },
  // Two missing types: CFdi (4th in the cliff list) on the south face, CAdi (3rd) on the north face: the order added.
  two: { ground: SIX, cliffs: "CLdi CLgr CAdi CFdi", plateau: true, type: (x, y) => (y <= 28 ? "3" : y >= 34 ? "2" : "1"), custom: true },
};
const typeAt = (v, x, y) => (typeof v.type === "function" ? v.type(x, y) : v.type);
const scratch = mkdtempSync(join(tmpdir(), "we-specs-cliff-ground-"));
try {
  for (const [name, v] of Object.entries(variants)) {
    const dir = join(scratch, name);
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    const w3e = join(dir, "map", "war3map.w3e.txt");
    const lines = readFileSync(w3e, "utf8").split("\n");
    const block = (x, y) => Math.abs(x - 32) <= 1 && Math.abs(y - 32) <= 1;
    const sections = {
      layer: rows((x, y) => (v.plateau && high(x, y) ? "3" : "2")),
      "cliff-texture": rows((x, y) => (v.plateau ? (onCliff(x, y) ? typeAt(v, x, y) : "f") : block(x, y) ? typeAt(v, x, y) : "f")),
    };
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^\[([a-z-]+)\]/.exec(lines[i]);
      if (m && m[1] in sections) {
        out.push(`[${m[1]}]`, ...sections[m[1]]);
        while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
        continue;
      }
      if (lines[i].startsWith("ground ")) { out.push(`ground ${v.ground}`); continue; }
      if (lines[i].startsWith("cliffs ")) { out.push(`cliffs ${v.cliffs}`); continue; }
      if (lines[i].startsWith("custom-tilesets ")) { out.push(`custom-tilesets ${v.custom ? 1 : 0}`); continue; }
      out.push(lines[i]);
    }
    writeFileSync(w3e, out.join("\n"));
    run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
    run("pack", "--keep-objects", dir, "-o", join(here, `cliff-ground-${name}.w3x`));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
