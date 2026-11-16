// Makes the inputs of the cliff slope specs (tests/we-compare/cliff-slope.json) from flat.w3x (the World Editor's own
// new 64x64 Lordaeron Summer map, level 2 everywhere, ground at 0, no cliff type):
//
// - level14.w3x: every corner on cliff level 14, so an Increase Two there goes past the top (wraps round with Enforce
//   Terrain Limits off, does nothing with it on).
// - pyramid.w3x: a stepped pyramid round corner 32,23, level 12 on its top (the 7x7 corners within 3 of it), each ring
//   further out two levels lower (10, 8, 6, 4) down to the flat level 2 from 8 corners out, Grass Cliff (cliff type 1)
//   on the corners of its cliff tiles, as the editor's brushes leave them. Its top is where the editor's opening camera
//   looks through the middle of its view at that height, so a click there (the specs take 748,478, where both editors'
//   picks land on one corner) lands on flat ground, and a brush wider than the top runs down the slope.
//
//   node tests/fixtures/we-specs/make-levels.mjs <w3proj cli> <game folder>
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-levels.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
/** A section's rows as the text keeps them: the top row (y = 64) first. */
const rows = (f) => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(""));
const pyramid = (x, y) => Math.max(2, 12 - 2 * Math.max(0, Math.max(Math.abs(x - 32), Math.abs(y - 23)) - 3));
/** A corner of a tile with corners on more than one level. */
const onCliff = (level) => (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
  const tx = x + dx, ty = y + dy;
  if (tx < 0 || ty < 0 || tx >= N - 1 || ty >= N - 1) return false;
  const q = [level(tx, ty), level(tx + 1, ty), level(tx, ty + 1), level(tx + 1, ty + 1)];
  return q.some((v) => v !== q[0]);
});
const MAPS = {
  level14: { layer: () => 14 },
  pyramid: { layer: pyramid, cliffType: onCliff(pyramid) },
};
const scratch = mkdtempSync(join(tmpdir(), "we-specs-levels-"));
try {
  for (const [name, { layer, cliffType }] of Object.entries(MAPS)) {
    const dir = join(scratch, name);
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const w3e = join(dir, "map", "war3map.w3e.txt");
    const text = readFileSync(w3e, "utf8");
    if (!text.includes("[layer] all 2\n") || !text.includes("[cliff-texture] all f\n")) throw new Error("flat.w3x's w3e isn't one level and one cliff type any more");
    const types = cliffType ? `[cliff-texture]\n${rows((x, y) => (cliffType(x, y) ? "1" : "f")).join("\n")}\n` : "[cliff-texture] all f\n";
    writeFileSync(w3e, text.replace("[layer] all 2\n", `[layer]\n${rows((x, y) => layer(x, y).toString(16)).join("\n")}\n`).replace("[cliff-texture] all f\n", types));
    run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
    run("pack", dir, "-o", join(here, `${name}.w3x`));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
