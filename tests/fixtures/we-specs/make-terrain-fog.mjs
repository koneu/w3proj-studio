// Makes target/terrain-fog/tf-*.w3x for tests/we-compare/terrain-fog.json from flat.w3x (the World Editor's own new
// 64x64 map): Use Terrain Fog on, and a distinct value in each of the six 3.0 terrain fog words (Height Start, Height
// End, Linear Start, Linear End, Max Opacity, Draw Fog Over Sky; crates/w3proj/formats/w3i.json). The editor's save
// writes its war3map.j from them (SetTerrainFogExV, BlzSetTerrainFogMaxLinearDensity, BlzSetTerrainFogDrawOverSky;
// measured 2026-11-25), Studio's spec step its own; the maps carry no war3map.j.
//
//   node tests/fixtures/we-specs/make-terrain-fog.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
//
//   tf-on    fog style 3 (Height), words 250, -125, 1500, 6000, 0.75, 1 (drawn over the sky)
//   tf-off   fog style 4 (New Exponential 1), words -40.25, -300, 0, 13, 0.123, 0, another colour and density
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-terrain-fog.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "terrain-fog");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
/** w3i flag "Use terrain fog". */
const TERRAIN_FOG = 0x2000;
const CASES = {
  "tf-on": { fog: { style: 3, start: 3000, end: 5000, density: 0.5, color: [64, 128, 192, 255] },
    terrainFog: { heightStart: 250, heightEnd: -125, linearStart: 1500, linearEnd: 6000, maxOpacity: 0.75, drawOverSky: 1 } },
  "tf-off": { fog: { style: 4, start: 1000, end: 4000, density: 2.25, color: [10, 200, 30, 255] },
    terrainFog: { heightStart: -40.25, heightEnd: -300, linearStart: 0, linearEnd: 13, maxOpacity: 0.123, drawOverSky: 0 } },
};
mkdirSync(out, { recursive: true });
for (const [name, c] of Object.entries(CASES)) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-terrain-fog-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const path = join(dir, "map", "war3map.w3i.json");
    const info = JSON.parse(readFileSync(path, "utf8"));
    info.flags |= TERRAIN_FOG;
    info.fog = c.fog;
    info.terrainFog = c.terrainFog;
    writeFileSync(path, JSON.stringify(info, null, 2));
    // No war3map.j: the editor's save makes its own, Studio's spec step its own (it keeps a script it didn't write).
    rmSync(join(dir, "map", "war3map.j"), { force: true });
    run("pack", "--keep-objects", dir, "-o", join(out, `${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
console.log(`made ${Object.keys(CASES).map((n) => `${n}.w3x`).join(", ")} in ${out}`);
