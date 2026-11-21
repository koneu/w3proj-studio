import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateNumber, nextRange, ownerOf, UNSET, type IdLayout, type IssuedNumbers } from "./creationids";

/** A 2×2 grid as `w3proj terrain split` makes it for an 8×6-corner canvas at (-512, -384): sw, se, nw, ne. */
const grid = (): IdLayout => ({
  offset: [-512, -384],
  subterrains: [
    { name: "sw", x: 0, y: 0, w: 4, h: 3, idRanges: [[10000, 19999]] },
    { name: "se", x: 4, y: 0, w: 4, h: 3, idRanges: [[20000, 29999]] },
    { name: "nw", x: 0, y: 3, w: 4, h: 3, idRanges: [[30000, 39999]] },
    { name: "ne", x: 4, y: 3, w: 4, h: 3, idRanges: [[40000, 49999]] },
  ],
});
const SW: [number, number] = [-400, -300], SE: [number, number] = [100, -300], NE: [number, number] = [100, 100];

test("flat: one past the highest, exactly as before subterrains (placed objects and regions)", () => {
  // The expressions newEntry and nextRegionIndex had (the oracle for unchanged flat numbering).
  const oldPlaced = (values: unknown[], issued: number | undefined) => 1 + Math.max(-1, issued ?? -1, ...values.map((v) => Number(v) || 0).filter((v) => v < UNSET));
  const oldRegions = (values: number[]) => 1 + Math.max(-1, ...values);
  const cases: unknown[][] = [[], [0], [0, 0, 0], [3, 1, 2], [UNSET, 5], [UNSET], ["7", null, undefined, NaN, 2], [UNSET - 1], [-4, 2.5], [5e9, 1]];
  for (const values of cases) {
    for (const before of [undefined, 0, 9]) {
      const issued: IssuedNumbers = before === undefined ? {} : { max: before };
      assert.equal(allocateNumber("units", values, issued, null, [0, 0]), oldPlaced(values, before), JSON.stringify(values));
      assert.equal(issued.max, oldPlaced(values, before));
      assert.equal(allocateNumber("doodads", values, before === undefined ? {} : { max: before }, null, [0, 0]), oldPlaced(values, before));
    }
    const nums = values.filter((v): v is number => typeof v === "number");
    const got = allocateNumber("regions", nums, {}, null, [0, 0]);
    assert.ok(Object.is(got, oldRegions(nums)), `${JSON.stringify(nums)}: ${got} vs ${oldRegions(nums)}`);
  }
  // Numbers handed out before and taken out again (an undo) stay used.
  const issued: IssuedNumbers = {};
  assert.deepEqual([allocateNumber("units", [4], issued, null, [0, 0]), allocateNumber("units", [4], issued, null, [0, 0]), allocateNumber("units", [], issued, null, [0, 0])], [5, 6, 7]);
});

test("ownerOf decides as terrain_objects.rs owner: inside, lower edges belong, upper ones to the next, else the nearest, ties to the first", () => {
  // The cases of the Rust test `ownership`: a at corners 0..2, b at 4..8, both rows 0..2, offset (-512, -256).
  const l: IdLayout = { offset: [-512, -256], subterrains: [{ name: "a", x: 0, y: 0, w: 2, h: 2, idRanges: [[1, 9]] }, { name: "b", x: 4, y: 0, w: 4, h: 2, idRanges: [[10, 19]] }] };
  const swapped: IdLayout = { ...l, subterrains: [l.subterrains[1], l.subterrains[0]] };
  for (const [layout, x, y, want] of [
    [l, -400, -100, 0], [l, -512, -256, 0], [l, 0, -1, 1], [l, 511.9, -0.1, 1], [l, -200, -100, 0], [l, -50, -100, 1],
    [l, 2000, 5000, 1], [l, -9000, 0, 0], [l, -128, -100, 0], [swapped, -128, -100, 0], [swapped, -129, -100, 1],
    [l, NaN, NaN, 0], [swapped, Infinity, 0, 0],
  ] as const) assert.equal(ownerOf(layout, x, y), want, `${x}, ${y}`);
  // A position as the file stores it (f32): 128.00000001 is 128 there, which lies in the next rectangle.
  const two: IdLayout = { offset: [0, 0], subterrains: [{ name: "a", x: 0, y: 0, w: 1, h: 1, idRanges: [[1, 9]] }, { name: "b", x: 1, y: 0, w: 1, h: 1, idRanges: [[10, 19]] }] };
  assert.equal(ownerOf(two, 127.99999999, 10), 1);
});

test("split: the lowest free number of the owner's range, skipping every used number map-wide (also ones outside the range)", () => {
  const l = grid();
  assert.equal(allocateNumber("units", [1, 2, 3], {}, l, SW), 10000, "numbers outside the range don't move it");
  assert.equal(allocateNumber("units", [10000, 10001, 10003, 25000], {}, l, SW), 10002, "the lowest free, not one past the highest");
  assert.equal(allocateNumber("units", [10000, 10001, 10003], {}, l, SE), 20000, "another subterrain: its own range");
  assert.equal(allocateNumber("units", [20000, "20001"], {}, l, SE), 20002, "a number as text counts");
  // Handed out before (not in the list yet, or undone): skipped.
  const issued: IssuedNumbers = {};
  assert.deepEqual([0, 1, 2].map(() => allocateNumber("units", [], issued, l, NE)), [40000, 40001, 40002]);
});

test("split: never 0 or 4294967295, even where a range holds them", () => {
  const l: IdLayout = { offset: [0, 0], subterrains: [{ name: "a", x: 0, y: 0, w: 4, h: 4, idRanges: [[0, 2]] }, { name: "b", x: 4, y: 0, w: 4, h: 4, idRanges: [[UNSET - 2, UNSET]] }] };
  assert.equal(allocateNumber("units", [], {}, l, [10, 10]), 1);
  assert.equal(allocateNumber("units", [UNSET - 2], {}, l, [600, 10]), UNSET - 1);
  // b's range full below 4294967295 and nothing above: no number (the caller refuses).
  assert.equal(allocateNumber("units", [UNSET - 2, UNSET - 1], {}, l, [600, 10]), null);
  assert.equal(nextRange(l), null);
});

test("split: a full range takes the next block above every range, kept in the layout, valid and used by later calls", () => {
  const l = grid();
  const full = Array.from({ length: 10000 }, (_, i) => 10000 + i);
  const issued: IssuedNumbers = {};
  assert.equal(allocateNumber("units", full, issued, l, SW), 50000);
  assert.deepEqual(l.subterrains[0].idRanges, [[10000, 19999], [50000, 59999]], "recorded for sw");
  assert.equal(allocateNumber("units", full, issued, l, SW), 50001, "the new range goes on");
  // Another subterrain's full range then goes above that one: ranges never overlap.
  const seFull = Array.from({ length: 10000 }, (_, i) => 20000 + i);
  assert.equal(allocateNumber("doodads", seFull, {}, l, SE), 60000);
  const all = l.subterrains.flatMap((s) => s.idRanges).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < all.length; i++) assert.ok(all[i][0] > all[i - 1][1], JSON.stringify(all));
  // A hand-written top range ending inside a block: the next starts after it, up to the block's end (terrain_ids.rs
  // record_new records the same).
  assert.deepEqual(nextRange({ offset: [0, 0], subterrains: [{ name: "a", x: 0, y: 0, w: 1, h: 1, idRanges: [[10000, 12345]] }] }), [12346, 19999]);
});

test("split: two people placing in different subterrains never hand out one number (two branches merged)", () => {
  const base = [10000, 10001, 20000, 7, 0, 0, UNSET];
  const a = grid(), b = grid();
  const ia: IssuedNumbers = {}, ib: IssuedNumbers = {};
  const fromA = [SW, SW, SW, SW].map((at) => allocateNumber("units", base, ia, a, at));
  const fromB = [SE, NE, SE, NE].map((at) => allocateNumber("units", base, ib, b, at));
  assert.deepEqual(fromA, [10002, 10003, 10004, 10005]);
  assert.deepEqual(fromB, [20001, 40000, 20002, 40001]);
  assert.equal(new Set([...fromA, ...fromB]).size, 8);
  // The control: both in the same subterrain collide (that's what ranges per subterrain prevent).
  assert.equal(allocateNumber("units", base, {}, grid(), SW), allocateNumber("units", base, {}, grid(), SW));
});
