// Makes the inputs of the start-location melee specs (tests/we-compare/melee-valid-we.json) from flat.w3x (the World
// Editor's own new 64x64 Lordaeron Summer melee map: one start location at (0, -256), corner (32, 30), flags 0x9c14):
//
//   node tests/fixtures/we-specs/make-melee-valid.mjs <w3proj cli> <game folder> [--out DIR] [--case NAME=JSON]...
//
// Each case is flat.w3x with one thing near the start, written as melee-valid-<name>.w3x into <repo>/target/melee-valid/
// (or DIR; not committed: 22 maps of 35 KB).
// Without --case it makes the CASES below; --case makes others (for measuring), the JSON as a CASES entry:
//   off        true: the w3i's Melee flag cleared (0x9c10), to see whether the editor's save puts it back
//   doodads    [[id, dx, dy]]: doodads or destructables at the start + (dx, dy)
//   units      [[id, dx, dy, player]]: units or items (player 24: neutral passive) at the start + (dx, dy)
//   start      [dx, dy]: moves the start location
//   corners    [[x0, y0, x1, y1, { layer, flags, texture, water, height }]]: corners (inclusive, the map's corner
//              indices; the start's is 32, 30) set to these values; cliff corners get Grass Cliff as Apply Cliff leaves it
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
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] === "--case") { const [name, ...json] = argv[++i].split("="); extra.push([name, JSON.parse(json.join("="))]); }
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}

/** The cases of tests/we-compare/melee-valid-we.json: the pairs either side of each threshold measured there. All
 *  with the flag cleared (the editor's save puts it back for a valid start) but the last. */
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
    let n = 1;
    for (const [id, dx, dy, player = 24] of c.units ?? []) {
      units.units.push({
        ...start, id, skinId: id, position: [START[0] + dx, START[1] + dy, 0], angle: 0, player, flags: 2,
        hp: -1, mana: -1, level: 1, gold: id === "ngol" ? 12500 : 0, targetAcquisition: -1, editorId: n++, trailer: [0, 0],
      });
    }
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
    const infoFile = join(map, "war3map.w3i.json");
    const info = JSON.parse(readFileSync(infoFile, "utf8"));
    if (c.off) info.flags &= ~4;
    // A start location for another player: that player in the w3i too (a copy of player 1, its start there).
    for (const u of units.units.slice(1).filter((u) => u.id === "sloc")) {
      info.players.push({ ...info.players[0], id: u.player, start: [u.position[0], u.position[1]] });
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
