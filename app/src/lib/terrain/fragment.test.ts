import assert from "node:assert/strict";
import { test } from "node:test";
import { centreOf, fragmentOf, FRAGMENT_FORMAT, snapped, turnAngle, turnFragment, turnOffset } from "./fragment";

const tree = (x: number, y: number, z = 0, angle = 0) => ({ list: "doodads" as const, entry: { id: "LTlt", position: [x, y, z], angle, scale: [1, 1, 1], life: 100 } });
const flat = () => 0;

test("a fragment is relative to its centre, on the pathing grid", () => {
  const f = fragmentOf([tree(96, 64), tree(160, 128)], flat);
  assert.deepEqual(f.objects.map((o) => o.at), [[-32, -32, 0], [32, 32, 0]]);
  assert.deepEqual(centreOf([[0, 0], [33, 33]]), [32, 32]);
  assert.equal(snapped(47), 32);
  assert.equal(snapped(49), 64);
});

test("height is kept from the ground, so a raised doodad stays raised on other ground", () => {
  const f = fragmentOf([tree(0, 0, 340)], () => 300);
  assert.equal(f.objects[0].at[2], 40);
});

test("a fragment holds no position of the map, and doesn't share the object it came from", () => {
  const source = tree(0, 0);
  const f = fragmentOf([source], flat);
  assert.equal("position" in f.objects[0].entry, false);
  assert.equal("angle" in f.objects[0].entry, false);
  (f.objects[0].entry.scale as number[])[0] = 9;
  assert.equal(source.entry.scale[0], 1);
});

test("a fragment survives being a file: the same after JSON", () => {
  const unit = { list: "units" as const, entry: { id: "hfoo", position: [64, 0, 0], angle: 0, player: 3 } };
  const f = turnFragment(fragmentOf([tree(0, 0, 0, 1), unit], flat), "cw");
  assert.equal(f.format, FRAGMENT_FORMAT);
  assert.deepEqual(JSON.parse(JSON.stringify(f)), f);
});

test("turns: where a point goes", () => {
  assert.deepEqual(turnOffset("mirrorX", 3, 5), [-3, 5]);
  assert.deepEqual(turnOffset("mirrorY", 3, 5), [3, -5]);
  assert.deepEqual(turnOffset("cw", 1, 0), [0, -1], "east turns to south");
  assert.deepEqual(turnOffset("ccw", 1, 0), [0, 1], "east turns to north");
});

test("turns: a facing goes with its point", () => {
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  const east = 0, north = Math.PI / 2, west = Math.PI, south = Math.PI * 1.5;
  close(turnAngle("mirrorX", east), west);
  close(turnAngle("mirrorX", north), north);
  close(turnAngle("mirrorY", north), south);
  close(turnAngle("mirrorY", east), east);
  close(turnAngle("cw", east), south);
  close(turnAngle("ccw", east), north);
  for (const turn of ["mirrorX", "mirrorY", "cw", "ccw"] as const) {
    for (const a of [0, 0.5, 1.5, 3, 6]) {
      const [x, y] = turnOffset(turn, Math.cos(a), Math.sin(a)), b = turnAngle(turn, a);
      close(Math.cos(b), x);
      close(Math.sin(b), y);
    }
  }
});

test("turning all the way round, or mirroring twice, gives the same fragment", () => {
  const f = fragmentOf([tree(0, 0, 0, 1), tree(128, 64, 0, 2)], flat);
  const near = (a: typeof f, b: typeof f) => a.objects.forEach((o, i) => {
    assert.ok(Math.abs(o.angle - b.objects[i].angle) < 1e-9);
    o.at.forEach((v, k) => assert.ok(Math.abs(v - b.objects[i].at[k]) < 1e-9));
  });
  near(["cw", "cw", "cw", "cw"].reduce((x, t) => turnFragment(x, t as "cw"), f), f);
  near(turnFragment(turnFragment(f, "mirrorX"), "mirrorX"), f);
  near(turnFragment(turnFragment(f, "cw"), "ccw"), f);
});
