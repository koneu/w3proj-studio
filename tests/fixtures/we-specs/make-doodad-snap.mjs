// Makes doodad-snap-custom.w3x for the Snap Doodads on Load spec (tests/we-compare/doodad-snap-custom.json) from
// flat.w3x (the World Editor's own new 64x64 Lordaeron Summer map):
//
//   node tests/fixtures/we-specs/make-doodad-snap.mjs <w3proj cli> <game folder>
//
// Custom doodad types D000..D006 (war3map.w3d, based on the hay cart LOch) and custom destructables B000..B003 (war3map.w3b,
// based on the tree LTlt) whose pathing texture the map's object data names (dptx / bptx), one of each placed off its
// grid and off its quarter turn; the editor snaps them when it opens the map, from the type's texture as the map names it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-doodad-snap.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

// [type id, base, texture name]
const DOODADS = [
  ["D000", "LOch", "2x2Default"], ["D001", "LOch", "4x4Default"], ["D002", "LOch", "6x6Default"], ["D003", "LOch", "8x4Default"],
  ["D004", "LOch", "12x4Default"], ["D005", "LOch", "1x1Default"], ["D006", "LOch", "_"],
];
const DESTRUCTABLES = [["B000", "LTlt", "2x2Default"], ["B001", "LTlt", "4x4Default"], ["B002", "LTlt", "8x4Default"], ["B003", "LTlt", "_"]];
const tex = (name) => (name === "_" ? "_" : `PathTextures\\${name}.tga`);
const mods = (field, name) => [{ field, type: "string", value: tex(name), level: 0, data: 0 }];

const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "doodad-snap");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  writeFileSync(join(dir, "map", "war3map.w3d.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [],
    custom: DOODADS.map(([id, base, name]) => ({ base, id, mods: mods("dptx", name) })) }, null, 2));
  writeFileSync(join(dir, "map", "war3map.w3b.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [],
    custom: DESTRUCTABLES.map(([id, base, name]) => ({ base, id, mods: mods("bptx", name) })) }, null, 2));

  const file = join(dir, "map", "war3map.doo.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const f32 = Math.fround;
  const put = (id, i, row, angle) => doc.doodads.push({
    id, variation: 0, position: [-1500 + i * 300 + 13.5, row + 21.25, 0], angle: f32(angle), scale: [1, 1, 1], skinId: id,
    preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [doc.doodads.length, 0, 0], extras: [] });
  DOODADS.forEach(([id], i) => { put(id, i, 500, 0.4); put(id, i, -500, 1.2); });
  DESTRUCTABLES.forEach(([id], i) => { put(id, i, 1000, 0.4); put(id, i, -1000, 2.9); });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  run("pack", dir, "-o", join(here, "doodad-snap-custom.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
