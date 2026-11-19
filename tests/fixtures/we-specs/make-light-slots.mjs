// Makes the maps for checking which of war3map.w3l's two lighting models lights what (lighting.ts ownLightFile), on a
// second map beside cliff.w3m (branch we-compare-10):
//
//   node tests/fixtures/we-specs/make-light-slots.mjs <w3proj cli> <game folder> <out folder>
//
// <out>/light-slots-<variant>.w3x: flat.w3x on the Barrens tileset (its first six ground tiles, two cliff types), three
// footmen of player 1, three Barrens rocks (BRrk) and three Barrens trees (BTtw) on the flat ground round the centre,
// and two lighting models of the map's own, each with one static sun and ambient colour: slot 1 (the codec's
// terrainModel) green 0.1, 0.9, 0.2, slot 2 (unitModel) magenta 0.9, 0.15, 0.8 (MDL colours are stored b, g, r).
// Variants: both (both slots on), first (only slot 1 on), second (only slot 2 on), none (both off: the game's Barrens
// lights, whose terrain and unit models differ).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game, out] = process.argv.slice(2, 5).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!out) { console.error("usage: make-light-slots.mjs <w3proj cli> <game folder> <out folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8", env: { ...process.env, W3PROJ_GAME: game } });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
};
const table = (file, cols) => run("game", "slk", file, "--col", cols).trim().split("\n").slice(1).map((l) => l.split("\t"));
const TILESET = "B";
const ground = table("TerrainArt/Terrain.slk", "tileID").map(([id]) => id).filter((id) => id.startsWith(TILESET)).slice(0, 6);
const cliffs = table("TerrainArt/CliffTypes.slk", "cliffID,groundTile").filter(([, g]) => g.startsWith(TILESET)).slice(0, 2).map(([id]) => id);

const SLOT1 = "11111111-1111-4111-8111-111111111111.mdl", SLOT2 = "22222222-2222-4222-8222-222222222222.mdl";
/** A day and night lighting model whose sun and ambient light are one colour all day (r, g, b; written b, g, r). */
const lightMdl = (name, [r, g, b]) => `Version {
\tFormatVersion 800,
}
Model "${name}" {
\tNumLights 1,
\tBlendTime 150,
}
Sequences 1 {
\tAnim "Stand" {
\t\tInterval { 333, 60333 },
\t}
}
GlobalSequences 1 {
\tDuration 0,
}
Light "FDirectSun" {
\tDirectional,
\tstatic AttenuationStart 80,
\tstatic AttenuationEnd 200,
\tstatic Intensity 1,
\tstatic Color { ${b}, ${g}, ${r} },
\tstatic AmbIntensity 0.3,
\tstatic AmbColor { ${b}, ${g}, ${r} },
\tRotation 2 {
\t\tDontInterp,
\t\tGlobalSeqId 0,
\t\t333: { 0.381539, -0.215864, -0.442587, 0.782271 },
\t\t17235: { -0.477628, -0.225547, 0, 0.849117 },
\t}
}
PivotPoints 1 {
\t{ 0, 0, 400 },
}
`;

mkdirSync(out, { recursive: true });
for (const [variant, first, second] of [["both", 1, 1], ["first", 1, 0], ["second", 0, 1], ["none", 0, 0]]) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir);
    const m = (f) => join(dir, "map", f);
    const info = JSON.parse(readFileSync(m("war3map.w3i.json"), "utf8"));
    info.tileset = TILESET;
    writeFileSync(m("war3map.w3i.json"), JSON.stringify(info));
    const lines = readFileSync(m("war3map.w3e.txt"), "utf8").split("\n");
    const set = (prefix, to) => {
      const at = lines.findIndex((l) => l.startsWith(prefix));
      if (at < 0) throw new Error(`no "${prefix}" line in the w3e text`);
      lines[at] = to;
    };
    set("tileset ", `tileset ${TILESET}`);
    set("custom-tilesets ", "custom-tilesets 1");
    set("ground ", `ground ${ground.join(" ")}`);
    set("cliffs ", `cliffs ${cliffs.join(" ")}`);
    writeFileSync(m("war3map.w3e.txt"), lines.join("\n"));

    const units = JSON.parse(readFileSync(m("war3mapUnits.doo.json"), "utf8"));
    const template = units.units[0];
    [[-384, 256], [-256, 384], [-128, 256]].forEach(([x, y], i) =>
      units.units.push({ ...template, id: "hfoo", skinId: "hfoo", position: [x, y, 0], angle: 4.712389, player: 0, editorId: i + 1, trailer: [0, 0] }));
    writeFileSync(m("war3mapUnits.doo.json"), JSON.stringify(units, null, 2));
    const doo = JSON.parse(readFileSync(m("war3map.doo.json"), "utf8"));
    [["BRrk", 256, 256], ["BRrk", 512, 256], ["BRrk", 384, 512], ["BTtw", 256, -512], ["BTtw", 384, -512], ["BTtw", 512, -512]].forEach(([id, x, y], n) =>
      doo.doodads.push({ id, variation: 0, position: [x, y, 0], angle: 4.712389, scale: [1, 1, 1], skinId: id, preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: n, trailer: [n, 0, 0], extras: [] }));
    writeFileSync(m("war3map.doo.json"), JSON.stringify(doo, null, 2));

    writeFileSync(m(SLOT1), lightMdl("SlotOneGreen", [0.1, 0.9, 0.2]));
    writeFileSync(m(SLOT2), lightMdl("SlotTwoMagenta", [0.9, 0.15, 0.8]));
    writeFileSync(m("war3map.imp.json"), JSON.stringify({ format: "w3proj.imports/1", version: 1, files: [{ flags: 29, path: SLOT1 }, { flags: 29, path: SLOT2 }] }, null, 2));
    const w3l = JSON.parse(readFileSync(m("war3map.w3l.json"), "utf8"));
    Object.assign(w3l, { terrainModel: SLOT1, unitModel: SLOT2, terrainEnabled: first, unitEnabled: second });
    writeFileSync(m("war3map.w3l.json"), JSON.stringify(w3l, null, 2));
    run("pack", dir, "-o", join(out, `light-slots-${variant}.w3x`), "--force-stale");
    console.log(`${variant}: slot 1 ${first ? "on" : "off"}, slot 2 ${second ? "on" : "off"} (${ground.join(" ")} / ${cliffs.join(" ")})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
