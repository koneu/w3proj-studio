import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPath, clearance, type Grid } from "./pathcheck";

/** A grid from rows, north last in the text order given: "#" is blocked. Row 0 is the south. */
function grid(rows: string[]): Grid {
  const width = rows[0].length, height = rows.length;
  const blocked = new Uint8Array(width * height);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { blocked[y * width + x] = ch === "#" ? 1 : 0; }));
  return { blocked, width, height, offsetX: 0, offsetY: 0 };
}
const at = (x: number, y: number): [number, number] => [x * 32 + 16, y * 32 + 16];
const open = (w: number, h: number) => Array.from({ length: h }, () => ".".repeat(w));

test("clearance counts cells to what's blocked, and the map's edge counts", () => {
  const c = clearance(grid([".....", ".....", "..#..", ".....", "....."]));
  assert.equal(c[2 * 5 + 2], 0);
  assert.equal(c[2 * 5 + 1], 1);
  assert.equal(c[0], 1);
});

test("open ground is walkable, with its length", () => {
  const r = checkPath(grid(open(20, 20)), at(1, 10), at(18, 10), 16);
  assert.equal(r.walkable, true);
  assert.equal(r.length, 17 * 32);
  assert.deepEqual(r.route?.at(-1), at(18, 10));
});

test("a wall without a gap stops it, and says how far it got", () => {
  const rows = open(21, 9).map((row, y) => (y === 9 ? row : `${row.slice(0, 10)}#${row.slice(11)}`));
  const r = checkPath(grid(rows), at(2, 4), at(18, 4), 16);
  assert.equal(r.walkable, false);
  assert.equal(r.problem, "There's no way through.");
  assert.equal(r.stuckAt?.[0], at(9, 4)[0]);
  assert.equal(r.largestUnitThatFits, 0);
});

/** A wall across, with a gap `gap` cells wide. */
const gapped = (gap: number) => {
  const h = 31, mid = 15;
  return grid(open(31, h).map((row, y) => (Math.abs(y - mid) * 2 < gap ? row : `${row.slice(0, 15)}#${row.slice(16)}`)));
};

test("a gap is measured, and the tightest place is found", () => {
  const r = checkPath(gapped(5), at(4, 15), at(26, 15), 16);
  assert.equal(r.walkable, true);
  assert.equal(r.narrowest?.width, 5 * 32);
  assert.deepEqual(r.narrowest?.at, at(15, 15));
});

test("a gap too small for a big unit says what would fit", () => {
  const r = checkPath(gapped(3), at(4, 15), at(26, 15), 64);
  assert.equal(r.walkable, false);
  assert.equal(r.problem, "The way through is too narrow for this unit.");
  assert.equal(r.largestUnitThatFits, 48);
  assert.equal(checkPath(gapped(3), at(4, 15), at(26, 15), 32).walkable, true);
});

test("of two ways it takes the wide one, though the narrow one is shorter", () => {
  // Between the walls: a gap of 1 at the direct line, a gap of 7 far off.
  const h = 41;
  const rows = open(31, h).map((row, y) => (y === 8 || (y >= 30 && y <= 36) ? row : `${row.slice(0, 15)}#${row.slice(16)}`));
  const r = checkPath(grid(rows), at(4, 8), at(26, 8), 16);
  assert.equal(r.narrowest?.width, 7 * 32);
});

test("a diagonal between two blocks isn't a way through", () => {
  const r = checkPath(grid(["..#", "...".replace(".", "."), "#.."].map((s, i) => (i === 1 ? ".#." : s))), at(0, 0), at(2, 2), 16);
  assert.equal(r.walkable, false);
});

test("blocked or outside ends are said to be", () => {
  assert.match(checkPath(grid(["#..", "...", "..."]), at(0, 0), at(2, 2), 16).problem ?? "", /start is on blocked/);
  assert.match(checkPath(grid(open(3, 3)), at(0, 0), [9999, 0], 16).problem ?? "", /end is outside/);
});

test("standing right beside something still counts as a start", () => {
  const r = checkPath(grid(open(21, 21).map((row, y) => (y === 0 ? "#".repeat(21) : row))), at(10, 1), at(10, 15), 48);
  assert.equal(r.walkable, true);
});

test("offsets are the map's", () => {
  const g = { ...grid(open(10, 10)), offsetX: -160, offsetY: -160 };
  assert.equal(checkPath(g, [-140, -140], [130, 130], 16).walkable, true);
  assert.match(checkPath(g, [200, 0], [0, 0], 16).problem ?? "", /outside/);
});
