import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { doodadOnGrid, doodadSnaps, quarterTurn, type PathSize } from "./doodadgrid";
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
