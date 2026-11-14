// Makes dry-words.w3x for the cliff-level spec (tests/we-compare/cliff-adjust-dry.json) from flat.w3x (the World
// Editor's own new 64x64 Lordaeron Summer map: flat ground, level 2, water words 0x2000, no water anywhere):
//
//   node tests/fixtures/we-specs/make-dry-words.mjs <w3proj cli> <game folder>
//
// Every corner stays dry. The water words of the columns cycle through the extremes of the 14 bits (stored minus 0x2000:
// 8191, 7808, 0, 1024, -7808, -8192, -4096, 4096) and the cliff level is a band of five rows (rows 0-4 level 0, up to rows 60-64 level 12; steps of one level only: the editor
// evens out steeper cliffs itself),
// so a shift of +1 or -3 carries some of them past either end of the word and the editor's wrapping shows.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-dry-words.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "dry-words");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const file = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(file, "utf8").split("\n");
  const size = 65;
  const words = [8191, 7808, 0, 1024, -7808, -8192, -4096, 4096];
  const section = (name, rows) => {
    const at = lines.findIndex((l) => l.startsWith(`[${name}]`));
    if (at < 0) throw new Error(`no [${name}] section in the w3e text`);
    let end = at + 1;
    while (end < lines.length && lines[end] !== "" && !lines[end].startsWith("[")) end++;
    lines.splice(at, end - at, `[${name}]`, ...rows);
  };
  const rows = (cell) => Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => cell(x, y)));
  section("water", rows((x) => words[x % 8]).map((r) => r.join(" ")));
  section("layer", rows((x, y) => Math.floor(y / 5).toString(16)).map((r) => r.join("")));
  writeFileSync(file, lines.join("\n"));
  run("pack", dir, "-o", join(here, "dry-words.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
