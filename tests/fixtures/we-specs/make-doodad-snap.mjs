// Makes doodad-snap-custom.w3x for the Snap Doodads on Load spec (tests/we-compare/doodad-snap-custom.json) from
// flat.w3x (the World Editor's own new 64x64 Lordaeron Summer map):
//
//   node tests/fixtures/we-specs/make-doodad-snap.mjs <w3proj cli> <game folder> [more|tex|col]
//
// Custom doodad types D000..D006 (war3map.w3d, based on the hay cart LOch) and custom destructables B000..B003 (war3map.w3b,
// based on the tree LTlt) whose pathing texture the map's object data names (dptx / bptx), one of each placed off its
// grid and off its quarter turn; the editor snaps them when it opens the map, from the type's texture as the map names it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
// "more" as the third argument makes doodad-snap-custom-more.w3x: other textures and fixed rotations (below)
const more = process.argv[4] === "more";
// "tex": doodad-snap-custom-tex.w3x: doodads whose pathing texture is a file of the map's own (Custom/own-*.tga), square
// with different patterns of blocked cells (TEXTURES), to see which square textures the editor turns to a quarter
const tex4 = process.argv[4] === "tex" || process.argv[4] === "col";
const colours = process.argv[4] === "col";
if (!game) { console.error("usage: make-doodad-snap.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

// [type id, base, texture name]
// own texture name -> rows of the pattern, top row first (X blocked, . free)
const COLOURS = {
  "own-red4": ["RRRR", "RRRR", "RRRR", "RRRR"], "own-green4": ["GGGG", "GGGG", "GGGG", "GGGG"], "own-blue4": ["BBBB", "BBBB", "BBBB", "BBBB"],
  "own-black4": ["....", "....", "....", "...."], "own-white4": ["WWWW", "WWWW", "WWWW", "WWWW"],
  "own-xr4": ["XXXX", "XXXX", "XXXX", "XXXR"], "own-xg4": ["XXXX", "XXXX", "XXXX", "XXXG"], "own-xb4": ["XXXX", "XXXX", "XXXX", "XXXB"],
};
const TEXTURES = colours ? COLOURS : {
  "own-ring4": ["XXXX", "X..X", "X..X", "XXXX"], "own-corner4": ["X...", "....", "....", "...."], "own-row4": ["XXXX", "....", "....", "...."],
  "own-diag4": ["X...", ".X..", "..X.", "...X"], "own-half4": ["XX..", "XX..", "XX..", "XX.."], "own-diag2": ["X.", ".X"],
  "own-cross4": [".XX.", "XXXX", "XXXX", ".XX."], "own-full4": ["XXXX", "XXXX", "XXXX", "XXXX"], "own-quad4": ["XX..", "XX..", "..XX", "..XX"],
};
const tga = (rows) => {
  const h = rows.length, w = rows[0].length, head = Buffer.alloc(18);
  head.writeUInt8(2, 2); head.writeUInt16LE(w, 12); head.writeUInt16LE(h, 14); head.writeUInt8(24, 16);
  const px = [];
  for (const row of [...rows].reverse()) for (const c of row) px.push(...({ X: [255, 0, 255], R: [0, 0, 255], G: [0, 255, 0], B: [255, 0, 0], W: [255, 255, 255] }[c] ?? [0, 0, 0]));
  return Buffer.concat([head, Buffer.from(px)]);
};
const DOODADS = tex4 ? Object.keys(TEXTURES).map((name, i) => [`D2${String(i).padStart(2, "0")}`, "LOch", name]) : more ? [
  ["D100", "LOch", "1x1Default"], ["D101", "LOch", "8x8Default"], ["D102", "LOch", "16x16Default"], ["D103", "LOch", "2x1Default"],
  ["D104", "LOch", "4x1Default"], ["D105", "LOch", "_"],
] : [
  ["D000", "LOch", "2x2Default"], ["D001", "LOch", "4x4Default"], ["D002", "LOch", "6x6Default"], ["D003", "LOch", "8x4Default"],
  ["D004", "LOch", "12x4Default"], ["D005", "LOch", "1x1Default"], ["D006", "LOch", "_"],
];
// [type id, base, texture name, fixed rotation (bfxr) or null to leave the base's]
const DESTRUCTABLES = tex4 ? [] : more ? [
  ["B100", "LTlt", "_", 90], ["B101", "LTlt", "_", -1], ["B102", "LTlt", "2x2Default", 90], ["B103", "LTlt", "2x2Default", -1],
  ["B104", "LTlt", "1x1Default", 270], ["B105", "LTlt", "4x4Default", 0], ["B106", "LTlt", "_", 0], ["B107", "LTlt", "2x1Default", 90],
] : [["B000", "LTlt", "2x2Default"], ["B001", "LTlt", "4x4Default"], ["B002", "LTlt", "8x4Default"], ["B003", "LTlt", "_"]];
const tex = (name) => (name === "_" ? "_" : name in TEXTURES ? `Custom\\${name}.tga` : `PathTextures\\${name}.tga`);
const mods = (field, name) => [{ field, type: "string", value: tex(name), level: 0, data: 0 }];

const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "doodad-snap");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  writeFileSync(join(dir, "map", "war3map.w3d.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [],
    custom: DOODADS.map(([id, base, name]) => ({ base, id, mods: mods("dptx", name) })) }, null, 2));
  writeFileSync(join(dir, "map", "war3map.w3b.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [],
    custom: DESTRUCTABLES.map(([id, base, name, fixedRot]) => ({ base, id,
      mods: [...mods("bptx", name), ...(fixedRot === undefined ? [] : [{ field: "bfxr", type: "int", value: fixedRot, level: 0, data: 0 }])] })) }, null, 2));

  if (tex4) {
    mkdirSync(join(dir, "map", "Custom"), { recursive: true });
    for (const [name, rows] of Object.entries(TEXTURES)) writeFileSync(join(dir, "map", "Custom", `${name}.tga`), tga(rows));
  }
  const file = join(dir, "map", "war3map.doo.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const f32 = Math.fround;
  const put = (id, i, row, angle) => doc.doodads.push({
    id, variation: 0, position: [-1500 + i * 300 + 13.5, row + 21.25, 0], angle: f32(angle), scale: [1, 1, 1], skinId: id,
    preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [doc.doodads.length, 0, 0], extras: [] });
  DOODADS.forEach(([id], i) => { put(id, i, 500, 0.4); put(id, i, -500, 1.2); });
  DESTRUCTABLES.forEach(([id], i) => { put(id, i, 1000, 0.4); put(id, i, -1000, 2.9); });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  run("pack", dir, "-o", join(here, colours ? "doodad-snap-custom-col.w3x" : tex4 ? "doodad-snap-custom-tex.w3x" : more ? "doodad-snap-custom-more.w3x" : "doodad-snap-custom.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
