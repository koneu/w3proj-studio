// Makes the maps for measuring where the World Editor leaves out a start location's town hall preview (the
// see-through building inside the ring; terrain-viewer/startpreview.ts `startPreviewHidden`), from flat.w3x (the
// World Editor's own new 64x64 Lordaeron Summer map, level 2, height 0, one Human start):
//
//   node tests/fixtures/we-specs/make-start-preview.mjs <w3proj cli> <game folder> [--out DIR] [--map NAME]... [--allow-stale]
//
// Each map holds up to 24 spots, one start location each (players 0..23, all Human, so every preview is a Town Hall,
// whose footprint is 4x4 tiles: corners -2..2 around it), on a 6 x 4 grid of corners x 12 20 28 36 44 52, y 20 28 36 44
// (world (corner - 32) * 128); spot k is column k % 6, row floor(k / 6), from the south-west. What each spot holds is
// in MAPS below. Written as start-preview-<name>.w3x into <repo>/target/start-preview/ (or DIR).
//
// A null spot is left empty (map mine); the starts' players are numbered in spot order, so a player's colour names it.
//
// Looking at them: node scripts/we-drive.mjs --looks-every-map --map <map> --wait-ready, then per LOOKS entry --look it
// and --shot (in app/; at most 16 looks a run). Findings (2026-11-25, SD, software renderer): the editor leaves the
// preview out exactly where its melee save calls the start invalid (meleesave.ts START_SQUARE, MINE_CLEARANCE): water of
// any depth in the square, Lrok, a cliff, a tree, rock doodad, pathing blocker or special in it, a gold mine nearer than
// 750; kept: dry ground, a plateau, a cliff, Lrok or water from 384 away, a tree 384 away, blight, a farm on the start; the
// stored war3map.wpm (map wpm) changes nothing. Map overlap (2026-11-25): another start 488 east or north hid both
// previews, 496, 504 and 512 kept both; a footman on a start kept it, with the nearest mine 900 away or none near.
//
// A spot's fields (dx, dy: offsets in corners from its corner; corners within 3 of it make its "pool"):
//   depth    water over the whole pool (flag 4), the surface this deep over the ground (world units); the w3e text holds
//            levels in quarters, so a depth is n / 4 - 89.6 (51.9, 52.15, ...)
//   waterFrom  with depth: only the pool's corners with dx >= this get the water
//   layer    { from, value }: the pool's corners with dx >= from on this cliff level (2 is the ground's); cliff corners get
//            Grass Cliff
//   texture  { at: "pool" | "start", value }: the ground tile index (3 is Lrok, the unbuildable rock) on the pool or the
//            start's corner only
//   flags    bits on the pool's corners (2 blight)
//   doodads  [[id, dx, dy]] (world units from the start)
//   units    [[id, dx, dy, player]] (player 24 Neutral Hostile, 27 Neutral Passive)
//   starts   [[dx, dy]]: more start locations (world units from the spot's), each a player of its own after the spots'
//   special  a special doodad (war3map.doo's second list) on the start's tile
//   wpm      { value, size }: the stored war3map.wpm's cells within size cells (4 a tile) of the start set to value after
//            the pathing map is made again (w3proj rebuild), to see whether the editor reads the stored one
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
const usage = "usage: make-start-preview.mjs <w3proj cli> <game folder> [--out DIR] [--map NAME]... [--allow-stale]";
if (!game) { console.error(usage); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
let out = resolve(here, "..", "..", "..", "target", "start-preview");
const only = [];
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out" && argv[i + 1] !== undefined) out = resolve(argv[++i]);
  else if (argv[i] === "--map" && argv[i + 1] !== undefined) only.push(argv[++i]);
  else if (argv[i] !== "--allow-stale") { console.error(`${usage}\nunknown argument ${argv[i]}`); process.exit(2); }
}

export const COLUMNS = [12, 20, 28, 36, 44, 52], ROWS = [20, 28, 36, 44];
/** The spot k's corner. */
export const spotCorner = (k) => [COLUMNS[k % 6], ROWS[Math.floor(k / 6)]];
/** The we-drive --look cameras of the 2026-11-25 pictures: aimed at corner x 20, 36, 52 and y 24 (rows 20, 28) or 40
 *  (rows 36, 44); each shows three columns of two rows (the westmost column cut at x 12). */
export const LOOKS = ["-1536,-1024,2400", "512,-1024,2400", "2560,-1024,2400", "-1536,1024,2400", "512,1024,2400", "2560,1024,2400"];

const depths = [null, -10, 0.15, 1.15, 5.15, 10.15, 15.15, 20.15, 25.15, 30.15, 35.15, 40.15, 45.15, 48.15, 50.15, 51.15, 51.65, 51.9,
  52.15, 52.4, 53.15, 55.15, 70.15, 100.15];

export const MAPS = {
  // the depth at which the preview goes: a dry control, water below the ground (flag on), then deeper and deeper
  depth: depths.map((d) => (d === null ? { label: "dry" } : { label: `depth ${d}`, depth: d })),
  // other ground a Town Hall can't be built on
  ground: [
    { label: "dry" },
    { label: "Lrok pool", texture: { at: "pool", value: 3 } },
    { label: "Lrok start corner", texture: { at: "start", value: 3 } },
    { label: "cliff dx>=1", layer: { from: 1, value: 3 } },
    { label: "plateau", layer: { from: -3, value: 3 } },
    { label: "cliff dx>=3", layer: { from: 3, value: 3 } },
    { label: "tree on start", doodads: [["LTlt", 0, 0]] },
    { label: "tree +192", doodads: [["LTlt", 192, 0]] },
    { label: "tree +384", doodads: [["LTlt", 384, 0]] },
    { label: "rock doodad LOrh", doodads: [["LOrh", 0, 0]] },
    { label: "pathing blocker YTpc", doodads: [["YTpc", 0, 0]] },
    { label: "special YCc1", special: "YCc1" },
    { label: "farm hhou (neutral)", units: [["hhou", 0, 0, 24]] },
    { label: "gold mine on start", units: [["ngol", 0, 0, 27]] },
    { label: "gold mine +448", units: [["ngol", 448, 0, 27]] },
    { label: "footman on start", units: [["hfoo", 0, 0, 24]] },
    { label: "blight", flags: 2 },
    { label: "water 30 dx>=1", depth: 30.15, waterFrom: 1 },
    { label: "water 30 dx>=3", depth: 30.15, waterFrom: 3 },
    { label: "water 30 dx>=2", depth: 30.15, waterFrom: 2 },
    { label: "tree +256", doodads: [["LTlt", 256, 0]] },
    { label: "Lrok dx>=2", texture: { at: "from2", value: 3 } },
    { label: "cliff dx>=2", layer: { from: 2, value: 3 } },
    { label: "pathing blocker YTpb +192", doodads: [["YTpb", 192, 0]] },
  ],
  // the stored pathing map against the ground: dry ground marked unbuildable (and unwalkable), shallow and deep water
  // marked plain buildable land, and their controls as rebuilt
  wpm: [
    { label: "dry" },
    { label: "dry, wpm no build", wpm: { value: 0x08 | 0x40, size: 12 } },
    { label: "dry, wpm blocked", wpm: { value: 0x02 | 0x08 | 0x40 | 0x80, size: 12 } },
    { label: "water 30" , depth: 30.15 },
    { label: "water 30, wpm land", depth: 30.15, wpm: { value: 0x40, size: 16 } },
    { label: "water 100", depth: 100.15 },
    { label: "water 100, wpm land", depth: 100.15, wpm: { value: 0x40, size: 16 } },
    { label: "Lrok pool, wpm land", texture: { at: "pool", value: 3 }, wpm: { value: 0x40, size: 16 } },
  ],
  // a gold mine east of (or diagonal to) the start at the distances around the melee save's 750 (meleesave.ts
  // MINE_CLEARANCE); every other column is empty, so a mine is never within 1000 of another start
  mine: [0, 256, 512, 640, 700, 740, 749, 750, 760, 800, [528, 528], [531, 531]].flatMap((d) => {
    const [dx, dy] = Array.isArray(d) ? d : [d, 0];
    return [{ label: `mine ${Array.isArray(d) ? d.join(",") : d}`, units: [["ngol", dx, dy, 27]] }, null];
  }),
  // another start this far east (or north) of the spot's, around the melee save's overlap rule (meleesave.ts START_SQUARE:
  // 488 invalid, 496 not); and a footman on a start with the nearest mine 900 away (beyond MINE_CLEARANCE), its control
  // without the footman, and a footman with no mine near. Every other column is empty.
  overlap: [
    { label: "start +488", starts: [[488, 0]] }, null,
    { label: "start +496", starts: [[496, 0]] }, null,
    { label: "start +504", starts: [[504, 0]] }, null,
    { label: "start +512", starts: [[512, 0]] }, null,
    { label: "start north +488", starts: [[0, 488]] }, null,
    { label: "start north +496", starts: [[0, 496]] }, null,
    { label: "footman on start, mine +900", units: [["hfoo", 0, 0, 24], ["ngol", 900, 0, 27]] }, null,
    { label: "mine +900", units: [["ngol", 900, 0, 27]] }, null,
    { label: "footman on start", units: [["hfoo", 0, 0, 24]] }, null,
  ],
};

const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";
const WATER_OFFSET = 89.6;

/** The spot whose pool holds corner (x, y), and the offsets to its corner. */
function poolOf(spots, x, y) {
  for (let k = 0; k < spots.length; k++) {
    const [cx, cy] = spotCorner(k), dx = x - cx, dy = y - cy;
    if (spots[k] && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return { s: spots[k], dx, dy };
  }
  return null;
}

function corner(spots, x, y) {
  const c = { layer: 2, flags: 0, texture: 0, water: 0, height: 0 };
  const p = poolOf(spots, x, y);
  if (!p) return c;
  const { s, dx, dy } = p;
  if (s.depth !== undefined && dx >= (s.waterFrom ?? -3)) {
    c.flags |= 4;
    c.water = Math.round((WATER_OFFSET + s.depth) * 4);
  }
  if (s.layer && dx >= s.layer.from) c.layer = s.layer.value;
  if (s.texture?.at === "pool" || (s.texture?.at === "start" && dx === 0 && dy === 0) || (s.texture?.at === "from2" && dx >= 2)) c.texture = s.texture.value;
  if (s.flags) c.flags |= s.flags;
  return c;
}

function editTerrain(file, spots) {
  const grid = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => corner(spots, x, y)));
  const at = (x, y) => grid[Math.max(0, Math.min(N - 1, y))][Math.max(0, Math.min(N - 1, x))];
  const onCliff = (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
    const tx = x + dx, ty = y + dy;
    const q = [at(tx, ty), at(tx + 1, ty), at(tx, ty + 1), at(tx + 1, ty + 1)].map((c) => c.layer);
    return q.some((l) => l !== q[0]);
  });
  // a section's rows as the text keeps them: the top row (y = 64) first
  const rows = (f) => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)));
  const chars = (f) => rows((x, y) => DIGITS[f(x, y)]).map((r) => r.join(""));
  const nums = (f) => rows(f).map((r) => r.join(" "));
  const sections = {
    height: nums((x, y) => at(x, y).height),
    water: nums((x, y) => at(x, y).water),
    texture: chars((x, y) => at(x, y).texture),
    layer: chars((x, y) => at(x, y).layer),
    flags: chars((x, y) => at(x, y).flags),
    "cliff-texture": chars((x, y) => (onCliff(x, y) ? 1 : 15)),
  };
  const lines = readFileSync(file, "utf8").split("\n");
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[i]);
    if (m && m[1] in sections) {
      result.push(`[${m[1]}]`, ...sections[m[1]]);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    result.push(lines[i]);
  }
  writeFileSync(file, result.join("\n"));
}

/** The stored pathing map's cells around each spot with `wpm` set to its value (rows from the south, as the w3e). */
function editWpm(file, spots) {
  const b = readFileSync(file);
  if (b.toString("latin1", 0, 4) !== "MP3W") throw new Error(`${file}: not a pathing map`);
  const w = b.readUInt32LE(8), h = b.readUInt32LE(12);
  spots.forEach((s, k) => {
    if (!s?.wpm) return;
    const [cx, cy] = spotCorner(k);
    for (let y = cy * 4 - s.wpm.size; y < cy * 4 + s.wpm.size; y++) {
      for (let x = cx * 4 - s.wpm.size; x < cx * 4 + s.wpm.size; x++) if (x >= 0 && y >= 0 && x < w && y < h) b[16 + y * w + x] = s.wpm.value;
    }
  });
  writeFileSync(file, b);
}

function make(name, spots) {
  if (spots.length > 24) throw new Error(`${name}: ${spots.length} spots, 24 at most`);
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-start-preview-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const map = join(dir, "map");
    const unitsFile = join(map, "war3mapUnits.doo.json");
    const units = JSON.parse(readFileSync(unitsFile, "utf8"));
    const start = units.units[0];
    const world = (k) => spotCorner(k).map((c) => (c - 32) * 128);
    const list = [];
    let n = 0;
    // a null spot is empty; the others' starts are players 0, 1, ... in order
    const used = spots.map((s, k) => (s ? k : -1)).filter((k) => k >= 0);
    used.forEach((k, player) => {
      const [x, y] = world(k);
      list.push({ ...start, position: [x, y, 0], player, editorId: n++ });
    });
    // the spots' more start locations, players after the spots' own
    const extra = used.flatMap((k) => (spots[k].starts ?? []).map(([dx, dy]) => [world(k)[0] + dx, world(k)[1] + dy]));
    if (used.length + extra.length > 24) throw new Error(`${name}: ${used.length + extra.length} start locations, 24 at most`);
    extra.forEach(([x, y], i) => list.push({ ...start, position: [x, y, 0], player: used.length + i, editorId: n++ }));
    spots.forEach((s, k) => {
      if (!s) return;
      const [x, y] = world(k);
      for (const [id, dx, dy, player = 24] of s.units ?? []) {
        list.push({
          ...start, id, skinId: id, position: [x + dx, y + dy, 0], angle: 4.712389, player, flags: 2, hp: -1, mana: -1, level: 1,
          gold: id === "ngol" ? 12500 : 0, targetAcquisition: -1, editorId: n++, trailer: [0, 0],
        });
      }
    });
    units.units = list;
    writeFileSync(unitsFile, JSON.stringify(units, null, 2));

    const dooFile = join(map, "war3map.doo.json");
    const doo = JSON.parse(readFileSync(dooFile, "utf8"));
    let d = 0;
    spots.forEach((s, k) => {
      if (!s) return;
      const [x, y] = world(k);
      for (const [id, dx, dy] of s.doodads ?? []) {
        doo.doodads.push({
          id, variation: 0, position: [x + dx, y + dy, 0], angle: 4.712389, scale: [1, 1, 1], skinId: id, preFlags: 4294967295, flags: 2,
          life: 100, itemTable: -1, itemSets: [], editorId: d++, trailer: [0, 0, 0], extras: [],
        });
      }
      if (s.special) {
        const [cx, cy] = spotCorner(k);
        doo.specials = [...(doo.specials ?? []), { id: s.special, z: 0, x: cx, y: cy }];
      }
    });
    writeFileSync(dooFile, JSON.stringify(doo, null, 2));
    editTerrain(join(map, "war3map.w3e.txt"), spots);

    const infoFile = join(map, "war3map.w3i.json");
    const info = JSON.parse(readFileSync(infoFile, "utf8"));
    const like = info.players[0];
    info.players = [...used.map((k) => world(k)), ...extra].map((at, id) => ({ ...like, id, race: 1, controller: 1, name: `Player ${id + 1}`, start: at }));
    writeFileSync(infoFile, JSON.stringify(info, null, 2));
    run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
    if (spots.some((s) => s?.wpm)) editWpm(join(map, "war3map.wpm"), spots);
    mkdirSync(out, { recursive: true });
    const file = join(out, `start-preview-${name}.w3x`);
    run("pack", dir, "-o", file, "--force-stale");
    console.log(`made ${file}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const names = only.length ? only : Object.keys(MAPS);
const unknown = names.find((name) => !Object.hasOwn(MAPS, name));
if (unknown !== undefined) { console.error(`unknown map ${unknown}: ${Object.keys(MAPS).join(", ")}`); process.exit(2); }
for (const name of names) make(name, MAPS[name]);
