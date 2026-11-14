import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { doodadOnGrid, doodadSnaps, mixedPicture, onDoodadGrid, quarterTurn, type PathSize } from "./doodadgrid";
import type { Placed } from "./objects";

/** The pathing texture sizes of the measured types (the game's Doodads.slk and DestructableData.slk, the textures'
 *  TGA headers). */
const SIZES: Record<string, PathSize | null> = {
  LTbr: { width: 2, height: 2 }, LObr: { width: 2, height: 2 }, LTcr: { width: 4, height: 4 }, LOcb: { width: 4, height: 4 },
  ASHB: { width: 6, height: 6 }, AOks: { width: 8, height: 8 }, LOch: { width: 4, height: 2 }, YSaw: { width: 28, height: 6 },
  APms: null,
};

/** An angle in degrees as the map file stores it (single precision radians). */
const stored = (deg: number) => Math.fround((deg * Math.PI) / 180);

/** tests/fixtures/doodad-grid-we/<name>, found from where the tests run (app/ or the repository). */
function fixture(name: string): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "doodad-grid-we", name);
    if (existsSync(p)) return readFileSync(p, "utf8");
    if (dirname(dir) === dir) throw new Error(`tests/fixtures/doodad-grid-we/${name} not found`);
  }
}

const cases = fixture("snaptest-cases.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((line) => {
  const m = /^(\w{4}) (\S+) (\S+) (\S+) -> (\S+) (\S+) (\S+)$/.exec(line.trim());
  if (!m) throw new Error(`bad case line: ${line}`);
  return { line, id: m[1], x: Number(m[2]), y: Number(m[3]), deg: Number(m[4]), sx: Number(m[5]), sy: Number(m[6]), angle: m[7] };
});

test("every doodad of the World Editor's save is where the rule puts it (340 measured)", () => {
  assert.equal(cases.length, 340);
  const wrong: string[] = [];
  for (const c of cases) {
    const a = stored(c.deg);
    const got = doodadOnGrid(Math.fround(c.x), Math.fround(c.y), a, SIZES[c.id]);
    const angle = c.angle === "keep" ? a : stored(Number(c.angle));
    if (got.x !== c.sx || got.y !== c.sy || got.angle !== angle) wrong.push(`${c.line}: got ${got.x} ${got.y} ${(got.angle * 180) / Math.PI}`);
  }
  assert.deepEqual(wrong, []);
});

test("the measured cases test both grids, both ties and the turns (control: a plain rounding to 64 fails them)", () => {
  // A rule that ignores the texture's size (everything to 64n) gets the 2×2 and 6×6 types wrong.
  const naive = cases.filter((c) => Math.round(c.x / 64) * 64 !== c.sx && SIZES[c.id]);
  assert.ok(naive.length > 50, `${naive.length}`);
  // Ties: exactly between two grid points goes up, on either side of 0.
  for (const [id, x, want] of [["LTbr", -3328, -3296], ["LTbr", 256, 288], ["LTcr", -3040, -3008], ["LTcr", 544, 576]] as const) {
    assert.equal(doodadOnGrid(x, 0, stored(270), SIZES[id]).x, want, `${id} ${x}`);
    assert.ok(cases.some((c) => c.id === id && c.x === x && c.sx === want), `${id} ${x} is a measured case`);
  }
  // The rectangles' parity follows the quarter turn: 4×2 at 0° has its 2 cells along x.
  assert.deepEqual(doodadOnGrid(-3312, 272, stored(0), SIZES.LOch), { x: -3296, y: 256, angle: 0 });
  assert.deepEqual(doodadOnGrid(-1776, 528, stored(270), SIZES.LOch), { x: -1792, y: 544, angle: stored(270) });
});

test("the quarter turns round as the World Editor's single precision does", () => {
  const q = (deg: number) => quarterTurn(stored(deg));
  assert.deepEqual([0, 44.9, 45, 134.9, 135, 224.9, 225, 314.9, 315, 315.1, 359].map(q), [0, 0, 1, 1, 2, 2, 3, 3, 3, 0, 0]);
  assert.equal(quarterTurn(-Math.PI / 2), 3);
  assert.equal(quarterTurn(Math.fround(5 * Math.PI)), 2);
});

test("a square texture keeps the angle, no texture keeps everything", () => {
  assert.deepEqual(doodadOnGrid(10, 20, 0.3, SIZES.LOcb), { x: 0, y: 0, angle: 0.3 });
  assert.deepEqual(doodadOnGrid(10.5, 20.25, 0.3, null), { x: 10.5, y: 20.25, angle: 0.3 });
  // Malformed input stays as it is.
  assert.deepEqual(doodadOnGrid(Number.NaN, 0, 0, SIZES.LOcb), { x: Number.NaN, y: 0, angle: 0 });
  assert.deepEqual(doodadOnGrid(10, 0, 0, { width: 0, height: 4 }), { x: 10, y: 0, angle: 0 });
});

test("doodadSnaps lists only what moves or turns", () => {
  const at = (id: string, x: number, y: number, deg = 270): Placed => ({ id, variation: 0, position: [x, y, 5], angle: stored(deg), scale: [1, 1, 1] });
  const list = [at("LTbr", 32, 32), at("LTbr", 40, 32), at("LOch", 32, 64, 0), at("LOch", 32, 0, 10), at("APms", 1.5, 2.5)];
  const snaps = doodadSnaps(list, (id) => SIZES[id] ?? null);
  assert.deepEqual(snaps.map((s) => list.indexOf(s.entry)), [1, 3]);
  // The barrel moves, the hay cart only turns (from 10° to 0°).
  assert.deepEqual(snaps.map(({ x, y, angle }) => [x, y, angle]), [[32, 32, stored(270)], [32, 0, 0]]);
  assert.deepEqual(list[1].position, [40, 32, 5], "the list itself isn't changed");
});

test("a quarter turn as the JSON writes it (shortest single precision) is the file's own: nothing turns", () => {
  // Real maps' rectangles (HillsbradCreek's VOfs at 180°, SnowareBay's at 270°) read back from war3map.doo.json.
  for (const angle of [1.5707964, 3.1415927, 4.712389]) {
    assert.notEqual(angle, Math.fround(angle), "control: the JSON's value isn't the single precision one as a double");
    assert.equal(doodadOnGrid(0, 0, angle, SIZES.LOch).angle, angle);
  }
  // HillsbradCreek's VOfs (4×2) at 180°, as read: on its grid and turned, so it isn't listed.
  assert.deepEqual(doodadSnaps([{ id: "VOfs", variation: 0, position: [-3744, 576, 0], angle: 3.1415927, scale: [1, 1, 1] }], () => SIZES.LOch), []);
});

/** The World Editor's saved facings (we-drive, verification round 3 package 6, 2026-11-13: a copy of the 200-doodad
 *  test map with these added, opened and saved by the editor): type, its pathing size, a destructable's fixed rotation,
 *  the stored angle (degrees) and the saved one as the file's single precision bytes (little-endian hex). */
const FACINGS: [string, PathSize | null, number | null, number, string][] = [
  // Trees: fixedRot 270, a square texture.
  ["LTlt", { width: 4, height: 4 }, 270, 30, "e4cb9640"], ["LTlt", { width: 4, height: 4 }, 270, 270, "e4cb9640"],
  ["LTlt", { width: 4, height: 4 }, 270, -90, "e4cb9640"], ["LTlt", { width: 4, height: 4 }, 270, 400, "e4cb9640"],
  // Tree bridges: fixedRot 0 (LTt0) and 90 (ATt0), a 24×12 texture: the fixed rotation, not the stored angle's quarter.
  ["LTt0", { width: 24, height: 12 }, 0, -30, "00000000"], ["LTt0", { width: 24, height: 12 }, 0, 450, "00000000"],
  ["LTt0", { width: 24, height: 12 }, 0, -90, "00000000"], ["LTt0", { width: 24, height: 12 }, 0, 0, "00000000"],
  ["ATt0", { width: 24, height: 12 }, 90, 0, "db0fc93f"], ["ATt0", { width: 24, height: 12 }, 90, 200, "db0fc93f"],
  // The barrel: no fixed rotation, a square texture: whole turns.
  ["LTbr", { width: 2, height: 2 }, null, -90, "e4cb9640"], ["LTbr", { width: 2, height: 2 }, null, -270, "dc0fc93f"],
  ["LTbr", { width: 2, height: 2 }, null, 450, "d80fc93f"], ["LTbr", { width: 2, height: 2 }, null, 720, "db0fc940"],
  ["LTbr", { width: 2, height: 2 }, null, 1080, "d90fc940"], ["LTbr", { width: 2, height: 2 }, null, -720, "00000000"],
  ["LTbr", { width: 2, height: 2 }, null, 360, "db0fc940"], ["LTbr", { width: 2, height: 2 }, null, 28.6479, "0300003f"],
  ["LTbr", { width: 2, height: 2 }, null, -5.7296, "a7dcc540"],
  // Doodads without a texture: whole turns too; YZef's fixedRot 270 isn't enforced.
  ["LOrb", null, null, 400, "c0b8323f"], ["LOrb", null, null, -90, "e4cb9640"], ["LOrb", null, null, 720, "db0fc940"],
  ["YZef", null, null, 30, "920a063f"], ["YZef", null, null, 400, "c0b8323f"],
  // The hay cart (4×2): a quarter turn of the stored angle (-45 to 0, where 315 would go to 270).
  ["LOch", { width: 4, height: 2 }, null, -45, "00000000"], ["LOch", { width: 4, height: 2 }, null, 400, "00000000"],
  ["LOch", { width: 4, height: 2 }, null, -360, "00000000"], ["LOch", { width: 4, height: 2 }, null, 90, "db0fc93f"],
];
const f32hex = (v: number) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.toString("hex"); };

test("every measured facing is what the World Editor saved: a destructable's fixed rotation, else whole turns (28 cases)", () => {
  const wrong: string[] = [];
  for (const [id, size, fixed, deg, saved] of FACINGS) {
    const got = doodadOnGrid(0, 0, stored(deg), size, fixed).angle;
    if (f32hex(got) !== saved) wrong.push(`${id} ${deg}: got ${f32hex(got)} (${(got * 180) / Math.PI}), saved ${saved}`);
  }
  assert.deepEqual(wrong, []);
  // Controls: without the fixed rotation the tree keeps its 30 and the bridge turns to a quarter of 450 (90); a turn
  // by remainder would take 720 to 0.
  assert.notEqual(f32hex(doodadOnGrid(0, 0, stored(30), { width: 4, height: 4 }).angle), "e4cb9640");
  assert.equal(doodadOnGrid(0, 0, stored(450), { width: 24, height: 12 }).angle, stored(90));
  assert.notEqual(f32hex(stored(720) % Math.fround(2 * Math.PI)), "db0fc940");
});

test("the tree bridges stand on the grid of their fixed rotation (measured places)", () => {
  // LTt0 (fixedRot 0) and ATt0 (90), 24×12, stored facing 0 and 200.
  assert.deepEqual(doodadOnGrid(-1952, 1920, 0, { width: 24, height: 12 }, 0), { x: -1920, y: 1920, angle: 0 });
  const bridge = doodadOnGrid(-1184, 1920, stored(200), { width: 24, height: 12 }, 90);
  assert.deepEqual([bridge.x, bridge.y, f32hex(bridge.angle)], [-1152, 1920, "db0fc93f"]);
});

test("whole turns: in range as stored, huge or broken angles don't hang", () => {
  const facing = (a: number) => doodadOnGrid(0, 0, a, null).angle;
  assert.equal(facing(0.3), 0.3, "an angle in range is kept as written");
  assert.equal(facing(stored(-90)), stored(270));
  for (const a of [1e30, -1e30, 3.4e38, -3.4e38]) {
    const w = facing(a);
    assert.ok(w >= 0 && w <= Math.fround(2 * Math.PI), `${a}: ${w}`);
  }
  // A doodad with a broken angle stays as it is.
  assert.deepEqual(doodadOnGrid(5, 6, Number.NaN, null), { x: 5, y: 6, angle: Number.NaN });
  assert.equal(facing(Infinity), Infinity);
});

test("doodadSnaps turns a destructable to its type's fixed rotation and lists it", () => {
  const tree: Placed = { id: "LTlt", variation: 0, position: [0, 0, 0], angle: stored(30), scale: [1, 1, 1] };
  assert.deepEqual(doodadSnaps([tree], () => ({ width: 4, height: 4 })), [], "control: without the fixed rotation the tree stays");
  const snaps = doodadSnaps([tree], () => ({ width: 4, height: 4 }), (id) => (id === "LTlt" ? 270 : null));
  assert.equal(snaps.length, 1);
  assert.equal(f32hex(snaps[0].angle), "e4cb9640");
});

// we-compare specs doodad-snap-custom-tex / -col / -more (2026-11-14): custom doodads and destructables at 0.4 and 1.2
// (destructables 0.4 and 2.9) off their grids; the editor saved these angles.
test("a square texture of more than one colour turns to the quarter, a plain one keeps the angle (measured)", () => {
  const mixed: PathSize = { width: 4, height: 4, mixed: true };
  for (const [size, a, saved] of [[mixed, 0.4, 0], [mixed, 1.2, 1.5707964], [{ width: 2, height: 2, mixed: true }, 0.4, 0], [{ width: 2, height: 2, mixed: true }, 1.2, 1.5707964],
    [{ width: 4, height: 4 }, 0.4, 0.4], [{ width: 4, height: 4 }, 1.2, 1.2], [{ width: 16, height: 16 }, 1.2, 1.2]] as const) {
    assert.equal(Math.fround(doodadOnGrid(0, 0, a, size).angle), Math.fround(saved), `${size.width}x${size.height} ${size.mixed ? "mixed" : "plain"} ${a}`);
  }
  // Its place still comes from the picture's size.
  assert.deepEqual(doodadOnGrid(13.5, 21.25, 0.4, { width: 2, height: 2, mixed: true }), { x: 32, y: 32, angle: 0 });
});

test("mixedPicture: any pixel of another colour, alpha ignored", () => {
  const px = (...c: number[][]) => c.flatMap(([r, g, b, a = 255]) => [r, g, b, a]);
  assert.equal(mixedPicture(px([255, 0, 255], [255, 0, 255], [255, 0, 255])), false);
  assert.equal(mixedPicture(px([255, 0, 255, 0], [255, 0, 255, 255])), false);
  assert.equal(mixedPicture(px([255, 0, 255], [255, 0, 255], [255, 0, 0])), true, "control: one red pixel");
  assert.equal(mixedPicture(px([0, 0, 0], [0, 0, 0])), false, "all black is one colour");
  assert.equal(mixedPicture([]), false);
});

test("a destructable's fixed rotation holds only with a pathing texture (measured: bptx _ keeps 0.4 and 2.9)", () => {
  const none = (fixed: number, a: number) => doodadOnGrid(0, 0, a, null, fixed).angle;
  assert.equal(none(270, 0.4), 0.4);
  assert.equal(none(90, 2.9), 2.9);
  assert.equal(none(0, 0.4), 0.4);
  assert.equal(none(-1, 2.9), 2.9);
  // With a texture it faces the fixed rotation (2x2: 90 and 270; 4x4: 0), none (-1) keeps the angle.
  const two = (fixed: number | null, a: number) => doodadOnGrid(0, 0, a, { width: 2, height: 2 }, fixed).angle;
  assert.equal(two(90, 0.4), Math.fround(Math.PI / 2));
  assert.equal(two(270, 2.9), Math.fround((270 * Math.PI) / 180));
  assert.equal(two(-1, 2.9), 2.9);
  assert.equal(doodadOnGrid(0, 0, 0.4, { width: 4, height: 4 }, 0).angle, 0);
});

// we-compare spec doodad-snap-grid (2026-11-14): pictures of 1 to 8 pixels across and high, every one placed at 16 offsets
// at 0 and 90 degrees; the editor's places (modulo 64) for each count along an axis.
test("a texture's grid is 64n plus the whole cells below its middle (measured, 1 to 8 pixels)", () => {
  for (const [cells, offset] of [[1, 0], [2, 32], [3, 32], [4, 0], [6, 32], [8, 0], [16, 0]] as const) {
    for (const v of [-478.75, -286.5, 13.5, 21.25, 100]) {
      const at = onDoodadGrid(v, cells);
      assert.equal((((at - offset) % 64) + 64) % 64, 0, `${cells} cells at ${v}: ${at}`);
      assert.ok(Math.abs(at - v) <= 32, `${cells} cells at ${v} goes to the nearest`);
    }
  }
  // The two the spec doodad-snap-custom-more left open: a 4x1 picture at 0 and at a quarter turn, on 64n for both axes.
  assert.deepEqual(doodadOnGrid(-286.5, -478.75, 0, { width: 4, height: 1 }), { x: -256, y: -448, angle: 0 });
  assert.deepEqual(doodadOnGrid(-286.5, -478.75, Math.fround(Math.PI / 2), { width: 4, height: 1 }), { x: -256, y: -448, angle: Math.fround(Math.PI / 2) });
  // A 3x3 one stands on 64n + 32, not the 48 of a building.
  assert.equal(doodadOnGrid(13.5, 21.25, 0, { width: 3, height: 3 }).x, 32);
  // Control: halves go upwards.
  assert.equal(onDoodadGrid(32, 1), 64);
  assert.equal(onDoodadGrid(-32, 1), 0);
});
