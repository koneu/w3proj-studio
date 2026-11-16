import assert from "node:assert/strict";
import { test } from "node:test";
import { campGroups, SAME_CAMP } from "./clusters";

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
