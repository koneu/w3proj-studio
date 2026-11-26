// Makes the input of tests/we-compare/random-script.json from the World Editor's own empty 64x64 map:
//
//   node tests/fixtures/we-specs/make-random-script.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3x>
//
// Placed random objects of every kind the map script has a form for (war3mapUnits.doo, Player 1, 100 apart):
//   iDNR items by level and class: classes 0..7 at level "ffffff" (any) and "030000" (level 3);
//   uDNR units by level "ffffff" and "050000", and a bDNR building by level;
//   a unit (position 0) and an item (position 2) from random group 2, a unit (position 0) from group 7, one from group 5
//   (which doesn't exist), a unit from a custom list (randomType 2);
// and two random groups (numbers 2 and 7, which don't start at 0) whose lines hold plain ids, random creeps
// ("YYU3"), a random building ("YYB/") and random items ("YiI2", "YlI/").
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFresh } from "../../binfresh.mjs";
import { gamePath } from "../../gamepath.mjs";

const [empty, cli, out] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-random-script.mjs <empty map> <w3proj cli> <out.w3x>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const GROUPS = [
  { number: 2, name: "Mixed", positions: [0, 1, 2], lines: [
    { chance: 50, ids: ["hfoo", "YYB/", "YiI2"] },
    { chance: 50, ids: ["YYU3", "nmrl", "YlI/"] },
  ] },
  { number: 7, name: "Seven", positions: [0], lines: [{ chance: 100, ids: ["hkni"] }] },
];
const scratch = mkdtempSync(join(tmpdir(), "we-specs-random-script-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", gamePath());
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const map = join(dir, "map");
  const infoFile = join(map, "war3map.w3i.json");
  const info = JSON.parse(readFileSync(infoFile, "utf8"));
  info.unitTables = GROUPS;
  writeFileSync(infoFile, JSON.stringify(info, null, 1));
  const unitsFile = join(map, "war3mapUnits.doo.json");
  const doc = JSON.parse(readFileSync(unitsFile, "utf8"));
  const template = doc.units[0];
  let n = 0;
  const place = (id, extra) => {
    n += 1;
    const u = { ...template, id, skinId: id, position: [-1000 + 100 * n, 0, 0], player: 0, hp: -1, mana: -1, level: 1, gold: 12500, targetAcquisition: -1, editorId: n, trailer: [0, 0], ...extra };
    for (const k of ["randomLevel", "randomClass", "randomGroup", "randomPosition", "randomUnits"]) if (!(k in extra)) delete u[k];
    doc.units.push(u);
  };
  for (let c = 0; c < 8; c++) for (const level of ["ffffff", "030000"]) place("iDNR", { randomType: 0, randomLevel: level, randomClass: c });
  place("uDNR", { randomType: 0, randomLevel: "ffffff", randomClass: 0 });
  place("uDNR", { randomType: 0, randomLevel: "050000", randomClass: 0 });
  place("bDNR", { randomType: 0, randomLevel: "ffffff", randomClass: 0 });
  place("uDNR", { randomType: 1, randomGroup: 2, randomPosition: 0 });
  place("iDNR", { randomType: 1, randomGroup: 2, randomPosition: 2 });
  place("uDNR", { randomType: 1, randomGroup: 7, randomPosition: 0 });
  // A group that doesn't exist: the editor's script has to name something.
  place("uDNR", { randomType: 1, randomGroup: 5, randomPosition: 0 });
  place("uDNR", { randomType: 2, randomUnits: [{ id: "hfoo", chance: 60 }, { id: "hkni", chance: 40 }] });
  writeFileSync(unitsFile, JSON.stringify(doc, null, 1));
  // The script of the empty map knows nothing of these objects: Studio makes it again (a script it didn't write is kept).
  rmSync(join(map, "war3map.j"), { force: true });
  run("rebuild", dir, "--only", "script", "--game", gamePath());
  run("pack", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
