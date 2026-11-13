// Makes slope.w3x for the water brush spec (tests/we-compare/water-brush-slope.json) from flat.w3x (the World Editor's
// own new 64x64 Lordaeron Summer map, level 2 everywhere):
//
//   node tests/fixtures/we-specs/make-slope.mjs <w3proj cli> <game folder>
//
// The ground rises along x: corner column x stands at (x - 32) * 24 stored units (a quarter of a world unit each) over
// its cliff level, so from -768 to 768 (6 world units a corner), and the ground a click lands on is tilted, as a bank
// is. No cliffs, no water.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-slope.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "slope");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const file = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith("[height]"));
  if (at < 0) throw new Error("no [height] section in the w3e text");
  let end = at + 1;
  while (end < lines.length && lines[end] !== "" && !lines[end].startsWith("[")) end++;
  const row = Array.from({ length: 65 }, (_, x) => (x - 32) * 24).join(" ");
  lines.splice(at, end - at, "[height]", ...Array.from({ length: 65 }, () => row));
  writeFileSync(file, lines.join("\n"));
  run("pack", dir, "-o", join(here, "slope.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
