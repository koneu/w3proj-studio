// Makes the maps of the Level-over-water specs (tests/we-compare/level-stroke.json) from flat.w3x (the World Editor's
// own new 64x64 Lordaeron Summer map: flat ground at 0, level 2, water words 0x2000, no water anywhere):
//
//   node tests/fixtures/we-specs/make-level-wet.mjs <w3proj cli> <game folder>
//
//   level-wet-low.w3x   every corner wet, its water word 0x2000 (the surface at -89.6, below the ground at 0)
//   level-dry-high.w3x  every corner dry, its water word 0x2200 (the surface at 38.4, above the ground)
//   level-wet-steps.w3x every corner wet, the surface at 38.4, column x the ground at 38.4 + STEPS[x % 8] (rounded to
//                       the stored quarter: 1.9, 0.9 and 0.15 below, 0.1, 0.35, 1.1, 2.1 and 64.1 above)
//
// A cliff brush stroke's corners of level-wet-low show what the editor's stroke sets the water flag of again, and
// level-dry-high whether it wets the corners under the surface; level-wet-steps where the line between wet and dry is.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-level-wet.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const size = 65;
/** The surface of the water word 0x2200 is 38.4 (stored 512 / 4 − 89.6); the ground's stored word is 4 per world
 *  unit. Column x % 8 of level-wet-steps: the ground at 38.4 + STEPS[x % 8] world units, rounded to a stored quarter. */
const STEPS = [-2, -1, -0.25, 0, 0.25, 1, 2, 64];
const maps = {
  "level-wet-low": { flags: 4, water: () => 0, height: () => 0 },
  "level-dry-high": { flags: 0, water: () => 512, height: () => 0 },
  "level-wet-steps": { flags: 4, water: () => 512, height: (x) => Math.round((38.4 + STEPS[x % 8]) * 4) },
};
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  for (const [name, m] of Object.entries(maps)) {
    const dir = join(scratch, name);
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    const file = join(dir, "map", "war3map.w3e.txt");
    const lines = readFileSync(file, "utf8").split("\n");
    const section = (sec, rows) => {
      const at = lines.findIndex((l) => l.startsWith(`[${sec}]`));
      if (at < 0) throw new Error(`no [${sec}] section in the w3e text`);
      let end = at + 1;
      while (end < lines.length && lines[end] !== "" && !lines[end].startsWith("[")) end++;
      lines.splice(at, end - at, `[${sec}]`, ...rows);
    };
    const rows = (cell) => Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => cell(x, y)));
    section("water", rows((x, y) => m.water(x, y)).map((r) => r.join(" ")));
    section("height", rows((x, y) => m.height(x, y)).map((r) => r.join(" ")));
    section("flags", rows(() => m.flags.toString(16)).map((r) => r.join("")));
    writeFileSync(file, lines.join("\n"));
    run("pack", "--keep-objects", dir, "-o", join(here, `${name}.w3x`), "--force-stale");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
