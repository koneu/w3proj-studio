// Makes barricade-flags.w3x and barricade-flags-v8.w3x for tests/we-compare/barricade-flags.json from flat.w3x:
//
//   node tests/fixtures/we-specs/make-barricade-flags.mjs <w3proj cli> [game folder]   (the game folder defaults to the checkout's)
//
// bugs.md: on AutumnLeaves the editor's save turned flags 3 into 1 on the two barricades (LTba) that had item sets and
// kept 3 on a third without. This map varies one thing at a time on the 64x64 flat map (Lordaeron Summer), no trigger
// naming any destructable and no script (the editor writes one, Studio too): LTba without drops and with one item set,
// each with flags 0 to 3; LTba flags 3 with one set of two items, two sets, an empty set list entry, a set whose only
// item has chance 0, a random item, a map item table that exists (0) and one that doesn't (5); flags 4 to 7 with
// drops (fixed height); a tree (LTlt), crates and barrels (LTcr, LTbx) with and without drops; plain doodads (LPrs)
// given item sets; LTba flags 0 and 3 with and without drops past the playable area. barricade-flags-v8.w3x is the same list in war3map.doo version 8 (skin ids, no 1.33 fields).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gamePath } from "../../gamepath.mjs";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const cli = args[0] ? resolve(args[0]) : null;
if (!cli) { console.error("usage: make-barricade-flags.mjs <w3proj cli> [game folder]"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const game = args[1] ? resolve(args[1]) : gamePath();
const run = (...a) => {
  const r = spawnSync(cli, a, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${a.join(" ")}: ${r.stderr}${r.stdout}`);
};

const one = [[{ id: "ratc", chance: 100 }]];
// Index in war3map.doo = the order here (the spec's ignore paths and the report's table name them by it).
const list = [
  ...[0, 1, 2, 3].map((flags) => ({ id: "LTba", flags })), //                          0-3   no drops
  ...[0, 1, 2, 3].map((flags) => ({ id: "LTba", flags, itemSets: one })), //            4-7   one set, one item
  { id: "LTba", flags: 3, itemSets: [[{ id: "phea", chance: 60 }, { id: "pman", chance: 40 }]] }, // 8  one set, two items
  { id: "LTba", flags: 3, itemSets: [[{ id: "ratc", chance: 100 }], [{ id: "phea", chance: 50 }]] }, // 9  two sets
  { id: "LTba", flags: 3, itemSets: [[]] }, //                                          10    one empty set
  { id: "LTba", flags: 3, itemSets: [[{ id: "ratc", chance: 0 }]] }, //                 11    an item of chance 0
  { id: "LTba", flags: 3, itemSets: [[{ id: "YiI2", chance: 100 }]] }, //               12    a random item
  { id: "LTba", flags: 3, itemTable: 0 }, //                                            13    the map's item table 0
  { id: "LTba", flags: 3, itemTable: 5 }, //                                            14    a table the map hasn't
  ...[4, 5, 6, 7].map((flags) => ({ id: "LTba", flags, itemSets: one })), //            15-18 fixed height, drops
  ...[0, 1, 2, 3].map((flags) => ({ id: "LTlt", flags, itemSets: one })), //            19-22 tree, drops
  { id: "LTlt", flags: 3 }, //                                                          23    tree, no drops
  { id: "LTcr", flags: 3, itemSets: one }, { id: "LTcr", flags: 3 }, //                 24-25 crates
  { id: "LTbx", flags: 3, itemSets: one }, { id: "LTbx", flags: 3 }, //                 26-27 barrel
  ...[0, 1, 2, 3].map((flags) => ({ id: "LPrs", flags, itemSets: one })), //            28-31 doodad (not destructable)
  { id: "LPrs", flags: 3 }, //                                                          32    doodad, no drops
  // Past the playable area's right edge (x 3328 on flat.w3x), as AutumnLeaves' barricades at x 6400 of 6272.
  ...[0, 3].map((flags) => ({ id: "LTba", flags, outside: true })), //                  33-34 outside, no drops
  ...[0, 3].map((flags) => ({ id: "LTba", flags, itemSets: one, outside: true })), //   35-36 outside, drops
];
const at = (k) => (list[k].outside ? { x: 3712, y: -2400 + (k - 33) * 640 } : { x: -2800 + (k % 9) * 640, y: -2800 + Math.floor(k / 9) * 640 });

const scratch = mkdtempSync(join(tmpdir(), "we-specs-barricade-flags-"));
try {
  const dir = join(scratch, "p");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const map = join(dir, "map");
  const w3iFile = join(map, "war3map.w3i.json");
  const w3i = JSON.parse(readFileSync(w3iFile, "utf8"));
  w3i.itemTables = [{ number: 0, name: "Loot", sets: [[{ chance: 100, id: "phea" }]] }];
  writeFileSync(w3iFile, JSON.stringify(w3i, null, 1));
  rmSync(join(map, "war3map.j"), { force: true }); // no script: Studio writes one from the triggers, the editor too
  const dooFile = join(map, "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  const placed = list.map((d, k) => ({
    id: d.id, variation: 0, position: [at(k).x, at(k).y, 0], angle: 0, scale: [1, 1, 1], skinId: d.id,
    preFlags: 4294967295, flags: d.flags, life: 100, itemTable: d.itemTable ?? -1, itemSets: d.itemSets ?? [],
    editorId: 4294967295, trailer: [k + 1, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify({ ...doo, version: 13, subversion: 11, doodads: placed }, null, 1));
  run("pack", dir, "-o", join(here, "barricade-flags.w3x"), "--force-stale");
  // Version 8 with skin ids, as AutumnLeaves has it: the creation number in editorId, no preFlags, trailer or extras.
  const v8 = placed.map(({ preFlags, trailer, extras, ...d }, k) => ({ ...d, editorId: k + 1 }));
  writeFileSync(dooFile, JSON.stringify({ ...doo, version: 8, subversion: 11, skinIds: true, doodads: v8 }, null, 1));
  run("pack", dir, "-o", join(here, "barricade-flags-v8.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${join(here, "barricade-flags.w3x")} and barricade-flags-v8.w3x (${list.length} doodads)`);
