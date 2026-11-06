import assert from "node:assert/strict";
import { test } from "node:test";
import { toggleRamp, widestRun } from "./cliffs";
import type { Corner, Terrain } from "./w3e";

/** Rows from the north, a digit per corner: its cliff level. */
function land(rows: string[]): Terrain {
  const height = rows.length, width = rows[0].length;
  const corners: Corner[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    corners.push({ layer: Number(rows[height - 1 - y][x]), ramp: false } as Corner);
  }
  return { width, height, offsetX: 0, offsetY: 0, corners } as Terrain;
}
const log = { touch() { /* undo isn't looked at here */ } };
const ramps = (t: Terrain) => Array.from({ length: t.height }, (_, n) => {
  const y = t.height - 1 - n;
  return t.corners.slice(y * t.width, (y + 1) * t.width).map((c) => (c.ramp ? "#" : ".")).join("");
});

test("the widest stretch that fits, nearest the middle", () => {
  assert.deepEqual(widestRun([true, true, true, true, true], 2), [0, 4]);
  assert.deepEqual(widestRun([false, true, true, true, false], 2), [1, 3]);
  assert.deepEqual(widestRun([false, false, false, true, true], 2), [3, 4], "the click needn't be on it");
  assert.deepEqual(widestRun([true, true, false, true, true, true], 2), [3, 5], "as near, and longer");
  assert.equal(widestRun([false, true, false, true, false], 2), null, "a single row is no ramp");
  assert.equal(widestRun([false, false], 0), null);
});

// A straight east-west cliff, level 3 in the north, that stops being straight on the east side.
const edge = () => land([
  "33333333",
  "33333333",
  "33333322",
  "22222222",
  "22222222",
  "22222222",
]);

test("a straight ramp in the old way is the width asked for or nothing", () => {
  const t = edge();
  const why = toggleRamp(t, 4.2 * 128, 2.5 * 128, 3, log);
  assert.match(why ?? "", /Size/);
  assert.equal(t.corners.some((c) => c.ramp), false, "nothing done");
});

test("the brush builds as wide as fits", () => {
  const t = edge();
  assert.equal(toggleRamp(t, 3 * 128, 2.5 * 128, 3, log, true), null);
  assert.deepEqual(ramps(t), [
    "........",
    "........",
    "######..",
    "######..",
    "######..",
    "........",
  ]);
});

// A plateau's corner: the edge turns from east-west to north-south.
const corner = () => land([
  "33332222",
  "33332222",
  "33332222",
  "22222222",
  "22222222",
  "22222222",
  "22222222",
]);

test("near a corner the brush uses the straight part beside it; the strict way refuses", () => {
  const strict = corner();
  assert.ok(toggleRamp(strict, 3.5 * 128, 3.5 * 128, 1, log));
  assert.equal(strict.corners.some((c) => c.ramp), false);
  const t = corner();
  assert.equal(toggleRamp(t, 3.5 * 128, 3.5 * 128, 1, log, true), null);
  assert.ok(t.corners.some((c) => c.ramp));
});

test("a true diagonal is refused, not built badly: real maps flag those in a way not worked out yet", () => {
  const t = land([
    "33333222",
    "33332222",
    "33322222",
    "33222222",
    "32222222",
    "22222222",
  ]);
  assert.ok(toggleRamp(t, 3.5 * 128, 2.5 * 128, 2, log, true));
  assert.equal(t.corners.some((c) => c.ramp), false);
});

test("the brush takes off what it built, in one click", () => {
  const t = edge();
  toggleRamp(t, 3 * 128, 2.5 * 128, 3, log, true);
  assert.equal(toggleRamp(t, 3 * 128, 2.5 * 128, 3, log, true), null);
  assert.equal(t.corners.some((c) => c.ramp), false);
});

test("flat ground and tall cliffs still have nothing for a ramp", () => {
  assert.ok(toggleRamp(land(["2222", "2222", "2222", "2222"]), 128, 128, 2, log, true));
  const tall = land(["4444", "4444", "2222", "2222"]);
  assert.ok(toggleRamp(tall, 1.5 * 128, 1.5 * 128, 2, log, true));
  assert.equal(tall.corners.some((c) => c.ramp), false);
});
