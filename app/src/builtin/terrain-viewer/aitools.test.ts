import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArea } from "../../lib/terrain/area";
import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import type { Corner, Terrain } from "../../lib/terrain/w3e";
import { dress, scatterSpots, terrainSummary, textMap, viewOfArea } from "./aitools";

/** Repeatable numbers in 0..1. */
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const box = { left: 0, bottom: 0, right: 1024, top: 1024 };

test("an area is a region by name, or a rectangle, or none", () => {
  const regions = [{ name: "Grove", left: 1, bottom: 2, right: 3, top: 4 }];
  assert.deepEqual(parseArea({ region: "grove" }, regions), regions[0]);
  assert.deepEqual(parseArea({ left: 0, bottom: 0, right: 8, top: 8 }, regions), { left: 0, bottom: 0, right: 8, top: 8 });
  assert.equal(parseArea({}, regions), null);
  assert.throws(() => parseArea({ region: "Nowhere" }, regions), /no region/);
  assert.throws(() => parseArea({ left: 0 }, regions), /all of left/);
  assert.throws(() => parseArea({ left: 9, bottom: 0, right: 1, top: 8 }, regions), /below right/);
});

test("scattered spots stay inside, sit on the pathing grid and spread over the area", () => {
  const spots = scatterSpots(box, 128, "box", seeded());
  assert.ok(spots.length > 40, `${spots.length}`);
  for (const s of spots) {
    assert.ok(s.x >= 0 && s.x <= 1024 && s.y >= 0 && s.y <= 1024);
    assert.equal(s.x % 32, 0);
    assert.equal(s.y % 32, 0);
  }
  assert.ok(spots.some((s) => s.x < 256 && s.y < 256) && spots.some((s) => s.x > 768 && s.y > 768));
});

test("an ellipse has no corners and thins out at its edge", () => {
  const spots = scatterSpots(box, 64, "ellipse", seeded());
  const r = (s: { x: number; y: number }) => Math.hypot(s.x - 512, s.y - 512) / 512;
  assert.ok(spots.every((s) => r(s) <= 1));
  const density = (a: number, b: number) => spots.filter((s) => r(s) >= a && r(s) < b).length / (b * b - a * a);
  assert.ok(density(0.85, 1) < density(0, 0.5) / 2);
});

const tree = { numVar: 5, randScale: true, minScale: 0.8, maxScale: 1.2, fixedRot: null };

test("scattered things differ, within what their type allows", () => {
  const random = seeded();
  const made = Array.from({ length: 50 }, () => {
    const e = { variation: 0, angle: 0, scale: [1, 1, 1] as [number, number, number] };
    dress(e, tree, {}, true, random);
    return e;
  });
  assert.ok(new Set(made.map((e) => e.variation)).size > 2);
  assert.ok(made.every((e) => e.variation < 5 && e.scale[0] >= 0.8 && e.scale[0] <= 1.2 && e.scale[0] === e.scale[2]));
  assert.ok(new Set(made.map((e) => e.angle)).size > 40);
});

test("what's asked for wins, a type's fixed facing wins over that, and units don't vary by themselves", () => {
  const e = { variation: 0, angle: 0, scale: [1, 1, 1] as [number, number, number] };
  dress(e, tree, { variation: 9, facing: 180, scale: 2 }, true, seeded());
  assert.deepEqual(e, { variation: 4, angle: Math.PI, scale: [2, 2, 2] });
  dress(e, { ...tree, fixedRot: 90 }, { facing: 180 }, true, seeded());
  assert.equal(e.angle, Math.PI / 2);
  const unit = { variation: 0, angle: 1, scale: [1, 1, 1] as [number, number, number] };
  dress(unit, tree, {}, false, seeded());
  assert.deepEqual(unit, { variation: 0, angle: 1, scale: [1, 1, 1] });
});

/** 8 × 8 tiles from (0, 0); pathing cells are 32 wide, row 0 in the south. */
function ground(edit: (cell: (tx: number, ty: number, flags: number) => void) => void) {
  const c = { height: 100, water: 0, texture: 0, layer: 2, ramp: false, blight: false, hasWater: false } as Corner;
  const t = { tileset: "A", groundTiles: ["Adrt", "Agrs"], width: 9, height: 9, offsetX: 0, offsetY: 0, corners: Array.from({ length: 81 }, () => ({ ...c })) } as unknown as Terrain;
  const p = { width: 32, height: 32, cells: new Uint8Array(32 * 32).fill(NO_WATER) };
  edit((tx, ty, flags) => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) p.cells[(ty * 4 + y) * 32 + tx * 4 + x] = flags; });
  return { t, p };
}

test("the text map has north on top and tells ground, water and blocked apart", () => {
  const { t, p } = ground((tile) => {
    tile(0, 7, NO_WATER | NO_WALK);
    tile(7, 0, 0);
    tile(1, 0, NO_WATER | NO_BUILD);
  });
  const map = textMap(t, p, { left: 0, bottom: 0, right: 1024, top: 1024 });
  assert.equal(map.rows.length, 8);
  assert.equal(map.rows[0], "#.......");
  assert.equal(map.rows[7], ".,.....~");
  assert.deepEqual([map.left, map.top, map.cellSize], [0, 1024, 128]);
});

test("one blocked cell is enough to show: a tree is that small", () => {
  const { t, p } = ground(() => {});
  p.cells[33] = NO_WATER | NO_WALK;
  const map = textMap(t, p, { left: 0, bottom: 0, right: 1024, top: 1024 });
  assert.equal(map.rows[7], "#.......");
  assert.equal(map.rows[6], "........");
});

test("a big area stays a small map", () => {
  const { t, p } = ground(() => {});
  const wide = { ...t, width: 513, offsetX: -8192, offsetY: -8192 } as Terrain;
  const map = textMap(wide, { ...p, width: 512, height: 512, cells: new Uint8Array(512 * 512).fill(NO_WATER) }, { left: -8192, bottom: -8192, right: 8192, top: 8192 });
  assert.ok(map.rows.length <= 64 && map.rows[0].length <= 64, `${map.rows.length}`);
  assert.equal(map.cellSize, 256);
});

test("the summary counts what's inside only", () => {
  const { t, p } = ground(() => {});
  t.corners[0].height = 300;
  t.corners[1].texture = 1;
  t.corners[10].hasWater = true;
  t.corners[10].water = 200;
  t.corners[80].layer = 5;
  const got = terrainSummary(t, p, { left: 0, bottom: 0, right: 128, top: 128 });
  assert.deepEqual(got.height, { lowest: 100, highest: 300 });
  assert.deepEqual(got.cliffLevels, [2]);
  assert.equal(got.percent.water, 25);
  assert.deepEqual(got.groundTiles, [{ id: "Adrt", percent: 75 }, { id: "Agrs", percent: 25 }]);
  assert.throws(() => terrainSummary(t, p, { left: 9000, bottom: 9000, right: 9500, top: 9500 }), /outside/);
});

test("the camera for an area looks at its middle, with room around it", () => {
  const v = viewOfArea({ left: 0, bottom: 0, right: 2000, top: 1000 }, 40, 2, Math.PI / 2, true);
  assert.deepEqual(v.target, [1000, 500, 40]);
  assert.ok(Math.abs(v.distance - 600) < 0.001);
  assert.ok(v.pitch > viewOfArea(box, 0, 1, 1, false).pitch);
  assert.equal(viewOfArea({ left: 0, bottom: 0, right: 1, top: 1 }, 0, 1, 1, true).distance, 400);
});
