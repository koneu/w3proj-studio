import assert from "node:assert/strict";
import { test } from "node:test";
import { openness, ringAround } from "./meleeshape";
import type { Grid } from "./pathcheck";

/** A square map of 256 x 256 cells round 0, with what `wall` blocks. */
function grid(wall: (x: number, y: number) => boolean = () => false): Grid {
  const width = 256, height = 256, offsetX = -4096, offsetY = -4096, blocked = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (wall(offsetX + (x + 0.5) * 32, offsetY + (y + 0.5) * 32)) blocked[y * width + x] = 1;
  }
  return { blocked, width, height, offsetX, offsetY };
}
/** A wall ring 480 to 640 round 0, open where `mouth` says. */
const ringed = (mouth: (angle: number) => boolean) => grid((x, y) => { const r = Math.hypot(x, y); return r > 480 && r < 640 && !mouth((Math.atan2(y, x) * 180) / Math.PI); });

test("open ground has nothing round it; a closed ring has no way in", () => {
  assert.deepEqual(ringAround(grid(), 0, 0), { closed: 0, ways: 1, widest: 360 });
  assert.deepEqual(ringAround(ringed(() => false), 0, 0), { closed: 1, ways: 0, widest: 0 });
});

test("a pocket: mostly closed, one way in; a second mouth is a second way", () => {
  const one = ringAround(ringed((a) => Math.abs(a - 90) < 30), 0, 0);
  assert.equal(one.ways, 1);
  assert.ok(one.closed > 0.75 && one.closed < 0.95, String(one.closed));
  assert.ok(one.widest >= 45 && one.widest <= 75, String(one.widest));
  const two = ringAround(ringed((a) => Math.abs(a - 90) < 30 || Math.abs(a + 90) < 30), 0, 0);
  assert.equal(two.ways, 2);
  // A crack of one direction isn't a way for an army.
  const crack = ringAround(ringed((a) => Math.abs(a - 90) < 30 || Math.abs(a + 90) < 5), 0, 0);
  assert.equal(crack.ways, 1);
});

test("the map's edge counts as a wall", () => {
  const corner = ringAround(grid(), -4096 + 200, -4096 + 200);
  assert.ok(corner.closed > 0.6, String(corner.closed));
  assert.equal(corner.ways, 1);
});

test("open ground is what lies far from anything in the way", () => {
  // Nothing but the edge: nearly all of it is open.
  const empty = openness(grid());
  assert.ok(empty.share > 0.75, String(empty.share));
  // A pillar every 640: nowhere is more than 400 from one.
  const pillars = openness(grid((x, y) => Math.abs(((x % 640) + 640) % 640 - 320) < 32 && Math.abs(((y % 640) + 640) % 640 - 320) < 32));
  assert.ok(pillars.share < 0.05, String(pillars.share));
  assert.ok(pillars.walkable > 60000);
  // All blocked: no share, no division by nothing.
  assert.deepEqual(openness(grid(() => true)), { walkable: 0, open: 0, share: 0 });
});
