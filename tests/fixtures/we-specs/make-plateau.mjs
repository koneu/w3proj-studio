// Makes plateau.w3x for the Ramp specs (tests/we-compare/ramp-*.json) from flat.w3x (the World Editor's own new 64x64
// Lordaeron Summer map, level 2 everywhere): a rectangular plateau one cliff level up (level 3) with straight faces on
// all four sides, corners x 25..39, y 27..35, Grass Cliff (cliff type 1) on the cliff's corners, as the editor's Apply
// Cliff Increase One leaves them:
//
//   node tests/fixtures/we-specs/make-plateau.mjs <w3proj cli> <game folder> [diamond]
//
// The size-5 Increase One plateau of the editor itself is round and bends every two corners, so a ramp fits only at
// the ends of each face there; this one has long straight faces to click along. `diamond` writes diamond.w3x
// instead: level 3 on the corners with |x - 32| + |y - 32| <= 8, a square turned 45 degrees whose four faces are
// diagonal cliffs, one corner step at a time (tests/we-compare/ramp-diagonal.json).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cliArg, gameArg, shape = "rect"] = process.argv.slice(2);
const [cli, game] = [cliArg, gameArg].map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game || !["rect", "diamond"].includes(shape)) { console.error("usage: make-plateau.mjs <w3proj cli> <game folder> [diamond]"); process.exit(2); }
const diamond = shape === "diamond";
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65, X0 = 25, X1 = 39, Y0 = 27, Y1 = 35;
const high = diamond
  ? (x, y) => Math.abs(x - 32) + Math.abs(y - 32) <= 8
  : (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
/** A corner of a tile with corners on both levels. */
const onCliff = (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
  const tx = x + dx, ty = y + dy;
  const q = [high(tx, ty), high(tx + 1, ty), high(tx, ty + 1), high(tx + 1, ty + 1)];
  return q.some(Boolean) && !q.every(Boolean);
});
/** A section's rows as the text keeps them: the top row (y = 64) first. */
const rows = (f) => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(""));
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "plateau");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const sections = {
    layer: rows((x, y) => (high(x, y) ? "3" : "2")),
    "cliff-texture": rows((x, y) => (onCliff(x, y) ? "1" : "f")),
  };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[i]);
    if (m && m[1] in sections) {
      out.push(`[${m[1]}]`, ...sections[m[1]]);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    out.push(lines[i]);
  }
  writeFileSync(w3e, out.join("\n"));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  run("pack", dir, "-o", join(here, diamond ? "diamond.w3x" : "plateau.w3x"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
