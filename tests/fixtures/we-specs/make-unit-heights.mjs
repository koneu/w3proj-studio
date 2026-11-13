// Makes unit-heights.w3x for the Reset Fixed Object Heights specs (tests/we-compare/unit-heights.json) from flat.w3x
// (the World Editor's own new 64x64 Lordaeron Summer map, level 2 everywhere):
//
//   node tests/fixtures/we-specs/make-unit-heights.mjs <w3proj cli> <game folder>
//
// A plateau two cliff levels up (ground height 256) over corners 20-40 in both directions (world x and y from -1536
// to 1024), and four units with a height of their own in the file: footmen at 0 and 500 on the plateau, a footman at 500
// on the flat ground, a gryphon at 0 on the plateau. The editor saves every unit at the height of the ground it stands on.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-unit-heights.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "unit-heights");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith("[layer]"));
  if (at < 0) throw new Error("no [layer] section in the w3e text");
  let end = at + 1;
  while (end < lines.length && lines[end] !== "" && !lines[end].startsWith("[")) end++;
  const rows = Array.from({ length: 65 }, (_, y) => Array.from({ length: 65 }, (_, x) => (x >= 20 && x <= 40 && y >= 20 && y <= 40 ? "4" : "2")).join(""));
  lines.splice(at, end - at, "[layer]", ...rows);
  writeFileSync(w3e, lines.join("\n"));

  const file = join(dir, "map", "war3mapUnits.doo.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const template = doc.units[0];
  for (const [i, [id, x, y, z]] of [["hfoo", 0, 0, 0], ["hfoo", -1280, 128, 500], ["hfoo", 2048, -1792, 500], ["hgry", 512, 512, 0]].entries()) {
    doc.units.push({ ...template, id, skinId: id, position: [x, y, z], player: 0, editorId: i + 1, trailer: [0, 0] });
  }
  writeFileSync(file, JSON.stringify(doc, null, 2));
  run("pack", dir, "-o", join(here, "unit-heights.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
