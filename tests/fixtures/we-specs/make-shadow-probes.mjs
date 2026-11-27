// Makes the maps for measuring the World Editor's Calculate Shadows cell by cell (war3map.shd), from flat.w3x (the
// editor's own new 64x64 Lordaeron Summer map, level 2, height 0 everywhere):
//
//   node tests/fixtures/we-specs/make-shadow-probes.mjs <w3proj cli> <game folder> [out folder] [name]
//
// The out folder is this one by default (shadow-terrain.w3x is the input of tests/we-compare/shadow-terrain.json).
//
// shadow-terrain.w3x: shapes made of corner heights and cliff levels, apart enough that their shadows don't meet
//   (corner coordinates, x east, y north; heights in world units):
//   soft step  corners x 6..14, y 6..16 raised 128 (ground height, no cliff: a 45° bank one tile wide round it)
//   cliff +1   corners x 22..30, y 6..16 one level up (Grass Cliff), as plateau.w3x
//   cliff +2   corners x 40..48, y 6..16 two levels up
//   corners    single corners raised 128 at (8,30), 256 at (22,30), 512 at (40,28)
//   ridges     y = 46, x 4..18 raised 256; x = 30, y 40..56 raised 256
//   low step   corners x 44..52, y 40..50 raised 64 (a 26.6° bank: no self-shadow at a 30° sun)
// shadow-slopes.w3x (input of tests/we-compare/shadow-terrain.json's shadow-slopes):
//   slopes     four planes facing north (corners y 2..6, 5 tiles wide at x 2, 13, 24, 35), 0 on their north edge,
//              rising a = 106.25, 106.5, 106.75, 107 a tile toward the south: a walk toward the sun climbs a / 4 a step
//              (26.56, 26.63, 26.69, 26.75): lit or dark by the walk's rise (shadows.ts shadowStepRise, 80/3)
//   wet slopes the 106.5 and 106.75 planes again at x 46 and 56, under water 250 high (flag 4)
//   tall       the corner (6, 22) raised 1000: a shadow 33 cells long (the walk goes past 16 steps; no cell of it is
//              exactly 80/3 a step up, where 1536 gave four the editor leaves lit, against the 128 bank's dark ones)
// shadow-ramps.w3x: a plateau one level up (corners x 24..38, y 30..40, Grass Cliff) with a ramp on each face, three
//   corners wide: the high corner and the two below it flagged (as the editor's Ramp), columns 30..32 down the south
//   (rows 30, 29, 28) and north (40, 41, 42) faces, rows 34..36 down the west (24, 23, 22) and east (38, 39, 40) ones
//   (not committed: 7 cells of the ramps' shadows aren't Studio's yet)
// shadow-cliffvar.w3x (input of tests/we-compare/shadow-terrain.json's shadow-cliffvar): see `cliffvar`
// shadow-rocks.w3x: doodads on flat ground, see DOODAD_MAPS (not committed).
// shadow-defscale.w3x (input of tests/we-compare/shadow-defscale.json): doodads with a defScale:hd, see DOODAD_MAPS.
// de-ruins.w3x (input of tests/we-compare/de-ruins.json): doodads only the 3.0 art layer has, see DOODAD_MAPS.
// shadow-boxes.w3x: box models imported into the map (war3mapImported\box-<name>.mdx, Classic MDX made with the app's
//   toClassicMdx), custom doodads D000.. of LRrk using them, see BOXES (not committed: 8 of the editor's 235 cells,
//   on projected triangles' edges, aren't Studio's).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game, outArg] = process.argv.slice(2, 5).map((p) => (p ? resolve(p) : p));
const outDir = outArg || here;
const only = process.argv[5];
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-shadow-probes.mjs <w3proj cli> <game folder> [out folder] [name]"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
const inBox = (x, y, x0, x1, y0, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
/** Ground height (world units, over the cliff level) of a corner. */
function height(x, y) {
  if (inBox(x, y, 6, 14, 6, 16)) return 128;
  if (x === 8 && y === 30) return 128;
  if (x === 22 && y === 30) return 256;
  if (x === 40 && y === 28) return 512;
  if (y === 46 && x >= 4 && x <= 18) return 256;
  if (x === 30 && y >= 40 && y <= 56) return 256;
  if (inBox(x, y, 44, 52, 40, 50)) return 64;
  return 0;
}
/** Cliff level of a corner (2: the ground of flat.w3x). */
function level(x, y) {
  if (inBox(x, y, 22, 30, 6, 16)) return 3;
  if (inBox(x, y, 40, 48, 6, 16)) return 4;
  return 2;
}
/** Whether a corner belongs to a tile with corners on two levels (of `levelOf`). */
const onCliffOf = (levelOf) => (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
  const tx = x + dx, ty = y + dy;
  if (tx < 0 || ty < 0 || tx >= N - 1 || ty >= N - 1) return false;
  const q = [levelOf(tx, ty), levelOf(tx + 1, ty), levelOf(tx, ty + 1), levelOf(tx + 1, ty + 1)];
  return q.some((l) => l !== q[0]);
});
const onCliff = onCliffOf(level);
/** A section's rows as the text keeps them: the top row (y = 64) first. */
const rows = (f, sep = "") => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(sep));

/** shadow-slopes.w3x and shadow-ramps.w3x: see the top. */
const SLOPES = [[2, 106.25], [13, 106.5], [24, 106.75], [35, 107], [46, 106.5, true], [56, 106.75, true]];
const slopeAt = (x, y) => SLOPES.find(([x0]) => x >= x0 && x <= x0 + 5 && y >= 2 && y <= 6);
const slopes = {
  height(x, y) {
    const s = slopeAt(x, y);
    if (s) return s[1] * (6 - y);
    if (x === 6 && y === 22) return 1000;
    return 0;
  },
  wet: (x, y) => !!slopeAt(x, y)?.[2],
};
const plateau = (x, y) => inBox(x, y, 24, 38, 30, 40);
const ramps = {
  level: (x, y) => (plateau(x, y) ? 3 : 2),
  ramp: (x, y) => (inBox(x, y, 30, 32, 28, 30) || inBox(x, y, 30, 32, 40, 42) || inBox(x, y, 22, 24, 34, 36) || inBox(x, y, 38, 40, 34, 36)),
};
const rampsOnCliff = onCliffOf(ramps.level);

/** shadow-cliffvar.w3x: two plateaus one level up, cliff variation 3 on every corner of the west one (x 12..30), 1 on
 *  the east one's (x 36..54), y 12..50: the shadow models of the east and south faces (BAAB, BBAA) have two variations. */
const cliffvar = {
  level: (x, y) => (inBox(x, y, 12, 30, 12, 50) || inBox(x, y, 36, 54, 12, 50) ? 3 : 2),
  variation: (x) => (x <= 33 ? 3 : 1),
};
const cliffvarOnCliff = onCliffOf(cliffvar.level);
/** de-ruins.w3x's plateau: corners x 44..56, y 4..14 one level up (Grass Cliff), away from its doodads and their shadows,
 *  so its minimap has a cliff's colour as well as the ground's. */
const deRuinsLevel = (x, y) => (inBox(x, y, 44, 56, 4, 14) ? 3 : 2);
const deRuinsOnCliff = onCliffOf(deRuinsLevel);

/** Doodad maps: each spot a doodad type, position (world), angle (degrees), variation, scale. */
const DOODAD_MAPS = {
  // LRrk (Lordaeron rock) at variation 0..9, angle 270, one every 8 tiles; then variation 0 at angles 0..315 by 45;
  // then variation 0 at angle 270 moved 4 units more east (and north) each, eight steps (the editor's save puts these
  // back on the 32 grid: it snaps doodads it opens).
  "shadow-rocks": () => {
    const spots = [];
    for (let v = 0; v < 10; v++) spots.push({ id: "LRrk", x: -3584 + (v % 5) * 1536, y: 2560 - Math.floor(v / 5) * 1024, angle: 270, variation: v });
    for (let a = 0; a < 8; a++) spots.push({ id: "LRrk", x: -3584 + (a % 4) * 2048, y: 512 - Math.floor(a / 4) * 1024, angle: a * 45, variation: 0 });
    for (let k = 0; k < 8; k++) spots.push({ id: "LRrk", x: -3584 + (k % 4) * 2048 + k * 4, y: -1536 - Math.floor(k / 4) * 1024 + k * 4, angle: 270, variation: 0 });
    return spots;
  },
  // Doodads whose DoodadSkins.txt has a defScale:hd (the HD view draws them that much larger, objects.ts
  // doodadModelScale): RuinFountain ZOfo 1.45, BOth 1.35, NSct 1.5, and LRrk (none) as the control; angle 270,
  // variation 0, 3072 apart (tests/we-compare/shadow-defscale.json). Left out, as they differ by more than the scale
  // (branch we-compare-9): the cage LOce 0.75 (29 cells against the editor's 36), RibBones LOrb 1.75 (8 against 10),
  // DSah 1.4 (2 cells of 234).
  "shadow-defscale": () => ["ZOfo", "BOth", "NSct", "LRrk"].map((id, i) => (
    { id, x: -3072 + (i % 2) * 4096, y: 2048 - Math.floor(i / 2) * 3072, angle: 270, variation: 0 })),
  // Doodads whose plain DoodadSkins.txt defScale isn't 1: the Barrens spires BRsp 0.36 (no defScale:hd), BOth 0.95
  // (defScale:hd 1.35), with LRrk and NSct (1) as controls; as shadow-defscale (tests/we-compare/shadow-defscale.json's
  // -sd and -hd-plain specs). Measured too (branch we-compare-11, a 3 x 3 grid with ZOfo 0.9, the cauldron LOca 1.2,
  // the tavern sign YOta 1.4, the cage LOce and RibBones LOrb), left out as they differ for other reasons: SD ZOfo 84
  // cells against Studio's 78, YOta 4 against 1, LOce 31 against 30, LOrb 42 against 6; LOca and YOta (off the grid)
  // shade as many cells as Studio's in HD, partly other ones.
  "shadow-defscale-sd": () => ["BRsp", "BOth", "NSct", "LRrk"].map((id, i) => (
    { id, x: -3072 + (i % 2) * 4096, y: 2048 - Math.floor(i / 2) * 3072, angle: 270, variation: 0 })),
  // Doodads whose model is stored under _DE.w3mod only, which the editor's DE mode (we-drive --mode de) draws: the ruins'
  // exterior wall EW00, tower ET00 and main tower EMt0, with LRrk as the control; as shadow-defscale, plus a plateau (deRuinsLevel)
  // for the minimap's cliff colour (tests/we-compare/de-ruins.json).
  "de-ruins": () => ["EW00", "ET00", "EMt0", "LRrk"].map((id, i) => (
    { id, x: -3072 + (i % 2) * 4096, y: 2048 - Math.floor(i / 2) * 3072, angle: 270, variation: 0 })),
  // One box each (BOXES, D000..D007 in that order) at angle 0, four a row 2048 apart; then the closed box at 30 and 45.
  "shadow-boxes": () => [
    ...Object.keys(BOXES).map((_, i) => ({ id: `D00${i}`, x: -3072 + (i % 4) * 2048, y: 2048 - Math.floor(i / 4) * 2048, angle: 0, variation: 0 })),
    { id: "D000", x: -3072, y: -2048, angle: 30, variation: 0 }, { id: "D000", x: -1024, y: -2048, angle: 45, variation: 0 },
  ],
};

/** shadow-boxes.w3x's models: boxes 112 wide (x, y -56..56), z from z0 to z1, the sides named (top, bottom, south,
 *  north, west, east), each counter-clockwise seen from outside, or the other way round (`flip`). */
const ALL_SIDES = ["top", "bottom", "south", "north", "west", "east"];
const BOXES = {
  closed: { z: [0, 96], sides: ALL_SIDES },
  cap: { z: [0, 96], sides: ALL_SIDES.filter((s) => s !== "bottom") },
  inward: { z: [0, 96], sides: ALL_SIDES, flip: true },
  sunk: { z: [-32, 64], sides: ALL_SIDES },
  float: { z: [32, 128], sides: ALL_SIDES },
  topup: { z: [0, 96], sides: ["top"] },
  topdown: { z: [0, 96], sides: ["top"], flip: true },
  tall: { z: [0, 320], sides: ALL_SIDES, half: 24 },
};

/** A box of BOXES as Classic MDX: one geoset of quads, opaque, on the Lordaeron rock's texture, one bone. */
function boxModel({ z: [z0, z1], sides, flip = false, half = 56 }, toClassicMdx) {
  const [a, b] = [-half, half];
  const quads = {
    top: [[a, a, z1], [b, a, z1], [b, b, z1], [a, b, z1]],
    bottom: [[a, a, z0], [a, b, z0], [b, b, z0], [b, a, z0]],
    south: [[a, a, z0], [b, a, z0], [b, a, z1], [a, a, z1]],
    north: [[b, b, z0], [a, b, z0], [a, b, z1], [b, b, z1]],
    west: [[a, b, z0], [a, a, z0], [a, a, z1], [a, b, z1]],
    east: [[b, a, z0], [b, b, z0], [b, b, z1], [b, a, z1]],
  };
  const positions = [], normals = [], uvs = [], faces = [];
  for (const side of sides) {
    const q = quads[side], base = positions.length / 3;
    const e1 = q[1].map((v, k) => v - q[0][k]), e2 = q[2].map((v, k) => v - q[0][k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n);
    q.forEach((p, i) => { positions.push(...p); normals.push(...n.map((v) => ((flip ? -v : v) / len))); uvs.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0); });
    faces.push(...(flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]).map((i) => base + i));
  }
  const extent = { radius: Math.hypot(half, half, z1), min: [a, a, z0], max: [b, b, z1] };
  return toClassicMdx({
    version: 800, name: "box", extent, sequences: [{ name: "Stand", start: 0, end: 1000, moveSpeed: 0, flags: 0, rarity: 0, extent }],
    globalSequences: [], textures: [{ replaceableId: 0, path: "Textures\\LordsRockwall.blp", flags: 0 }], textureAnims: [], geosetAnims: [],
    materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode: 0, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 }] }],
    geosets: [{ positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), faces: new Uint16Array(faces),
      vertexGroups: new Uint8Array(positions.length / 3), groups: [[0]], materialId: 0, lod: 0, lodName: "", extent }],
    nodes: [{ name: "Base0", objectId: 0, parentId: -1, flags: 256, kind: "bone" }], pivots: new Float32Array(3),
    particleEmitters2: [], ribbons: [], skipped: [], warnings: [],
  }, (i) => (i === 0 ? "Textures\\LordsRockwall.blp" : null));
}

/** The app's toClassicMdx, bundled for Node. */
async function loadClassic(scratch) {
  const { build } = createRequire(join(here, "../../../app/package.json"))("esbuild");
  const bundle = join(scratch, "classic.mjs");
  await build({ entryPoints: [join(here, "../../../app/src/lib/model/classic.ts")], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
  return (await import(pathToFileURL(bundle).href)).toClassicMdx;
}

function patchW3e(dir, terrain) {
  const w3e = join(dir, "map", "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const byMap = {
    "shadow-terrain": () => ({
      height: rows((x, y) => height(x, y) * 4, " "),
      layer: rows((x, y) => String(level(x, y))),
      "cliff-texture": rows((x, y) => (onCliff(x, y) ? "1" : "f")),
    }),
    "shadow-slopes": () => ({
      height: rows((x, y) => slopes.height(x, y) * 4, " "),
      // The water's level as the text keeps it (world units × 4), where a corner is wet.
      water: rows((x, y) => (slopes.wet(x, y) ? 1000 : 0), " "),
      flags: rows((x, y) => (slopes.wet(x, y) ? "4" : "0")),
    }),
    "shadow-ramps": () => ({
      layer: rows((x, y) => String(ramps.level(x, y))),
      "cliff-texture": rows((x, y) => (rampsOnCliff(x, y) || ramps.ramp(x, y) ? "1" : "f")),
      flags: rows((x, y) => (ramps.ramp(x, y) ? "1" : "0")),
    }),
    "shadow-cliffvar": () => ({
      layer: rows((x, y) => String(cliffvar.level(x, y))),
      "cliff-texture": rows((x, y) => (cliffvarOnCliff(x, y) ? "1" : "f")),
      "cliff-variation": rows((x) => String(cliffvar.variation(x))),
    }),
    "de-ruins": () => ({
      layer: rows((x, y) => String(deRuinsLevel(x, y))),
      "cliff-texture": rows((x, y) => (deRuinsOnCliff(x, y) ? "1" : "f")),
    }),
  };
  const sections = byMap[terrain]?.() ?? {};
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[i]);
    if (m && m[1] in sections) {
      out.push(`[${m[1]}]`, ...sections[m[1]]);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    out.push(lines[i]);
  }
  writeFileSync(w3e, out.join("\n"));
}

const maps = { "shadow-terrain": null, "shadow-slopes": null, "shadow-ramps": null, "shadow-cliffvar": null, ...DOODAD_MAPS };
if (only && !(only in maps)) { console.error(`unknown map ${only} (${Object.keys(maps).join(", ")})`); process.exit(2); }
for (const [name, spotsOf] of Object.entries(maps)) {
  if (only && only !== name) continue;
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    patchW3e(dir, name);
    if (spotsOf) {
      const doo = join(dir, "map", "war3map.doo.json");
      const json = JSON.parse(readFileSync(doo, "utf8"));
      spotsOf().forEach(({ id, x, y, angle, variation, scale = 1 }, n) => {
        json.doodads.push({ id, variation, position: [x, y, 0], angle: (angle * Math.PI) / 180, scale: [scale, scale, scale], skinId: id, preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [n & 255, (n >> 8) & 255, 0], extras: [] });
      });
      writeFileSync(doo, JSON.stringify(json, null, 2));
    }
    if (name === "shadow-boxes") {
      const toClassicMdx = await loadClassic(scratch);
      mkdirSync(join(dir, "map", "war3mapImported"), { recursive: true });
      const custom = Object.entries(BOXES).map(([box, spec], i) => {
        writeFileSync(join(dir, "map", "war3mapImported", `box-${box}.mdx`), boxModel(spec, toClassicMdx));
        return { base: "LRrk", id: `D00${i}`, mods: [
          { field: "dfil", type: "string", level: 0, data: 0, value: `war3mapImported\\box-${box}.mdx` },
          { field: "dvar", type: "int", level: 0, data: 0, value: 1 },
        ] };
      });
      writeFileSync(join(dir, "map", "war3map.w3d.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom }, null, 2));
    }
    run("pack", "--keep-objects", dir, "-o", join(outDir, `${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
