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

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-low-ground.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
for (const [name, stored] of [["a", -7400], ["b", -8000], ["c", -8160]]) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "low");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const file = join(dir, "map", "war3map.w3e.txt");
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((l) => l.startsWith("[height]"));
    if (at < 0) throw new Error("no [height] section in the w3e text");
    let end = at + 1;
    while (end < lines.length && lines[end] !== "" && !lines[end].startsWith("[")) end++;
    const row = Array.from({ length: 65 }, () => stored).join(" ");
    lines.splice(at, end - at, "[height]", ...Array.from({ length: 65 }, () => row));
    writeFileSync(file, lines.join("\n"));
    run("pack", dir, "-o", join(here, `low-ground-${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
