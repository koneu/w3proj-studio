// Makes the inputs of the start-location melee specs (tests/we-compare/melee-valid-we.json, examples/start-under-water-w3i.json) from flat.w3x (the World
// Editor's own new 64x64 Lordaeron Summer melee map: one start location at (0, -256), corner (32, 30), flags 0x9c14):
//
//   node tests/fixtures/we-specs/make-melee-valid.mjs <w3proj cli> <game folder> [--out DIR] [--case NAME=JSON]...
//
// Each case is flat.w3x with one thing near the start, written as melee-valid-<name>.w3x into <repo>/target/melee-valid/
// (or DIR; not committed: 24 maps of 35 KB).
// Without --case it makes the CASES below; --case makes others (for measuring), the JSON as a CASES entry:
//   off        true: the w3i's Melee flag cleared (0x9c10), to see whether the editor's save puts it back
//   doodads    [[id, dx, dy]]: doodads or destructables at the start + (dx, dy)
//   units      [[id, dx, dy, player, drops]]: units or items (player 24: Neutral Hostile, the default; 27 is Neutral Passive) at the start + (dx, dy);
//              drops: item ids of one drop set (each 100%)
//   start      [dx, dy]: moves the start location
//   corners    [[x0, y0, x1, y1, { layer, flags, texture, water, height }]]: corners (inclusive, the map's corner
//              indices; the start's is 32, 30) set to these values; cliff corners get Grass Cliff as Apply Cliff leaves it
//   ground     [index, tileId]: the w3e's ground tile at that index of its list replaced
//   customTilesets  true: with `ground`, the w3e's custom tilesets flag set (else the editor reads the tileset's list)
//   flags      bits ored into the w3i's flags (0x4000: Requires The Frozen Throne data)
//   noStart    true: no start location in the units file (a map the World Editor's save gives starts of its own)
//   players    [[id, controller, x, y]]: the w3i's players instead of flat's one (copies of it with that id, controller
//              (1 user, 2 computer, 3 neutral, 4 rescuable) and start); [] leaves the w3i without players
// The pathing map, shadows and minimap are made again (w3proj rebuild), as the editor makes its own on open.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-melee-valid.mjs <w3proj cli> <game folder> [--out DIR] [--case NAME=JSON]..."); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
let out = resolve(here, "..", "..", "..", "target", "melee-valid");
const extra = [];
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") {
    if (argv[i + 1] === undefined) { console.error("--out needs a folder"); process.exit(2); }
    out = resolve(argv[++i]);
  } else if (argv[i] === "--case") {
    // NAME=JSON, the name a plain file-name part (it becomes melee-valid-<name>.w3x inside the out folder)
    const [name, ...json] = (argv[++i] ?? "").split("=");
    let value;
    try { value = JSON.parse(json.join("=")); } catch { /* reported below */ }
    if (!/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name) || value === undefined) { console.error("--case needs NAME=JSON (NAME letters, digits, . _ -)"); process.exit(2); }
    extra.push([name, value]);
  } else if (argv[i] !== "--allow-stale") { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
}

/** The cases of tests/we-compare/melee-valid-we.json: the pairs either side of each threshold measured there. All
 *  with the flag cleared (the editor's save puts it back for a valid start) but the last three. */
const off = (c) => ({ off: true, ...c });
export const CASES = {
  "tree-256": off({ doodads: [["LTlt", 256, 0]] }),
  "tree-320": off({ doodads: [["LTlt", 320, 0]] }),
  "tree-diag-256": off({ doodads: [["LTlt", 256, 256]] }),
  "tree-diag-320": off({ doodads: [["LTlt", 320, 256]] }),
  "mine-749": off({ units: [["ngol", 749, 0]] }),
  "mine-750": off({ units: [["ngol", 750, 0]] }),
  "mine-diag-528": off({ units: [["ngol", 528, 528]] }),
  "mine-diag-530": off({ units: [["ngol", 530.5, 530.5]] }),
  "start-488": off({ units: [["sloc", 488, 0, 1]] }),
  "start-496": off({ units: [["sloc", 496, 0, 1]] }),
  "start-west-496": off({ units: [["sloc", -496, 0, 1]] }),
  "start-west-504": off({ units: [["sloc", -504, 0, 1]] }),
  "rock-34": off({ corners: [[34, 0, 64, 64, { texture: 3 }]] }),
  "rock-35": off({ corners: [[35, 0, 64, 64, { texture: 3 }]] }),
  "cliff-34": off({ corners: [[34, 0, 64, 64, { layer: 3 }]] }),
  "cliff-35": off({ corners: [[35, 0, 64, 64, { layer: 3 }]] }),
  "water-34": off({ corners: [[34, 0, 64, 64, { flags: 4, water: 400 }]] }),
  "water-35": off({ corners: [[35, 0, 64, 64, { flags: 4, water: 400 }]] }),
  "blight-34": off({ corners: [[34, 0, 64, 64, { flags: 2 }]] }),
  "merchant-on-start": off({ units: [["ngme", 0, 0]] }),
  "item-64": off({ units: [["ratc", 64, 0, 27]] }),
  "melee-tree-256": { doodads: [["LTlt", 256, 0]] },
  // tests/we-compare/examples/start-under-water-w3i.json: the start under deep (level 0) or shallow (level 1) water,
  // Melee still on, as Studio's set_water lays it out (water level 0, wet flag); both saves must take Melee off.
  "start-deep": { corners: [[30, 28, 34, 32, { layer: 0, flags: 4 }]] },
  "start-shallow": { corners: [[30, 28, 34, 32, { layer: 1, flags: 4 }]] },
  // tests/we-compare/tft-flag-we.json: w3i flag 0x4000 (Requires The Frozen Throne data). Melee stays on; each thing
  // stands at (1280, 1024), far from the start. The game's tables give each type a version (0, 1 The Frozen Throne,
  // 2 Reforged).
  "tft-tavern": { units: [["ntav", 1280, 1280, 27]] },
  "tft-creep": { units: [["nanb", 1280, 1280]] },
  "tft-unit-v2": { units: [["sfoo", 1280, 1280]] },
  "tft-unit-v0": { units: [["nfrp", 1280, 1280]] },
  "tft-item": { units: [["shas", 1280, 1280, 27]] },
  "tft-dest": { doodads: [["LTbr", 1280, 1280]] },
  "tft-doodad": { doodads: [["ZPfw", 1280, 1280]] },
  // A tile of version 1 (Zdrt) worn by 25 corners, the custom tilesets flag on: left 0x4000 off, but the editor's save
  // set w3i flag 0x0008 (we-drive 2026-11-17). Without the custom tilesets flag the editor reads the tileset's own
  // list, so the tile is gone. tests/we-compare/tileset-flag-we.json: 0x0008 follows the custom tilesets flag alone.
  "tft-tile-custom": { ground: [5, "Zdrt"], customTilesets: true, corners: [[50, 50, 54, 54, { texture: 5 }]] },
  // tileset-flag-we.json: custom tilesets on with the tileset's own list (sets 0x0008), and off with 0x0008 stored (cleared).
  "tileset-custom-own": { ground: [5, "Lgrd"], customTilesets: true },
  "tileset-flag-clear": { flags: 0x0008 },
  "tft-tavern-off": off({ units: [["ntav", 1280, 1280, 27]] }),
  "tft-drop": { units: [["nfrp", 1280, 1280, 24, ["shas"]]] },
  "tft-drop-random": { units: [["nfrp", 1280, 1280, 24, ["YjI5"]]] },
  "tft-clear": { flags: 0x4000 },
  // tests/we-compare/all-starts.json: no start location; the editor's save gives every player of the w3i one at a
  // random valid place. Six players of every controller (1 user, 2 computer, 3 neutral, 4 rescuable, 0); three players
  // where only the first has one; four users on a strip along the west edge (the rest shallow water); six users among a
  // grid of gold mines 1536 apart; a w3i without players (nothing added).
  "ns-mixed": { noStart: true, players: [[0, 1, 0, -256], [1, 2, 1024, 1024], [2, 3, -1024, 1024], [3, 4, 1024, -1024], [5, 0, -1024, -1024], [7, 1, 2048, 0]] },
  "ns-partial": { players: [[0, 1, 0, -256], [1, 1, 1024, 1024], [2, 2, -1024, 1024]] },
  "ns-strip": { noStart: true, players: [0, 1, 2, 3].map((id) => [id, 1, 0, 0]), corners: [[15, 0, 64, 64, { flags: 4, water: 400 }]] },
  "ns-mines": { noStart: true, players: [0, 1, 2, 3, 4, 5].map((id) => [id, 1, 0, 0]),
    units: [-3072, -1536, 0, 1536, 3072].flatMap((x) => [-3072, -1536, 0, 1536, 3072].map((y) => ["ngol", x, y + 256])) }, // at x, y (offsets from the start at 0, -256)
  "ns-none": { noStart: true, players: [] },
};

const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const START = [0, -256];
const N = 65;
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";

function editTerrain(file, rects) {
  const corner = (x, y) => {
    const c = { layer: 2, flags: 0, texture: 0, water: 0, height: 0 };
    for (const [x0, y0, x1, y1, set] of rects) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) Object.assign(c, set);
    return c;
  };
  const grid = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => corner(x, y)));
  const at = (x, y) => grid[Math.max(0, Math.min(N - 1, y))][Math.max(0, Math.min(N - 1, x))];
  /** A corner of a tile with corners on two levels. */
  const onCliff = (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
    const tx = x + dx, ty = y + dy;
    const q = [at(tx, ty), at(tx + 1, ty), at(tx, ty + 1), at(tx + 1, ty + 1)].map((c) => c.layer);
    return q.some((l) => l !== q[0]);
  });
  /** A section's rows as the text keeps them: the top row (y = 64) first. */
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

function make(name, c) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const map = join(dir, "map");
    const unitsFile = join(map, "war3mapUnits.doo.json");
    const units = JSON.parse(readFileSync(unitsFile, "utf8"));
    const start = units.units[0];
    if (c.start) start.position = [START[0] + c.start[0], START[1] + c.start[1], 0];
    // Numbered after the start (0), or from 0 when it goes (noStart): no gap, as in a map the editor saved.
    let n = c.noStart ? 0 : 1;
    for (const [id, dx, dy, player = 24, drops] of c.units ?? []) {
      units.units.push({
        ...start, id, skinId: id, position: [START[0] + dx, START[1] + dy, 0], angle: 0, player, flags: 2,
        hp: -1, mana: -1, level: 1, gold: id === "ngol" ? 12500 : 0, targetAcquisition: -1, editorId: n++, trailer: [0, 0],
        ...(drops ? { itemSets: [drops.map((d) => ({ id: d, chance: 100 }))] } : {}),
      });
    }
    if (c.noStart) units.units = units.units.filter((u) => u.id !== "sloc");
    writeFileSync(unitsFile, JSON.stringify(units, null, 2));
    if (c.doodads?.length) {
      const dooFile = join(map, "war3map.doo.json");
      const doo = JSON.parse(readFileSync(dooFile, "utf8"));
      c.doodads.forEach(([id, dx, dy], i) => doo.doodads.push({
        id, variation: 0, position: [START[0] + dx, START[1] + dy, 0], angle: 4.712389, scale: [1, 1, 1], skinId: id,
        preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: i, trailer: [0, 0, 0], extras: [] }));
      writeFileSync(dooFile, JSON.stringify(doo, null, 2));
    }
    if (c.corners?.length) editTerrain(join(map, "war3map.w3e.txt"), c.corners);
    if (c.ground) {
      const w3e = join(map, "war3map.w3e.txt");
      const lines = readFileSync(w3e, "utf8").split("\n");
      const at = lines.findIndex((l) => l.startsWith("ground "));
      const tiles = lines[at].split(" ").slice(1);
      tiles[c.ground[0]] = c.ground[1];
      lines[at] = `ground ${tiles.join(" ")}`;
      if (c.customTilesets) lines[lines.findIndex((l) => l.startsWith("custom-tilesets "))] = "custom-tilesets 1";
      writeFileSync(w3e, lines.join("\n"));
    }
    const infoFile = join(map, "war3map.w3i.json");
    const info = JSON.parse(readFileSync(infoFile, "utf8"));
    if (c.off) info.flags &= ~4;
    if (c.flags) info.flags |= c.flags;
    // A start location for another player: that player in the w3i too (a copy of player 1, its start there).
    for (const u of units.units.slice(1).filter((u) => u.id === "sloc")) {
      info.players.push({ ...info.players[0], id: u.player, start: [u.position[0], u.position[1]] });
    }
    if (c.players) {
      const like = info.players[0];
      info.players = c.players.map(([id, controller, x, y]) => ({ ...like, id, controller, name: `Player ${id + 1}`, start: [x, y] }));
    }
    writeFileSync(infoFile, JSON.stringify(info, null, 2));
    run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
    mkdirSync(out, { recursive: true });
    run("pack", dir, "-o", join(out, `melee-valid-${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const [name, c] of extra.length ? extra : Object.entries(CASES)) make(name, c);
