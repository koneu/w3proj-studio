import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPath, checkRoute, clearance, findPockets, nearestObject, type Grid } from "./pathcheck";

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

test("the way is the shortest this unit fits, and the wider detour is mentioned", () => {
  // Between the walls: a gap of 1 at the direct line, a gap of 7 far off.
  const h = 41;
  const rows = open(31, h).map((row, y) => (y === 8 || (y >= 30 && y <= 36) ? row : `${row.slice(0, 15)}#${row.slice(16)}`));
  const small = checkPath(grid(rows), at(4, 8), at(26, 8), 16);
  assert.equal(small.length, 22 * 32);
  assert.equal(small.narrowest?.width, 32);
  assert.equal(small.widestWay, 7 * 32);
  const big = checkPath(grid(rows), at(4, 8), at(26, 8), 48);
  assert.ok((big.length ?? 0) > 40 * 32, "too big for the gap: the detour");
});

test("a diagonal between two blocks isn't a way through", () => {
  const r = checkPath(grid(["..#", "...".replace(".", "."), "#.."].map((s, i) => (i === 1 ? ".#." : s))), at(0, 0), at(2, 2), 16);
  assert.equal(r.walkable, false);
});

test("blocked or outside ends are said to be", () => {
  const inside = checkPath(grid(["#..", "...", "..."]), at(0, 0), at(2, 2), 16);
  assert.match(inside.problem ?? "", /start is inside something/);
  assert.deepEqual(inside.nearestFree, at(1, 0));
  assert.match(checkPath(grid(open(3, 3)), at(0, 0), [9999, 0], 16).problem ?? "", /end is outside/);
});

test("standing right beside something still counts as a start", () => {
  const r = checkPath(grid(open(21, 21).map((row, y) => (y === 0 ? "#".repeat(21) : row))), at(10, 1), at(10, 15), 48);
  assert.equal(r.walkable, true);
});

test("the biggest maps work: too many cells to pass as arguments", () => {
  const size = 1920, blocked = new Uint8Array(size * size);
  const r = checkPath({ blocked, width: size, height: size, offsetX: 0, offsetY: 0 }, at(10, 10), at(1900, 1900), 32);
  assert.equal(r.walkable, true);
  assert.ok((r.route?.length ?? 0) <= 14);
});

test("a fenced-in field is a pocket; open ground isn't", () => {
  const rows = open(40, 40).map((row, y) => {
    if (y < 10 || y > 20) return row;
    const wall = y === 10 || y === 20;
    return `${row.slice(0, 10)}${wall ? "#".repeat(11) : `#${".".repeat(9)}#`}${row.slice(21)}`;
  });
  const got = findPockets(grid(rows), 16, null);
  assert.equal(got.pockets.length, 1);
  assert.equal(got.pockets[0].cells, 81);
  assert.deepEqual(got.pockets[0].box, { left: 11 * 32, right: 20 * 32, bottom: 11 * 32, top: 20 * 32 });
  assert.equal(findPockets(grid(open(30, 30)), 16, null).pockets.length, 0);
});

test("a gate only big units can't use makes a pocket for them alone", () => {
  const rows = open(41, 41).map((row, y) => (Math.abs(y - 20) < 2 ? row : `${row.slice(0, 20)}#${row.slice(21)}`));
  assert.equal(findPockets(grid(rows), 16, null).pockets.length, 0);
  assert.equal(findPockets(grid(rows), 64, null).pockets.length, 1);
});

test("tiny gaps and pockets elsewhere stay out", () => {
  const rows = open(40, 40).map((row, y) => (y >= 5 && y <= 8 ? `${row.slice(0, 5)}#..#${row.slice(9)}` : y === 4 || y === 9 ? `${row.slice(0, 5)}####${row.slice(9)}` : row));
  assert.equal(findPockets(grid(rows), 16, null, 16).pockets.length, 0);
  assert.equal(findPockets(grid(rows), 16, null, 4).pockets.length, 1);
  assert.equal(findPockets(grid(rows), 16, { left: 800, bottom: 800, right: 1000, top: 1000 }, 4).pockets.length, 0);
});

test("a route stays in its corridor, and fails where it would have to leave", () => {
  const rows = open(41, 21).map((row, y) => (y === 15 ? row : `${row.slice(0, 20)}#${row.slice(21)}`));
  const line: [number, number][] = [at(2, 10), at(38, 10)];
  const narrow = checkRoute(grid(rows), line, 16, 200);
  assert.equal(narrow.walkable, false);
  assert.equal(narrow.failedLeg, 0);
  assert.equal(narrow.stuckAt?.[0], at(19, 10)[0]);
  const wide = checkRoute(grid(rows), line, 16, 500);
  assert.equal(wide.walkable, true);
  assert.equal(wide.narrowest?.width, 32);
});

test("a road's narrowest place doesn't depend on the unit, or the side a way hugs", () => {
  const rows = open(41, 21).map((row, y) => (y >= 7 && y <= 13 ? row : "#".repeat(41)));
  const line: [number, number][] = [at(8, 9), at(32, 11)];
  const small = checkRoute(grid(rows), line, 16, 600), big = checkRoute(grid(rows), line, 48, 600);
  assert.equal(small.walkable && big.walkable, true);
  assert.equal(small.narrowest?.width, 7 * 32);
  assert.equal(big.narrowest?.width, 7 * 32);
});

test("a route goes through all its points, and a blocked one is named", () => {
  const free = checkRoute(grid(open(30, 30)), [at(2, 2), at(20, 2), at(20, 20)], 16, 128);
  assert.equal(free.walkable, true);
  assert.ok((free.length ?? 0) >= 36 * 32);
  const rows = open(10, 10).map((row, y) => (y === 5 ? "#####.....".slice(0, 10) : row));
  const closed = checkRoute(grid(rows), [at(1, 1), at(2, 5), at(1, 9)], 16, 200);
  assert.match(closed.problem ?? "", /Point 1 is inside/);
  assert.equal(closed.failedLeg, 0);
  assert.match(checkRoute(grid(open(5, 5)), [at(1, 1), [9000, 0]], 16, 100).problem ?? "", /Point 1 is outside/);
});

test("the object nearest a tight spot is found, if there's one close", () => {
  const list = [{ id: "a", position: [0, 0, 0] }, { id: "b", position: [100, 0, 0] }];
  assert.equal(nearestObject(list, [90, 0])?.id, "b");
  assert.equal(nearestObject(list, [900, 0]), null);
});

test("offsets are the map's", () => {
  const g = { ...grid(open(10, 10)), offsetX: -160, offsetY: -160 };
  assert.equal(checkPath(g, [-140, -140], [130, 130], 16).walkable, true);
  assert.match(checkPath(g, [200, 0], [0, 0], 16).problem ?? "", /outside/);
});
