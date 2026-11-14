// Makes the water brush spec's other inputs (tests/we-compare/water-brush-slope.json) from slope.w3x:
//
//   node tests/fixtures/we-specs/make-water-inputs.mjs <w3proj cli> <game folder>
//
// - slope-swapped.w3x: slope.w3x with the terrain's cliff list the other way round (CLgr CLdi), to tell whether the
//   World Editor's water brush gives its rim the palette's cliff type or the one at a place in the map's list.
// - slope-edge.w3x: slope.w3x with corner columns 34 and up one cliff level higher (3, the rest 2), the cliff corners
//   (columns 33 and 34) typed 0 (Dirt Cliff): a cliff edge running north-south two corners east of the middle.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-water-inputs.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
/** Replaces the "[name] all v" line of a section with `rows` (65 rows of 65 characters). */
const section = (lines, name, row) => {
  const at = lines.findIndex((l) => l.startsWith(`[${name}]`));
  if (at < 0 || !/ all /.test(lines[at])) throw new Error(`no "[${name}] all" line in the w3e text`);
  lines.splice(at, 1, `[${name}]`, ...Array.from({ length: 65 }, () => row));
};
const make = (out, edit) => {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "slope.w3x"), dir, "--game", game);
    const file = join(dir, "map", "war3map.w3e.txt");
    const lines = readFileSync(file, "utf8").split("\n");
    edit(lines);
    writeFileSync(file, lines.join("\n"));
    run("pack", dir, "-o", join(here, out), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

make("slope-swapped.w3x", (lines) => {
  const at = lines.findIndex((l) => l === "cliffs CLdi CLgr");
  if (at < 0) throw new Error("the cliff list isn't CLdi CLgr");
  lines[at] = "cliffs CLgr CLdi";
});
make("slope-edge.w3x", (lines) => {
  section(lines, "layer", Array.from({ length: 65 }, (_, x) => (x >= 34 ? "3" : "2")).join(""));
  section(lines, "cliff-texture", Array.from({ length: 65 }, (_, x) => (x === 33 || x === 34 ? "0" : "f")).join(""));
});
