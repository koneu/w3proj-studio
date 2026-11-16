// Makes the inputs of the water height limit spec (tests/we-compare/water-limit-low.json) from flat.w3x (the World
// Editor's own new 64x64 Lordaeron Summer map, level 2 everywhere):
//
//   node tests/fixtures/we-specs/make-low-ground.mjs <w3proj cli> <game folder>
//
// - low-ground-a.w3x, -b.w3x, -c.w3x: every corner's ground at a stored height of -7400, -8000 and -8160 (a quarter of
//   a world unit each: world heights -1850, -2000, -2040), so a water brush's water level lands near and at the lower
//   end of the stored water range (-2137.6). No cliffs, no water.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-low-ground.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
// - low-ground-d.w3x: the ground at -8400 (world -2100, below the stored word's 0) but the corner the specs click (32, 30
//   from the south) at -8192, world -2048. The World Editor doesn't take such ground: it opened the whole map at 7984.
// - low-ground-e.w3x: every corner at -8192 on level 1 (world -2176) but the clicked corner on level 2 (world -2048): a
//   size 3 water brush there has its click corner at the floor and its neighbours below it.
// [name, stored height, the clicked corner's, the level, the clicked corner's]
for (const [name, stored, centre, level, centreLevel] of [["a", -7400], ["b", -8000], ["c", -8160], ["d", -8400, -8192], ["e", -8192, -8192, 1, 2]]) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "low");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const file = join(dir, "map", "war3map.w3e.txt");
    const lines = readFileSync(file, "utf8").split("\n");
    // One line per row of corners, from the north: the row 30 from the south is line 34.
    const grid = (section, rest, mid, sep) => {
      const at = lines.findIndex((l) => l.startsWith(`[${section}]`));
      if (at < 0) throw new Error(`no [${section}] section in the w3e text`);
      let end = at + 1;
      while (end < lines.length && lines[end] !== "" && !lines[end].startsWith("[")) end++;
      const rows = Array.from({ length: 65 }, (_, line) =>
        Array.from({ length: 65 }, (_, x) => (mid !== undefined && line === 64 - 30 && x === 32 ? mid : rest)).join(sep));
      lines.splice(at, end - at, `[${section}]`, ...rows);
    };
    grid("height", stored, centre, " ");
    if (level !== undefined) grid("layer", level.toString(16), centreLevel.toString(16), "");
    writeFileSync(file, lines.join("\n"));
    run("pack", dir, "-o", join(here, `low-ground-${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
