import assert from "node:assert/strict";
import { test } from "node:test";
import { findSpots, type SpotFacts } from "./meleespots";
import { narrowStrips, widestFrom, widthOf, type Grid } from "./pathcheck";

type Point = [number, number];
/** A square map of 256 × 256 cells around 0, walled at its edge, with what `wall` blocks. */
function grid(wall: (x: number, y: number) => boolean = () => false): Grid {
  const width = 256, height = 256, offsetX = -4096, offsetY = -4096, blocked = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const wx = offsetX + (x + 0.5) * 32, wy = offsetY + (y + 0.5) * 32;
    if (x < 4 || y < 4 || x >= width - 4 || y >= height - 4 || wall(wx, wy)) blocked[y * width + x] = 1;
  }
  return { blocked, width, height, offsetX, offsetY };
}
const whole = { left: -4096, bottom: -4096, right: 4096, top: 4096 };
const starts: Point[] = [[-3000, -3000], [3000, 3000]];
const facts = (g: Grid, more: Partial<SpotFacts> = {}): SpotFacts => ({ grid: g, widest: widestFrom(g, starts[0]), starts, mines: [], camps: [], routes: [], whole, ...more });
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test("the widest way through a gap is the gap's width", () => {
  const g = grid((x, y) => Math.abs(x) < 64 && Math.abs(y) > 112);
  const best = widestFrom(g, [-3000, 0]);
  const i = Math.floor((0 + 4096) / 32) * g.width + Math.floor((2000 + 4096) / 32);
  const width = widthOf(best[i]);
  assert.ok(width >= 160 && width <= 256, String(width));
  const open = widestFrom(grid(), [-3000, 0]);
  assert.ok(widthOf(open[i]) > 2000);
});

test("nothing reaches sealed ground", () => {
  const g = grid((x, y) => Math.abs(x - 2000) < 80 + 0 && Math.abs(y) < 1000 || Math.abs(y) < 1000 && Math.abs(Math.abs(y) - 1000) < 0);
  const sealed = grid((x, y) => Math.hypot(x - 2000, y) > 500 && Math.hypot(x - 2000, y) < 700);
  const best = widestFrom(sealed, [-3000, 0]);
  assert.equal(best[Math.floor(4096 / 32) * sealed.width + Math.floor(6096 / 32)], 0);
  assert.ok(g.blocked.length > 0);
});

test("camp spots keep the distances, and don't sit on what's there", () => {
  const route: Point[] = [[-3000, -3000], [3000, 3000]];
  const mines: Point[] = [[-3000, -2224], [3000, 2224]];
  const camps: Point[] = [[2500, -2500]];
  const { spots } = findSpots("camp", facts(grid(), { routes: [route], mines, camps }), 8, false);
  assert.ok(spots.length >= 3);
  for (const s of spots) {
    for (const p of starts) assert.ok(dist(s.at, p) >= 1900);
    for (const m of mines) assert.ok(dist(s.at, m) >= 900);
    assert.ok(dist(s.at, camps[0]) >= 1100);
    assert.ok((s.fromRoute ?? 0) >= 800);
  }
  for (const a of spots) for (const b of spots) if (a !== b) assert.ok(dist(a.at, b.at) >= 1100, "each can take a camp");
});

test("a pocket beats open ground", () => {
  const pocket = grid((x, y) => {
    const dx = x + 2500, dy = y - 2500;
    return Math.max(Math.abs(dx), Math.abs(dy)) > 560 && Math.max(Math.abs(dx), Math.abs(dy)) < 800 && dx < 400;
  });
  const { spots } = findSpots("camp", facts(pocket), 3, false);
    assert.ok(spots[0].sheltered > 0.4);
});

test("a camp behind a crack isn't offered", () => {
  const cracked = grid((x, y) => {
    const d = Math.max(Math.abs(x + 2500), Math.abs(y - 2500));
    return d > 560 && d < 800 && !(Math.abs(y - 2500) < 48 && x > -2500);
  });
  const { spots } = findSpots("camp", facts(cracked), 30, false);
  assert.ok(spots.every((s) => dist(s.at, [-2500, 2500]) > 560), JSON.stringify(spots.map((s) => s.at)));
});

test("with mirror every spot has a working twin, and spots don't take each other's twins", () => {
  const blockedSide = grid((x, y) => x > 1000 && y < -1000);
  const { spots } = findSpots("camp", facts(blockedSide), 8, true);
  assert.ok(spots.length > 0);
  for (const s of spots) {
    assert.deepEqual(s.twin, [-s.at[0], -s.at[1]]);
    assert.ok(!(s.at[0] < -1000 && s.at[1] > 1000), "its twin would stand in the blocked corner");
  }
  for (const a of spots) for (const b of spots) if (a !== b) assert.ok(dist(a.at, b.twin!) >= 1100);
});

test("expansions go by distance from the starts, and need ground to build on", () => {
  const { spots } = findSpots("expansion", facts(grid(), { mines: starts }), 6, false);
  assert.ok(spots.length > 0);
  for (const s of spots) assert.ok(s.fromStart >= 3800 && s.fromStart <= 5800);
  const none = findSpots("expansion", facts(grid(), { noBuild: () => true }), 6, false);
  assert.equal(none.spots.length, 0);
});

test("expansions prefer the side towards the enemy, on the base's level", () => {
  const { spots } = findSpots("expansion", facts(grid(), { mines: starts }), 6, false);
  const [x, y] = spots[0].at, home = dist([x, y], starts[0]) < dist([x, y], starts[1]) ? starts[0] : starts[1];
  const enemy = home === starts[0] ? starts[1] : starts[0];
  const turn = Math.abs((((Math.atan2(y - home[1], x - home[0]) - Math.atan2(enemy[1] - home[1], enemy[0] - home[0])) * 180) / Math.PI + 540) % 360 - 180);
  assert.ok(turn < 75, String(turn));
  const raised = findSpots("expansion", facts(grid(), { mines: starts, levelAt: (a, b) => (Math.hypot(a - x, b - y) < 900 ? 4 : 2) }), 1, false);
  assert.ok(dist(raised.spots[0].at, [x, y]) >= 900, "ground of another level loses");
});

test("narrow strips are found, and open ground has none", () => {
  assert.equal(narrowStrips(grid()).strips.length, 0);
  const lane = grid((x, y) => Math.abs(y) < 600 && Math.abs(y) > 80 && Math.abs(x) < 1400);
  const found = narrowStrips(lane);
  assert.ok(found.strips.length >= 1 && found.percent > 0, JSON.stringify(found.percent));
});
