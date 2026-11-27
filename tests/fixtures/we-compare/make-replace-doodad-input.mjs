// Makes replace-doodad.w3m, the input map of tests/we-compare/replace-doodad-overlap.json, from the empty 64x64 map:
//
//   node tests/fixtures/we-compare/make-replace-doodad-input.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m> <game folder>
//
// Barrels (LTbs, 2x2 pathing texture) for Replace Doodads barrel -> crates (LTcr, 4x4), each in a cell of its own,
// 512 apart, already on their grids: a barrel at (X + 32, Y + 32) becomes a crate at (X + 64, Y + 64) whose texture
// covers x X..X + 128, y Y..Y + 128 (the 4x4 grid, halves going up). Beside each, what its crate would meet:
//   c1 nothing; c2 a tree LTlt touching the crate's east edge; c3 a tree overlapping its east half; c4 crates LTcr
//   overlapping its east half; c5 a doodad LOsh (2x2) on its north-east quarter; c6 a pathless doodad LPcr there;
//   c7 a footman there; c8 a farm hhou (4x4) over that quarter; c9 a second barrel diagonally south-east, listed
//   first (the two crates overlap, neither crate the other's barrel); c10 the same, listed after; c11 a second barrel
//   right beside it east (its crate overlaps the second barrel and the second's crate); c12, c13, c14 a footman at
//   the height of the crate's middle, 8, 24 and 40 east of its east edge; c15 a footman 8 inside that edge; c16 an
//   item (ratf) on the crate's north-east quarter; c17 (X 576: half a tile off the tiles) a cliff: the corners east
//   from x 768 on are one level up from y -1024 to -128, so the cliff's tiles (x 640 to 768) cover the crate's east
//   half, not the barrel.
//
// The game folder is for the rebuild of the pathing map after the cliff.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFresh } from "../../binfresh.mjs";

const [empty, cli, out, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-replace-doodad-input.mjs <empty map> <w3proj cli> <out.w3m> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
/** The lower-left corner (X, Y) of each case's crate. */
const CELLS = [[-1024, 1024], [-512, 1024], [0, 1024], [512, 1024], [-1024, 512], [-512, 512], [0, 512], [512, 512], [-1024, 0], [-512, 0], [0, 0],
  [-1024, -512], [-512, -512], [0, -512], [-1024, -1024], [-512, -1024], [576, -512]];
const at = (c, dx, dy) => [CELLS[c - 1][0] + dx, CELLS[c - 1][1] + dy];
const barrel = (c) => ["LTbs", ...at(c, 32, 32)];
const DOODADS = [
  barrel(1),
  barrel(2), ["LTlt", ...at(2, 192, 64)],
  barrel(3), ["LTlt", ...at(3, 128, 64)],
  barrel(4), ["LTcr", ...at(4, 128, 64)],
  barrel(5), ["LOsh", ...at(5, 96, 96)],
  barrel(6), ["LPcr", ...at(6, 96, 96)],
  barrel(7),
  barrel(8),
  ["LTbs", ...at(9, 96, -32)], barrel(9),
  barrel(10), ["LTbs", ...at(10, 96, -32)],
  barrel(11), ["LTbs", ...at(11, 96, 32)],
  barrel(12), barrel(13), barrel(14), barrel(15), barrel(16), barrel(17),
];
const UNITS = [
  ["hfoo", ...at(7, 96, 96)], ["hhou", ...at(8, 128, 128)],
  ["hfoo", ...at(12, 136, 64)], ["hfoo", ...at(13, 152, 64)], ["hfoo", ...at(14, 168, 64)], ["hfoo", ...at(15, 120, 64)],
  ["ratf", ...at(16, 96, 96)],
];
/** The cliff of c17, in corners (128 apart from -4096): x 768 and on, y -1024 to -128. */
const high = (x, y) => x >= 38 && y >= 24 && y <= 31;
const N = 65;
const onCliff = (x, y) => [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => {
  const tx = x + dx, ty = y + dy;
  const q = [high(tx, ty), high(tx + 1, ty), high(tx, ty + 1), high(tx + 1, ty + 1)];
  return q.some(Boolean) && !q.every(Boolean);
});
/** A section's rows as the text keeps them: the top row (y = 64) first. */
const rows = (f) => Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, x) => f(x, N - 1 - r)).join(""));
const NEUTRAL_PASSIVE = 27;
const scratch = mkdtempSync(join(tmpdir(), "we-compare-replace-doodad-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", "none");
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const map = join(dir, "map");
  const unitsFile = join(map, "war3mapUnits.doo.json");
  const units = JSON.parse(readFileSync(unitsFile, "utf8"));
  const template = units.units[0];
  // The map's own start location stays (the editor makes one where the map has none, and Studio another).
  units.units = [template, ...UNITS.map(([id, x, y], i) => ({
    ...template, id, skinId: id, position: [x, y, 0], player: id === "ratf" ? NEUTRAL_PASSIVE : 0, hp: -1, mana: -1,
    ...(id === "ratf" ? { level: 0, targetAcquisition: 0 } : { level: 1, targetAcquisition: -1 }), editorId: i + 1, trailer: [0, 0],
  }))];
  writeFileSync(unitsFile, JSON.stringify(units, null, 1));
  const dooFile = join(map, "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  doo.doodads = DOODADS.map(([id, x, y], i) => ({
    id, variation: 0, position: [x, y, 0], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: id, preFlags: 4294967295,
    flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [i, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  const w3e = join(map, "war3map.w3e.txt");
  const lines = readFileSync(w3e, "utf8").split("\n");
  const sections = {
    layer: rows((x, y) => (high(x, y) ? "3" : "2")),
    "cliff-texture": rows((x, y) => (onCliff(x, y) ? "1" : "f")),
  };
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[i]);
    if (m && m[1] in sections) {
      kept.push(`[${m[1]}]`, ...sections[m[1]]);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  writeFileSync(w3e, kept.join("\n"));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  run("pack", "--keep-objects", dir, "-o", out);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
