import assert from "node:assert/strict";
import { test } from "node:test";
import { addChance, scaleChances } from "./chances";

// The World Editor's results (we-drive 2026-11-25, SD; docs/testing/numeric-limits-measured.md "Rounding of the
// scaling"): chances before, the line set (from 0), the value typed, the saved chances.
const GROUPS: [number[], number, number, number[]][] = [
  [[17, 17, 16, 17, 17, 16], 0, 25, [25, 15, 15, 15, 15, 15]],
  [[30, 14, 14, 14, 14, 14], 0, 33, [33, 13, 13, 13, 14, 14]],
  [[30, 14, 14, 14, 14, 14], 5, 20, [28, 13, 13, 13, 13, 20]],
  [[100, 0, 0], 1, 40, [60, 40, 0]],
  [[10, 20, 30, 40], 0, 25, [25, 17, 25, 33]],
  [[10, 20, 30, 40], 3, 50, [8, 17, 25, 50]],
  [[1, 1, 1, 97], 3, 99, [0, 0, 1, 99]],
  [[1, 1, 1, 97], 0, 50, [50, 1, 1, 48]],
  [[33, 33, 34], 0, 50, [50, 25, 25]],
  [[5, 5, 5, 5, 80], 4, 90, [3, 3, 2, 2, 90]],
  [[25, 25, 25, 25], 1, 26, [25, 26, 25, 24]],
  [[17, 17, 16, 17, 17, 16], 0, 10, [10, 17, 16, 17, 17, 16]],
  [[100, 0, 0, 0, 0, 0], 0, 40, [40, 0, 0, 0, 0, 0]],
  [[18, 18, 49, 15], 2, 96, [1, 1, 96, 2]],
  [[22, 50, 2, 2, 13, 11], 0, 48, [48, 33, 1, 2, 9, 7]],
  [[19, 70, 1, 10], 3, 84, [3, 12, 1, 84]],
  [[71, 17, 12, 0], 3, 22, [55, 13, 10, 22]],
  [[36, 28, 8, 28], 0, 51, [51, 21, 7, 21]],
  [[27, 6, 65, 0, 1, 1], 0, 94, [94, 0, 5, 0, 0, 1]],
  [[65, 0, 15, 6, 14], 2, 37, [48, 1, 37, 4, 10]],
  [[40, 30, 20, 10], 2, 90, [5, 4, 90, 1]],
  [[7, 11, 13, 17, 19, 33], 5, 50, [5, 8, 10, 13, 14, 50]],
  [[89, 7, 1, 3], 3, 69, [28, 2, 1, 69]],
  [[53, 0, 28, 10, 5, 4], 3, 74, [15, 1, 8, 74, 1, 1]],
  [[18, 26, 0, 31, 19, 6], 3, 51, [13, 18, 1, 51, 13, 4]],
  // measured before (2026-11-25, random-group.w3m): even divisions, typed one after another
  [[34, 33, 33], 0, 50, [50, 25, 25]],
  [[50, 25, 25], 2, 40, [40, 20, 40]],
  [[95, 5, 0], 0, 0, [0, 5, 0]],
  [[0, 5, 0], 1, 100, [0, 100, 0]],
];
// Item tables (Edit Item, New Item): the same rule.
const ITEMS: [number[], number, number, number[]][] = [
  [[17, 17, 16, 17, 17, 16], 0, 25, [25, 15, 15, 15, 15, 15]],
  [[1, 1, 1, 97], 3, 99, [0, 0, 1, 99]],
  [[0, 0, 1, 99, 0], 4, 50, [0, 0, 1, 49, 50]], // a new item typed 50 (it held nothing before)
  [[100, 0], 1, 5, [95, 5]],
  [[95, 5, 0], 2, 1, [94, 5, 1]],
];
// AI Editor hero chances (verification 2026-11-20, bugs.md "WE hero chance rescaling differs"): the total stays 100.
const HEROES: [number[], number, number, number[]][] = [
  [[17, 17, 16, 17, 17, 16], 0, 10, [10, 18, 18, 18, 18, 18]],
  [[30, 14, 14, 14, 14, 14], 0, 33, [33, 13, 13, 13, 14, 14]],
  [[30, 14, 14, 14, 14, 14], 0, 34, [34, 13, 13, 13, 13, 14]],
  [[100, 0, 0, 0, 0, 0], 0, 40, [100, 0, 0, 0, 0, 0]],
];

test("chances: random groups and item sets scale the other lines as the World Editor does", () => {
  for (const [before, i, v, want] of [...GROUPS, ...ITEMS]) {
    const was = before.slice();
    assert.deepEqual(scaleChances(before, i, v, "cap"), want, `${before} [${i}] = ${v}`);
    assert.deepEqual(before, was, "the input is not changed");
  }
});

test("chances: hero chances keep the total at 100 both ways, as the World Editor does", () => {
  for (const [before, i, v, want] of HEROES) assert.deepEqual(scaleChances(before, i, v, "sum100"), want, `${before} [${i}] = ${v}`);
  // control: the old largest-remainder rule (rounding by the remainders, ties to the earlier box) gives other numbers
  assert.notDeepEqual(scaleChances([17, 17, 16, 17, 17, 16], 0, 10, "sum100"), [10, 19, 17, 19, 18, 17]);
});

test("chances: the total stays at 100 and whole, the line set keeps its value", () => {
  for (let n = 2; n <= 8; n++) {
    for (let seed = 1; seed < 400; seed++) {
      const before = Array.from({ length: n }, (_, k) => ((seed * 37 + k * 53 + k * k * seed) % 41));
      const i = seed % n, v = (seed * 7) % 101;
      for (const mode of ["cap", "sum100"] as const) {
        const out = scaleChances(before, i, v, mode);
        const total = out.reduce((a, b) => a + b, 0), was = before.reduce((a, b) => a + b, 0) - before[i] + v;
        assert.ok(out.every((x) => Number.isInteger(x) && x >= 0), `${out}`);
        if (mode === "sum100") assert.equal(total, 100, `${before} [${i}] = ${v}: ${out}`);
        else assert.equal(total, Math.min(was, 100), `${before} [${i}] = ${v}: ${out}`);
        if (out[i] !== v) assert.ok(mode === "sum100" && was === v && v !== 100, "only a hero box alone goes back to 100");
      }
    }
  }
  assert.deepEqual(scaleChances([10, 20], 0, 30, "cap"), [30, 20], "lowering or a total up to 100 moves nothing else");
});

test("chances: a new item enters at 100 and scales the set, or at the value typed (we-drive 2026-11-25)", () => {
  assert.deepEqual(addChance([0, 0, 1, 99], 50), [0, 0, 1, 49, 50]);
  assert.deepEqual(addChance([0, 0, 1, 99]), [0, 0, 0, 0, 100]);
  assert.deepEqual(addChance([]), [100]);
  assert.deepEqual(addChance([100]), [0, 100]);
  const before = [3, 4];
  addChance(before);
  assert.deepEqual(before, [3, 4]);
});
