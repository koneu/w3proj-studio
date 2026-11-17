// Makes fence-wpm.w3x for the diagonal fence pathing spec (tests/we-compare/fence-wpm.json) from flat.w3x (the World
// Editor's own new 64x64 Lordaeron Summer map):
//
//   node tests/fixtures/we-specs/make-fence.mjs <w3proj cli> <game folder>
//
// Diagonal fences of the game (pathing textures Fence45, Fence135, ShortFence135) and a straight one (8x2Default) at
// many facings, quarter turns and odd angles, on their grid and off it; then two fences of Angled Fence pieces in a line
// (example map 22's Fence 1 as played: pairs 64 apart, 128 between pairs, facing 90, scale 1.2; and a solid line, a
// piece every 64, facing 0). The editor snaps them when it opens the map and makes war3map.wpm when it saves.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";
import { modeArgs, requireValid } from "../../gen-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
const args = modeArgs();
requireValid(args.length === 0 || (args.length === 1 && ["angles", "ints", "neg", "dest", "exact"].includes(args[0])), "usage: make-fence.mjs <w3proj cli> <game folder> [angles | ints | neg | dest | exact]");
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-fence.mjs <w3proj cli> <game folder> [angles|ints|neg|dest|exact]"); process.exit(2); }
// "angles": fence-angles.w3x, many facings of two rectangles (below), for the quarter the editor turns them to
const angles = args[0] === "angles";
// "ints": fence-ints.w3x, angles that are whole numbers of radians (2.0, 3.0, 180.0 …) on three kinds of doodad
const ints = args[0] === "ints";
// "neg": fence-neg.w3x, negative and other whole and odd angles (-1 three times each: random?) on the same three kinds,
// and NOfl and LOcb off their grid with flags 0 and 1
const neg = args[0] === "neg";
// "dest": fence-dest.w3x, whole-number angles on destructables without a fixed rotation: the barrel LTbr (2x2Default,
// one colour), the thin path blocker YTpl (2x1Default, turns), the crate LTcr (4x4Default) and OTsp (no texture)
const dest = args[0] === "dest";
// "exact": fence-exact.w3x, the angles that sit on a rounding edge (multiples of 45 degrees from -405 to 765 as the single
// precision numbers a file holds) on NOfl (8x2), NOal (Fence45) and VOal (Fence135), and NOfl every quarter degree within
// 2 degrees of 45, 135, 225 and 315
const exact = args[0] === "exact";
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

const f32 = Math.fround;
const ANGLES = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI, 3 * Math.PI / 2, 0.4, 2.0, 3.5, 5.5];
// [type, row y, offset off the grid]
const ROWS = [["NOal", 2560, 0], ["VOal", 2048, 0], ["VOas", 1536, 0], ["NOfl", 1024, 0], ["NOal", 512, 13.5]];

const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "fence");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const file = join(dir, "map", "war3map.doo.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const put = (id, x, y, angle, scale = 1, flags = 2) => doc.doodads.push({
    id, variation: 0, position: [x, y, 0], angle: f32(angle), scale: [scale, scale, scale], skinId: id,
    preFlags: 4294967295, flags, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [doc.doodads.length, 0, 0], extras: [] });
  if (neg) {
    const list = [];
    const NEG = [-0.5, -1, -1, -1, -2, -3, -45, -90, -180, -3.14159, -360, 360, 361, 720];
    for (const id of ["NOfl", "LOcb", "APms"]) for (const a of NEG) list.push([id, a, 2]);
    list.forEach(([id, a], i) => put(id, -2688 + (i % 8) * 640, -2688 + Math.floor(i / 8) * 640, a));
    // Off their grid (13.5, 20.25) at 0.4 radians with flags 0 and 1.
    [["NOfl", 0], ["NOfl", 1], ["LOcb", 0], ["LOcb", 1]].forEach(([id, flags], k) => put(id, -2688 + 13.5 + k * 640, 2432 + 20.25, 0.4, 1, flags));
  } else if (dest) {
    const list = [];
    for (const id of ["LTbr", "YTpl", "LTcr", "OTsp"]) for (const a of [1, 2, 3, 90, 180, 270, -1, -2, 2.0000002, 0.5]) list.push([id, a]);
    list.forEach(([id, a], i) => put(id, -2688 + (i % 8) * 640 + 13.5, -2688 + Math.floor(i / 8) * 640 + 20.25, a));
  } else if (angles) {
    // Which quarter the editor turns each angle to: the straight fence (8x2) and the hay cart (4x2) every 5 degrees,
    // and the fence at radian values round 2.0.
    const list = [];
    for (const id of ["NOfl", "LOch"]) for (let deg = 0; deg < 360; deg += 5) list.push([id, (deg * Math.PI) / 180]);
    for (const r of [1.7, 1.8, 1.9, 1.95, 2.0, 2.05, 2.1, 2.2, 2.3, 2.5, 3.0, 4.0]) list.push(["NOfl", r]);
    list.forEach(([id, a], i) => put(id, -2688 + (i % 12) * 448, -2688 + Math.floor(i / 12) * 384, a));
  } else if (exact) {
    const list = [];
    for (const id of ["NOfl", "NOal", "VOal"]) for (let deg = -405; deg <= 765; deg += 45) list.push([id, (deg * Math.PI) / 180]);
    for (const c of [45, 135, 225, 315]) for (let k = -8; k <= 8; k++) list.push(["NOfl", ((c + k / 4) * Math.PI) / 180]);
    list.forEach(([id, a], i) => put(id, -2688 + (i % 12) * 448, -2688 + Math.floor(i / 12) * 384, a));
  } else if (ints) {
    // Whole numbers as angles: the straight fence (turns to a quarter), the plain square LOcb (keeps its angle) and the
    // mushrooms APms (no pathing texture), and the single precision neighbours of 2.0.
    const list = [];
    for (const a of [1, 2, 3, 4, 5, 6, 7, 45, 90, 180, 270, -1, -2, 2.0000002, 1.9999999, 0.5]) list.push(["NOfl", a]);
    for (const a of [1, 2, 3, 90, 180, 2.0000002, 0.5]) for (const id of ["LOcb", "APms"]) list.push([id, a]);
    list.forEach(([id, a], i) => put(id, -2688 + (i % 8) * 640, -2688 + Math.floor(i / 8) * 640, a));
  } else {
    for (const [id, y, off] of ROWS) ANGLES.forEach((a, i) => put(id, -2560 + i * 512 + off, y + off * 1.5, a));
    // Map 22's Fence 1 as played: from (128, 1728) up and right, pairs of pieces 64 apart, 128 between the pairs.
    for (let k = 0; k < 10; k++) {
      const d = 192 * (k >> 1) + 64 * (k & 1);
      put("NOal", -2560 + d, -1536 + d, Math.PI / 2, 1.2);
    }
    // A solid line, a piece every 64, facing 0 (map 22's Fence 1 now).
    for (let k = 0; k < 10; k++) put("NOal", 128 + 64 * k, -1536 + 64 * k, 0, 1.2);
  }
  writeFileSync(file, JSON.stringify(doc, null, 2));
  run("pack", dir, "-o", join(here, angles ? "fence-angles.w3x" : exact ? "fence-exact.w3x" : ints ? "fence-ints.w3x" : neg ? "fence-neg.w3x" : dest ? "fence-dest.w3x" : "fence-wpm.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
