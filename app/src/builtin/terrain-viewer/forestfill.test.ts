import assert from "node:assert/strict";
import { test } from "node:test";
import { forestPlan, joinEdges, type Anchor } from "./forestfill";
import { checkPath, type Grid } from "./pathcheck";

/** A map of 128 x 128 cells round 0 (4096 across), with what `wall` blocks. */
function grid(wall: (x: number, y: number) => boolean = () => false): Grid {
  const width = 128, height = 128, offsetX = -2048, offsetY = -2048, blocked = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (wall(offsetX + (x + 0.5) * 32, offsetY + (y + 0.5) * 32)) blocked[y * width + x] = 1;
  return { blocked, width, height, offsetX, offsetY };
}
const A: Anchor = { name: "west base", at: [-1400, 0] }, B: Anchor = { name: "east base", at: [1400, 0] }, C: Anchor = { name: "shop", at: [0, 1400] };
const near = (p: readonly number[], q: readonly number[], r: number) => Math.hypot(p[0] - q[0], p[1] - q[1]) < r;
const kept = (anchors: Anchor[]) => (x: number, y: number) => anchors.some((a) => near([x, y], a.at, 400));
const all = () => true;

test("the kept places are joined by the smallest tree, not each to each", () => {
  assert.deepEqual(joinEdges([A]), []);
  assert.equal(joinEdges([A, B, C]).length, 2);
  // The long side (west to east, 2,800) is left out: both reach the shop (1,980 each).
  assert.deepEqual(joinEdges([A, B, C]).map((e) => e.join()).sort(), ["0,2", "2,1"]);
});

test("forest fills what isn't kept, and a way stays free between the kept places", () => {
  const g = grid();
  const plan = forestPlan(g, { anchors: [A, B], kept: kept([A, B]), inside: all, ways: 384, spacing: 128 });
  assert.deepEqual(plan.unreached, []);
  assert.deepEqual(plan.ways.map((w) => [w.from, w.to]), [["west base", "east base"]]);
  assert.ok(plan.ways[0].length > 2700 && plan.ways[0].length < 3100, String(plan.ways[0].length));
  // Most of the map is forest: 1,024 spots less the two clearings and the way.
  assert.ok(plan.spots.length > 800 && plan.spots.length < 980, String(plan.spots.length));
  assert.ok(plan.spots.every((s) => !near([s.x, s.y], A.at, 400) && !near([s.x, s.y], B.at, 400)), "the kept places are free");
  // On the grid of the spacing, a tree's own cells.
  assert.ok(plan.spots.every((s) => (s.x - 64) % 128 === 0 && (s.y - 64) % 128 === 0));
  // The way: with the planned trees standing, a unit still walks from base to base, and the way is as wide as asked.
  const planted = grid((x, y) => plan.spots.some((s) => Math.abs(s.x - x) < 64 && Math.abs(s.y - y) < 64));
  const walk = checkPath(planted, A.at, B.at, 32);
  assert.equal(walk.walkable, true);
  assert.ok((walk.narrowest?.width ?? 0) >= 384, `the way's tightest place is ${walk.narrowest?.width} wide`);
  // Without ways nothing joins them: islands of clearing in forest.
  const closed = forestPlan(g, { anchors: [A, B], kept: kept([A, B]), inside: all, ways: 0, spacing: 128 });
  assert.deepEqual([closed.ways, closed.unreached], [[], []]);
  assert.ok(closed.spots.length > plan.spots.length);
  const sealed = grid((x, y) => closed.spots.some((s) => Math.abs(s.x - x) < 64 && Math.abs(s.y - y) < 64));
  assert.equal(checkPath(sealed, A.at, B.at, 32).walkable, false);
});

test("a kept place no way on foot reaches is named, and nothing stands on blocked ground or past the playable map", () => {
  // A river down the middle.
  const g = grid((x) => Math.abs(x) < 96);
  const plan = forestPlan(g, { anchors: [A, B], kept: kept([A, B]), inside: (_x, y) => Math.abs(y) < 1500, ways: 384, spacing: 128 });
  assert.deepEqual(plan.ways, []);
  assert.deepEqual(plan.unreached, ["west base", "east base"]);
  assert.ok(plan.spots.length > 300);
  assert.ok(plan.spots.every((s) => Math.abs(s.x) >= 96 && Math.abs(s.y) < 1500));
});

test("with a twin both halves come out alike", () => {
  // A wall that stands on one side only: its twin spot stays empty too.
  const g = grid((x, y) => x > 600 && x < 900 && y > 600 && y < 900);
  const twin = (x: number, y: number): [number, number] => [-x, -y];
  const plan = forestPlan(g, { anchors: [A, B], kept: kept([A, B]), inside: all, ways: 384, spacing: 128, twin });
  const key = (x: number, y: number) => `${x},${y}`;
  const set = new Set(plan.spots.map((s) => key(s.x, s.y)));
  assert.ok(plan.spots.length > 600);
  assert.ok(plan.spots.every((s) => set.has(key(-s.x, -s.y))), "every spot's twin is planted too");
  assert.ok(!set.has(key(-704, -704)), "the twin of the walled place stays empty");
  // A playable map that ends sooner in the north: the south's strip beyond its twin is planted all the same.
  const lop = forestPlan(grid(), { anchors: [A, B], kept: kept([A, B]), inside: (_x, y) => y < 1500, ways: 384, spacing: 128, twin });
  assert.ok(lop.spots.some((s) => s.y < -1500), "the strip whose twin is past the map");
  assert.ok(lop.spots.every((s) => s.y < 1500));
});
