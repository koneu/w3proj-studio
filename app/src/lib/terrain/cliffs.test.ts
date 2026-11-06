import assert from "node:assert/strict";
import { test } from "node:test";
import { slopeBand, toggleRamp, widestRun } from "./cliffs";
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

// A ramp the World Editor built right round the inside of a plateau: levels, and * for its flags.
const ring = [
  "3 3 3 3 3 3 3 3 3 3 3 3 3 3 3",
  "3 3 3 3 3 3*3*3*3*3*3*3 3 3 3",
  "3 3 3 3 3*3*2*2*2*2*3*3*3 3 3",
  "3 3 3 3*3*2*2*2*2*2*2*3*3*3 3",
  "3 3 3*3*2*2*2*2 2 2*2*2*3*3*3",
  "3 3 3*2*2*2*2 2 2 2 2*2*2*3*3",
  "3 3 3*2*2*2 2 2 2 2 2 2*2*3*3",
  "3 3 3*2*2*2 2 2 2 2 2 2*2*3*3",
  "3 3 3*2*2*2*2 2 2 2 2*2*2*3*3",
  "3 3 3*3*2*2*2*2*2 2*2*2*3*3*3",
  "3 3 3 3*3*2*2*2*2*2*2*3*3*3 3",
  "3 3 3 3 3*3*2*2*2*2*3*3*3 3 3",
  "3 3 3 3 3 3*3*3*3*3*3*3 3 3 3",
  "3 3 3 3 3 3 3 3 3 3 3 3 3 3 3",
];

test("a bending ramp is flagged as the World Editor does", () => {
  const cells = ring.map((r) => r.match(/\d\*?/g) as string[]), h = cells.length, w = cells[0].length;
  const t = land(cells.map((r) => r.map((c) => c[0]).join("")));
  const band = new Set(slopeBand(t, 3, 6, 20).map(([x, y]) => `${x},${y}`));
  const wrong: string[] = [];
  cells.forEach((row, n) => row.forEach((c, x) => {
    if (band.has(`${x},${h - 1 - n}`) !== (c.length > 1)) wrong.push(`${x},${h - 1 - n}`);
  }));
  assert.ok(wrong.length <= 1, `${wrong.length} corners differ of ${w * h}: ${wrong.join(" ")}`);
});

// A diagonal that runs into a long straight edge on its way east.
const bend = () => land([
  "333333333333333",
  "333333333333333",
  "333333333333333",
  "333333333222222",
  "333333322222222",
  "333332222222222",
  "333222222222222",
  "222222222222222",
  "222222222222222",
  "222222222222222",
].concat([]));

test("a small brush stops once the cliff runs straight, a big one goes further", () => {
  const steep = land([
    "33333333333333333333",
    "33333333333333333333",
    "33333333333333333322",
    "33333333332222222222",
    "33333333322222222222",
    "33333333222222222222",
    "22222222222222222222",
    "22222222222222222222",
    "22222222222222222222",
  ]);
  const small = slopeBand(steep, 8, 3, 1), whole = slopeBand(steep, 8, 3, 30);
  assert.ok(small.length >= 4 && small.length < whole.length, `${small.length} of ${whole.length}`);
});

test("with no straight stretch to end on, a ramp goes the whole way round", () => {
  const cells = ring.map((r) => r.match(/\d\*?/g) as string[]);
  const flat = () => land(cells.map((r) => r.map((c) => c[0]).join("")));
  assert.equal(slopeBand(flat(), 3, 6, 1).length, slopeBand(flat(), 3, 6, 20).length);
});

test("one click takes off a long ramp, however far it runs", () => {
  const t = bend();
  for (const [x, y] of slopeBand(t, 7, 4, 1)) t.corners[y * t.width + x].ramp = true;
  const flagged = t.corners.filter((c) => c.ramp);
  assert.ok(flagged.length > 10);
  assert.equal(toggleRamp(t, 7.5 * 128, 4.5 * 128, 1, log, true), null);
  assert.equal(t.corners.some((c) => c.ramp), false, ramps(t).join("\n"));
});

test("with no straight stretch at all, a ramp goes the whole way round", () => {
  // A diamond: nothing but diagonal edges.
  const diamond = () => land([
    "22222222",
    "22233222",
    "22333322",
    "23333332",
    "23333332",
    "22333322",
    "22233222",
    "22222222",
  ]);
  assert.equal(slopeBand(diamond(), 2, 2, 1).length, slopeBand(diamond(), 2, 2, 20).length);
});

test("on a long cliff the ramp ends at the first straight stretch past the bend, not at the far end of the map", () => {
  const t = land([
    "3333333333",
    "3333333333",
    "3333333333",
    "3333333322",
    "3333332222",
    "3333322222",
    "3332222222",
    "2222222222",
    "2222222222",
    "2222222222",
  ].map((r) => r));
  const band = slopeBand(t, 5, 4, 1);
  assert.ok(band.length > 4);
  assert.deepEqual(slopeBand(land(["2222", "2222", "2222"]), 1, 1, 2), [], "no cliff, no ramp");
  const lows = band.filter(([x, y]) => t.corners[y * t.width + x].layer === 2);
  const highs = band.filter(([x, y]) => t.corners[y * t.width + x].layer === 3);
  assert.ok(lows.length && highs.length);
});

test("a diagonal cliff gets a ramp from the brush, on both of its levels", () => {
  const t = land([
    "33333222",
    "33332222",
    "33322222",
    "33222222",
    "32222222",
    "22222222",
  ]);
  assert.equal(toggleRamp(t, 3.5 * 128, 2.5 * 128, 2, log, true), null);
  const flagged = t.corners.filter((c) => c.ramp);
  assert.ok(flagged.some((c) => c.layer === 3) && flagged.some((c) => c.layer === 2), ramps(t).join(" "));
  assert.equal(toggleRamp(land(["2222", "2222"]), 128, 64, 1, log, true) !== null, true);
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

test("a drag adds to a ramp, along the cliff, and going back over it takes nothing away", () => {
  const t = land([
    "333333333333",
    "333333333333",
    "333333333333",
    "222222222222",
    "222222222222",
    "222222222222",
  ]);
  const at = (x: number) => toggleRamp(t, x * 128, 2.5 * 128, 1, log, true, true);
  assert.equal(at(3), null);
  const one = t.corners.filter((c) => c.ramp).length;
  at(5);
  at(7);
  const more = t.corners.filter((c) => c.ramp).length;
  assert.ok(more > one, `${one} then ${more}`);
  at(5);
  at(3);
  assert.equal(t.corners.filter((c) => c.ramp).length, more);
});

test("a click on a ramp still takes it off", () => {
  const t = edge();
  toggleRamp(t, 3 * 128, 2.5 * 128, 2, log, true);
  assert.ok(t.corners.some((c) => c.ramp));
  toggleRamp(t, 3 * 128, 2.5 * 128, 2, log, true);
  assert.equal(t.corners.some((c) => c.ramp), false);
});
