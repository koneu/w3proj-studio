import assert from "node:assert/strict";
import { test } from "node:test";
import { campGroups, SAME_CAMP } from "./clusters";
import { fixturePath } from "../../lib/testhelpers/testutil";

type P = [number, number];
const at = (p: P) => p;
const sizes = (ps: P[]) => campGroups(ps, at).map((g) => g.length);

test("pairs up to 828 apart are one camp, 832 and more two (measured in the World Editor)", () => {
  assert.equal(SAME_CAMP, 832);
  for (const d of [400, 450, 600, 828]) assert.deepEqual(sizes([[0, 0], [d, 0]]), [2], `${d} apart`);
  for (const d of [832, 1000, 1500]) assert.deepEqual(sizes([[0, 0], [0, d]]), [1, 1], `${d} apart`);
});

test("a creep joins by its distance to the camp's first creep, not transitively", () => {
  // Chain of three 400 apart: the end creeps are 800 apart, so one camp.
  assert.deepEqual(sizes([[-400, 0], [0, 0], [400, 0]]), [3]);
  // Five murlocs: -900 is 600 from the first; -416 is 1084 from it, so it opens a camp; 416 is 832 from that one
  // (two camps), 1200 is 784 from 416.
  const groups = campGroups<P>([[-1500, 0], [-900, 0], [-416, 0], [416, 0], [1200, 0]], at);
  assert.deepEqual(groups.map((g) => g[0][0]), [-1500, -416, 416]);
  assert.deepEqual(groups.map((g) => g.length), [2, 1, 2]);
  // Control: a linked chain (each within 832 of the next) would make one camp.
  assert.deepEqual(sizes([[0, 0], [700, 0], [1400, 0], [2100, 0]]), [2, 2]);
});

// The World Editor's camp icons on the synthetic maps of tests/fixtures/we-specs (make-camps.mjs c, d, e, f; icons read
// off its minimap, camps-icons-we.json): the camps' icon creeps are the first creep of each group, diagonals by
// straight distance.
test("camp icons as the World Editor shows them: diagonals, chains in every order, edge of 832", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = fixturePath("we-specs");
  const measured = JSON.parse(readFileSync(join(dir, "camps-icons-we.json"), "utf8"));
  let checked = 0;
  for (const m of ["c", "d", "e", "f"]) {
    const layout: P[][] = JSON.parse(readFileSync(join(dir, `camps-${m}.layout.json`), "utf8"));
    layout.forEach((creeps, i) => {
      const icons = campGroups(creeps.map((p, k) => ({ p, k })), (c) => c.p).map((g) => g[0].k);
      assert.deepEqual(icons, measured[m][i], `map ${m} case ${i}`);
      checked++;
    });
  }
  assert.equal(checked, 36);
  // Control: the check can fail: a limit of 600 (the old 450 was off by more) breaks the diagonal cases.
  const strict = campGroups([[0, 0], [600, 600]] as P[], at).length;
  assert.equal(strict, 2);
  assert.equal(campGroups([[0, 0], [588, 588]] as P[], at).length, 1);
});
