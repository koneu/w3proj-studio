import assert from "node:assert/strict";
import { test } from "node:test";
import { matchCliffTypes, rampClick, rampSides, slopeBand, toggleRamp, widestRun } from "./cliffs";
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
  // The one known deviation from the World Editor's picture: corner 7,4 (every other corner of the 210 matches).
  assert.deepEqual(wrong, ["7,4"], `${wrong.length} corners differ of ${w * h}`);
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

test("the band stays inside the brush, and a drag paints the rest", () => {
  const cells = ring.map((r) => r.match(/\d\*?/g) as string[]);
  const flat = () => land(cells.map((r) => r.map((c) => c[0]).join("")));
  const small = slopeBand(flat(), 3, 6, 2);
  assert.ok(small.length >= 4 && small.length < slopeBand(flat(), 3, 6, 20).length);
  for (const [x, y] of small) assert.ok(Math.abs(x - 3) <= 3 && Math.abs(y - 6) <= 3, `${x},${y}`);
  const t = flat();
  for (const at of [2, 6, 10]) for (const [x, y] of slopeBand(t, 3, at, 2)) t.corners[y * t.width + x].ramp = true;
  assert.ok(t.corners.filter((c) => c.ramp).length > small.length);
});

test("one click takes off a long ramp, however far it runs", () => {
  const t = bend();
  for (const [x, y] of slopeBand(t, 7, 4, 3)) t.corners[y * t.width + x].ramp = true;
  const flagged = t.corners.filter((c) => c.ramp);
  assert.ok(flagged.length > 10);
  assert.equal(toggleRamp(t, 7.5 * 128, 4.5 * 128, 1, log, true), null);
  assert.equal(t.corners.some((c) => c.ramp), false, ramps(t).join("\n"));
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

// The east edge of a round +1 plateau (size 7): straight, but for one corner in its middle that sticks out
// (level 3 at x 5, y 5). A ramp beside it would end next to that bend, where its side piece can't meet the cliff:
// a hole in the ground, black from the side (verification of a44f02c87c, 2026-11-14). The World Editor draws a
// hole there too with those flags.
const bump = () => land([
  "3333222",
  "3333222",
  "3333222",
  "3333322",
  "3333222",
  "3333222",
  "3333222",
  "3333222",
  "3333222",
]);

test("a ramp doesn't end beside a corner sticking out of the cliff, so its side pieces meet the cliff", () => {
  const t = bump();
  assert.equal(toggleRamp(t, 3.6 * 128, 3.6 * 128, 3, log, true), null);
  assert.deepEqual(ramps(t), [
    ".......",
    ".......",
    ".......",
    ".......",
    ".......",
    "...###.",
    "...###.",
    "...###.",
    ".......",
  ], "the row beside the bend stays a cliff");
  // Every ramp side the view draws has its far middle corner on the ramp's low layer, as a straight cliff does.
  for (const side of rampSides(t)) {
    const far = side.w === 2
      ? t.corners[(side.outer[1].ramp ? side.y : side.y + 1) * t.width + side.x + 1]
      : t.corners[(side.y + 1) * t.width + (side.outer[0].ramp ? side.x + 1 : side.x)];
    assert.equal(far.layer, 2, `side at ${side.x},${side.y}`);
  }
  // Asked for exactly that width, the ramp is refused rather than built against the bend.
  const strict = bump();
  assert.match(toggleRamp(strict, 3.6 * 128, 2.6 * 128, 1, log) ?? "", /straight/);
  assert.equal(strict.corners.some((c) => c.ramp), false);
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

// The World Editor's size-5 Apply Cliff Increase One plateau (one click on the blank 64x64 map, spec ramp-wpm), as
// it saves it: per row (y from 34 down to 26) the corners on level 3, x from..to. Here x 26..38 and y 23..36.
const roundPlateau = () => {
  const spans: Record<number, [number, number]> = { 34: [32, 32], 33: [30, 34], 32: [29, 35], 31: [29, 35], 30: [28, 36], 29: [29, 35], 28: [29, 35], 27: [30, 34], 26: [32, 32] };
  const rows: string[] = [];
  for (let y = 36; y >= 23; y--) {
    let r = "";
    for (let x = 26; x <= 38; x++) r += spans[y] && x >= spans[y][0] && x <= spans[y][1] ? "3" : "2";
    rows.push(r);
  }
  return land(rows);
};
/** The flagged corners, as "x,y" in the map's corners (the window's offset added back). */
const flagged = (t: Terrain, ox = 0, oy = 0) => t.corners.flatMap((c, i) => (c.ramp ? [`${(i % t.width) + ox},${Math.floor(i / t.width) + oy}`] : []));
/** The middle of the corner (x, y) of the round plateau's window, in world units, and a bit off it. */
const atCorner = (x: number, y: number, ox = 0, oy = 0): [number, number] => [(x - 26 + ox) * 128, (y - 23 + oy) * 128];

test("a Ramp click flags the line of three corners down the cliff from the nearest corner, as the World Editor does", () => {
  // The World Editor on its round plateau (we-drive 2026-11-14, spec ramp-wpm): its click at 653,622 lands nearest
  // corner 30,27 and flags 30,27, 30,26 and 30,25, whatever the brush size; the line to the left (30,27 to 28,27)
  // doesn't fit, as the cliff bends beside it (29,28 is high).
  for (const off of [[0, 0], [0.3, 0.2], [-0.4, -0.45]]) {
    const t = roundPlateau();
    assert.deepEqual(rampClick(t, ...atCorner(30, 27, off[0], off[1]), log), { done: "built" });
    assert.deepEqual(flagged(t, 26, 23), ["30,25", "30,26", "30,27"], `off ${off}`);
  }
  // The corner below the high one: the same line.
  const mid = roundPlateau();
  assert.equal(rampClick(mid, ...atCorner(30, 26), log).done, "built");
  assert.deepEqual(flagged(mid, 26, 23), ["30,25", "30,26", "30,27"]);
  // Beside the corner that sticks out at 32,26 nothing fits (its clicks at 680..730, 622 did nothing), nor on the
  // plateau or the low ground further out.
  for (const [x, y] of [[31, 27], [33, 27], [32, 27], [30, 28], [30, 25], [27, 24]]) {
    const t = roundPlateau();
    const r = rampClick(t, ...atCorner(x, y), log);
    assert.equal(r.done, "none", `${x},${y}`);
    assert.ok(r.problem, `${x},${y} says why`);
    assert.deepEqual(flagged(t), [], `${x},${y}`);
  }
});

// The plateau of tests/fixtures/we-specs/plateau.w3x, cut down: level 3 at x 2..10, y 3..7 of a 15x10 window.
const rect = () => land([
  "222222222222222",
  "222222222222222",
  "223333333332222",
  "223333333332222",
  "223333333332222",
  "223333333332222",
  "223333333332222",
  "222222222222222",
  "222222222222222",
  "222222222222222",
]);

test("on a straight edge each click is one line, on a plateau's corner a 3x3 block, a drag a wider ramp", () => {
  // The World Editor's clicks along plateau.w3x's south face flag one line each (p-row-a..c, p-s1, p-s3, p-s8), on
  // its corners the lines down both faces and the corners between (p-corner-bl, p-corner-br), on the west face a
  // line westwards (p-left-360).
  const t = rect();
  assert.equal(rampClick(t, 5 * 128, 3 * 128, log).done, "built");
  assert.deepEqual(flagged(t), ["5,1", "5,2", "5,3"]);
  assert.equal(rampClick(t, 6.4 * 128, 2.4 * 128, log, true).done, "built", "the next line, from the middle corner");
  assert.deepEqual(flagged(t), ["5,1", "6,1", "5,2", "6,2", "5,3", "6,3"]);
  const c = rect();
  assert.equal(rampClick(c, 2 * 128, 3 * 128, log).done, "built");
  assert.deepEqual(flagged(c), ["0,1", "1,1", "2,1", "0,2", "1,2", "2,2", "0,3", "1,3", "2,3"]);
  const w = rect();
  assert.equal(rampClick(w, 2 * 128, 5 * 128, log).done, "built");
  assert.deepEqual(flagged(w), ["0,5", "1,5", "2,5"]);
  const n = rect();
  assert.equal(rampClick(n, 7 * 128, 7 * 128, log).done, "built");
  assert.deepEqual(flagged(n), ["7,7", "7,8", "7,9"]);
  // A drag over what's built adds nothing and takes nothing off; a click on it takes the ramp off (the World Editor
  // leaves it: p-twice).
  assert.deepEqual(rampClick(t, 5 * 128, 3 * 128, log, true), { done: "none" });
  assert.equal(flagged(t).length, 6);
  assert.deepEqual(rampClick(t, 5 * 128, 3 * 128, log), { done: "removed" });
  assert.deepEqual(flagged(t), []);
  // A cliff two levels high has no ramp.
  const tall = land(["4444", "4444", "2222", "2222", "2222"]);
  assert.match(rampClick(tall, 128, 3 * 128, log).problem ?? "", /higher/);
  assert.deepEqual(flagged(tall), []);
});

/** A 12x12 window with a 45-degree one-level cliff: level 3 where `high(x, y)`, 2 elsewhere. */
const stairs = (high: (x: number, y: number) => boolean) => land(Array.from({ length: 12 }, (_, n) => {
  const y = 11 - n;
  return Array.from({ length: 12 }, (_, x) => (high(x, y) ? "3" : "2")).join("");
}));
/** Every run of flags along x or y climbs at most one level, one way (no tile across two levels, no 2,3,2). */
const climbsOnce = (t: Terrain) => {
  for (const [dx, dy] of [[1, 0], [0, 1]]) for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const ls: number[] = [];
    for (let k = 0; x + k * dx < t.width && y + k * dy < t.height && t.corners[(y + k * dy) * t.width + x + k * dx].ramp; k++) ls.push(t.corners[(y + k * dy) * t.width + x + k * dx].layer);
    if (ls.length < 2) continue;
    assert.ok(Math.max(...ls) - Math.min(...ls) <= 1, `run from ${x},${y} along ${dx},${dy}: ${ls}`);
    assert.ok(ls.every((l, k) => !k || l >= ls[k - 1]) || ls.every((l, k) => !k || l <= ls[k - 1]), `run from ${x},${y} along ${dx},${dy} goes up and down: ${ls}`);
  }
};

test("a Ramp click on a diagonal cliff builds the corners of its cliff tiles round the corner, in each of its four turns", () => {
  // Level 3 to the south-west of x + y = 10; corner 5,5 is a step of it, 6,5 the low step beside it.
  const sw = () => stairs((x, y) => x + y <= 10);
  const t = sw();
  assert.deepEqual(rampClick(t, 5 * 128 + 20, 5 * 128 - 30, log), { done: "built" });
  assert.deepEqual(ramps(t), [
    "............",
    "............",
    "............",
    "............",
    ".....##.....",
    "....####....",
    "....####....",
    ".....##.....",
    "............",
    "............",
    "............",
    "............",
  ]);
  climbsOnce(t);
  const low = sw();
  assert.equal(rampClick(low, 6 * 128, 5 * 128, log).done, "built", "the low step");
  climbsOnce(low);
  // The four turns of the cliff: the same piece, turned.
  for (const [name, high, [x, y]] of [
    ["north-east", (x: number, y: number) => x + y >= 12, [6, 6]],
    ["north-west", (x: number, y: number) => y - x >= 1, [4, 5]],
    ["south-east", (x: number, y: number) => x - y >= 1, [5, 4]],
  ] as const) {
    const k = stairs(high);
    assert.equal(rampClick(k, x * 128, y * 128, log).done, "built", name);
    assert.equal(flagged(k).length, flagged(t).length, `${name}: as many corners`);
    climbsOnce(k);
  }
  // A drag down the diagonal (a click at each corner it passes) joins the pieces into one ramp; a click takes it off.
  const d = sw();
  for (let x = 3; x <= 7; x++) assert.equal(rampClick(d, x * 128, (10 - x) * 128, log, true).done, "built", `drag at ${x}`);
  climbsOnce(d);
  for (let x = 3; x <= 7; x++) assert.ok(d.corners[(10 - x) * d.width + x].ramp && d.corners[(10 - x) * d.width + x + 1].ramp, `the high and low step at ${x}`);
  assert.equal(rampClick(d, 5 * 128, 5 * 128, log).done, "removed");
  assert.deepEqual(flagged(d), []);
  // Not a step: the plateau, and the low ground off the cliff (two corners out, far out).
  for (const [x, y] of [[3, 3], [9, 9], [7, 5]]) assert.equal(rampClick(sw(), x * 128, y * 128, log).done, "none", `${x},${y}`);
});

test("a Ramp drag down Last Refuge's diagonal cliff flags about what its ramp has", () => {
  // smoketest_maps/blizzard/(2)LastRefuge_S2_v1.5.w3x, corners x 22-38, y 25-30 (wholemap.test.ts LAST_REFUGE): the
  // levels as the map has them, the flags taken off, then a drag down the cliff's high edge.
  const rows = [
    "2. 2. 2. 2. 2. 2. 2. 2r 2r 2r 3r 3. 3. 2. 2. 2. 2.",
    "2. 2. 2. 2. 2. 2. 2. 2r 2r 2r 3r 3. 3. 2. 2. 2. 2.",
    "2. 2. 2. 2. 2. 2r 2r 2r 2r 3r 3r 3. 3. 3. 2. 2. 2.",
    "2. 2. 2. 2. 2. 2r 2r 2r 3r 3r 3. 3. 3. 3. 2. 2. 2.",
    "2. 2. 2. 2. 2. 2r 2r 3r 3r 3. 3. 3. 3. 3. 3. 2. 2.",
    "2. 2. 2. 2. 2. 2r 2r 3r 3. 3. 3. 3. 3. 3. 3. 2. 2.",
  ].map((r) => r.split(" "));
  const t = land(rows.map((r) => r.map((c) => c[0]).join("")));
  const map = new Set(rows.flatMap((r, n) => r.flatMap((c, k) => (c[1] === "r" ? [`${k},${rows.length - 1 - n}`] : []))));
  // The high edge, x 22-38 → 0-16, y 25-30 → 0-5: the first level-3 corner of each row.
  for (let y = 0; y < t.height; y++) {
    const x = t.corners.slice(y * t.width, (y + 1) * t.width).findIndex((c) => c.layer === 3);
    rampClick(t, x * 128, y * 128, log, true);
  }
  climbsOnce(t);
  const ours = new Set(flagged(t));
  const both = [...ours].filter((k) => map.has(k)).length;
  assert.ok(both >= 0.75 * map.size && ours.size <= map.size * 1.25, `${both} of the map's ${map.size} flags, ${ours.size} in all`);
});

test("a click on a ramp still takes it off", () => {
  const t = edge();
  toggleRamp(t, 3 * 128, 2.5 * 128, 2, log, true);
  assert.ok(t.corners.some((c) => c.ramp));
  toggleRamp(t, 3 * 128, 2.5 * 128, 2, log, true);
  assert.equal(t.corners.some((c) => c.ramp), false);
});

test("cliff types follow a list longer than two; a number past 14 isn't written (15 is reserved, 16 doesn't fit)", () => {
  const typed = (fixed: number | undefined, cliffGround: string[]) => {
    // One cliff tile: all four corners take its type.
    const t = land(["33", "22"]);
    t.groundTiles = ["Ldrt", "Ydrt"];
    for (const c of t.corners) Object.assign(c, { texture: 1, cliffTexture: 15 });
    matchCliffTypes(t, t.corners.map((_, i) => i), cliffGround, log, fixed);
    return t.corners.map((c) => c.cliffTexture);
  };
  const list = ["Ldrt", "Lgrs", "Adrt"];
  assert.ok(typed(2, list).every((n) => n === 2), "the chosen third type");
  // TurtleRock's list has 17 entries: CYdi (Ydrt) at 15, CYsq at 16.
  const long = [...Array.from({ length: 15 }, (_, i) => `X${String(i).padStart(3, "0")}`), "Ydrt", "Ysqd"];
  assert.ok(typed(undefined, long).every((n) => n === 15), "Match the ground with its cliff at 15 leaves the corners");
  assert.ok(typed(16, long).every((n) => n === 15), "a chosen 16 is left out too");
  assert.ok(typed(undefined, [...long.slice(0, 14), "Ydrt"]).every((n) => n === 14), "control: at 14 it is written");
});
