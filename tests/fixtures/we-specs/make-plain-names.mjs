// Makes plain-names-a.w3m and plain-names-b.w3m, the inputs of tests/we-compare/plain-names.json: what the World
// Editor's save (no Map Size) does to plain players' and forces' names in war3map.w3i. From the empty 64 x 64 map
// (one player named TRIGSTR_001, one force TRIGSTR_002; the string table holds 1 "Player 1" and 2 "Force 1"):
//
//   node tests/fixtures/we-specs/make-plain-names.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> [a|b|c]
//
// (a variant named: only that one is written)
// a: three players named "Plain player 1", "" and "Plain player 3" (start locations at (-2176, 640), (1280, 640) and
//    (-2176, -1664)), the one force named "Plain force".
// b: the same players named "", "Plain player 2" and "TRIGSTR_001", custom forces (w3i flag 0x0040) with three forces
//    named "Plain force A", "" and "Plain force C", one player each.
// c: names that repeat (a fourth start at (1280, -1664)): players "Twin", "Twin", "Player 1" (the text of string 1),
//    "twin"; custom forces "Twin", "Force 1" (the text of string 2) and "Lone", players 1, 2 and 3 + 4.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [empty, cli] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
if (!cli) { console.error("usage: make-plain-names.mjs <empty map> <w3proj cli>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const STARTS = [[-2176, 640], [1280, 640], [-2176, -1664], [1280, -1664]];
const VARIANTS = {
  a: { players: ["Plain player 1", "", "Plain player 3"], forces: [["Plain force", 0xffffffff]] },
  b: { players: ["", "Plain player 2", "TRIGSTR_001"], forces: [["Plain force A", 1], ["", 2], ["Plain force C", 4]], customForces: true },
  c: { players: ["Twin", "Twin", "Player 1", "twin"], forces: [["Twin", 1], ["Force 1", 2], ["Lone", 12]], customForces: true },
};
const only = process.argv[4];
if (only !== undefined && !Object.hasOwn(VARIANTS, only)) { console.error(`no variant ${only}`); process.exit(2); }
for (const [variant, v] of Object.entries(VARIANTS)) {
  if (only && variant !== only) continue;
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-plain-names-"));
  try {
    const dir = join(scratch, "p");
    run("unpack", empty, dir, "--game", "none");
    const map = join(dir, "map");
    const infoFile = join(map, "war3map.w3i.json");
    const info = JSON.parse(readFileSync(infoFile, "utf8"));
    const player = info.players[0];
    info.players = v.players.map((name, id) => ({ ...player, id, name, start: [...STARTS[id]] }));
    info.forces = v.forces.map(([name, players]) => ({ ...info.forces[0], players, name }));
    if (v.customForces) info.flags |= 0x0040;
    writeFileSync(infoFile, JSON.stringify(info, null, 2));
    const unitsFile = join(map, "war3mapUnits.doo.json");
    const units = JSON.parse(readFileSync(unitsFile, "utf8"));
    const sloc = units.units[0];
    units.units = STARTS.slice(0, v.players.length).map(([x, y], i) => ({ ...sloc, player: i, editorId: i, position: [x, y, 0] }));
    writeFileSync(unitsFile, JSON.stringify(units, null, 2));
    run("pack", dir, "-o", join(here, `plain-names-${variant}.w3m`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
