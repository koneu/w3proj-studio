// Makes dest-tint.w3x for the destructable tint spec (tests/we-compare/dest-tint.json) from flat.w3x:
//
//   node tests/fixtures/we-specs/make-dest-tint.mjs <w3proj cli> [game folder]   (the game folder defaults to the checkout's)
//
// Editors from 7000 on write `call SetDestructableVertexColor( gg_dest_..., r, g, b, 255 )` after every placed
// destructable the script names. Some placements got a tint other than 255 that isn't in the placement or in the object
// data (test.md); this map puts one destructable of each of many types, several of one type (varying variation, scale,
// angle, life), and one with each flag set on the 64x64 flat map, and a custom text trigger names every one, so the
// editor's script has them all (CreateAllDestructables).
//   node tests/fixtures/we-specs/make-dest-tint.mjs <cli> [<game folder>] [--types=A,B,..]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gamePath } from "../../gamepath.mjs";
import { requireFresh } from "../../binfresh.mjs";
import { addScriptTrigger } from "./trigger-folder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const typesArg = process.argv.find((a) => a.startsWith("--types="));
const cli = args[0] ? resolve(args[0]) : null;
if (!cli) { console.error("usage: make-dest-tint.mjs <w3proj cli> [game folder] [--types=A,B]"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const game = args[1] ? resolve(args[1]) : gamePath();
const run = (...a) => {
  const r = spawnSync(cli, a, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${a.join(" ")}: ${r.stderr}${r.stdout}`);
};
// Every destructable type of the game's own table (types of other tilesets too: the doo takes any id).
const slk = spawnSync(cli, ["game", "slk", "Units/DestructableData.slk", "--col", "DestructableID", "--install", game], { encoding: "utf8" });
if (slk.status !== 0) throw new Error(`w3proj game slk: ${slk.stderr}`);
const TYPES = typesArg ? typesArg.slice("--types=".length).split(",") : slk.stdout.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
const dir0 = (i) => ({ x: -3200 + (i % 24) * 270, y: -3000 + Math.floor(i / 24) * 280 });
const list = [];
// Flags 0, what the editor stores for a destructable its script creates (2 is one the game places from the doo: Studio's
// script leaves those out, the editor creates a named one whatever the input said and makes its flags 0: dest-flags.json).
// With --unref the flags cases include 2, 3 and 6; the named map keeps to 0, 1 and 4.
TYPES.forEach((id) => list.push({ id, variation: 0, scale: 1, life: 100, flags: 0 }));
// The first type again with other variations, scales, lives, flags.
for (let v = 1; v <= 6; v++) list.push({ id: "LTlt", variation: v, scale: 1 + v / 10, life: 100, flags: 0 });
for (const flags of process.argv.includes("--unref") ? [0, 1, 2, 3, 4, 6] : [0, 1, 4]) list.push({ id: "LTlt", variation: 0, scale: 1, life: 100, flags });
for (const life of [0, 1, 50, 99]) list.push({ id: "LTlt", variation: 0, scale: 1, life, flags: 0 });
// Tints in the map's own object data (bvcr, bvcg, bvcb): a changed original in war3map.w3b (LTe1) and in war3mapSkin.w3b
// (LTg1), a custom type with one field (B000 on LTe2), and one on a base whose original the map changes (LTe3 with bvcg
// 40: B001 sets nothing, B002 sets bvcb 7): does a custom type take the base's change?
const mod = (field, value) => ({ field, type: "int", value });
const W3B = {
  "war3map.w3b.json": {
    format: "w3proj.objects/1", version: 3,
    original: [
      { base: "LTe1", mods: [mod("bvcr", 100), mod("bvcg", 150), mod("bvcb", 200)] },
      { base: "LTe3", mods: [mod("bvcg", 40)] },
    ],
    custom: [
      { id: "B000", base: "LTe2", mods: [mod("bvcr", 10)] },
      { id: "B001", base: "LTe3", mods: [] },
      { id: "B002", base: "LTe3", mods: [mod("bvcb", 7)] },
      { id: "B003", base: "LTe4", mods: [] },
      { id: "B004", base: "LTe4", mods: [mod("bvcg", 9)] },
      { id: "B005", base: "LTg2", mods: [] },
      { id: "B006", base: "LTg2", mods: [mod("bvcg", 9)] },
    ],
  },
  // LTe4 is changed in war3map.w3b (bvcr 60), LTg2 only in the skin file (bvcr 70).
  "war3mapSkin.w3b.json": {
    format: "w3proj.objects/1", version: 3,
    original: [{ base: "LTg1", mods: [mod("bvcr", 80), mod("bvcg", 80), mod("bvcb", 80)] }, { base: "LTg2", mods: [mod("bvcr", 70)] }],
    custom: [],
  },
};
W3B["war3map.w3b.json"].original.push({ base: "LTe4", mods: [mod("bvcr", 60)] });
for (const id of ["B000", "B001", "B002", "B003", "B004", "B005", "B006"]) list.push({ id, variation: 0, scale: 1, life: 100, flags: 0 });
const scratch =mkdtempSync(join(tmpdir(), "we-specs-dest-tint-"));
try {
  const dir = join(scratch, "p");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const map = join(dir, "map");
  const dooFile = join(map, "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  doo.doodads = list.map((d, k) => ({
    id: d.id, variation: d.variation, position: [dir0(k).x, dir0(k).y, 0], angle: (k * 37 % 360) * Math.PI / 180, scale: [d.scale, d.scale, d.scale], skinId: d.id,
    preFlags: 4294967295, flags: d.flags, life: d.life, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [k + 1, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  rmSync(join(map, "war3map.j"), { force: true }); // no script: Studio writes one from the triggers, the editor too
  for (const [file, data] of Object.entries(W3B)) writeFileSync(join(map, file), JSON.stringify(data, null, 1));
  // --unref: no trigger names the destructables (dest-tint-unref.w3x, a map whose script creates none of them: what flags
  // does the editor's save give them?)
  const unref = process.argv.includes("--unref");
  if (unref) run("pack", dir, "-o", join(here, "dest-tint-unref.w3x"), "--force-stale");
  const names = unref ? [] : list.map((d, k) => `gg_dest_${d.id}_${String(k + 1).padStart(4, "0")}`);
  const body = names.map((n) => `    call SetDestructableLife(${n}, 1)`).join("\n");
  addScriptTrigger(dir, { name: "Names", description: "", isComment: 0, enabled: true, initiallyOff: false, runOnInit: false },
    `function InitTrig_Names takes nothing returns nothing\n${body}\nendfunction`);
  if (!unref) run("pack", dir, "-o", join(here, "dest-tint.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
