import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArea } from "../../lib/terrain/area";
import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { groundHeight, heightAt, type Corner, type Terrain } from "../../lib/terrain/w3e";
import { dress, followGround, groundSlot, heightColors, heightGrid, paintCorners, paintPath, scatterSpots, sculptCorners, spotsAround, terrainSummary, textMap, viewOfArea } from "./aitools";
import { beyondPlayable, distanceToLine, isKeptClear, playableArea } from "../../lib/terrain/area";

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

/** 16 × 16 tiles from (0, 0), flat at level 2, height 0. */
function field(): Terrain {
  const c = { height: 0, water: 0, texture: 0, variation: 0, layer: 2, ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0 } as Corner;
  return { tileset: "A", groundTiles: ["Adrt", "Agrs"], width: 17, height: 17, offsetX: 0, offsetY: 0, corners: Array.from({ length: 289 }, () => ({ ...c })) } as unknown as Terrain;
}
const hill = { left: 0, bottom: 0, right: 2048, top: 2048 };
const at = (t: Terrain, x: number, y: number) => groundHeight(t.corners[y * t.width + x]);

test("a hill is highest in the middle and fades to nothing, so it has no step", () => {
  const t = field();
  const changed = sculptCorners(t, hill, "ellipse", "raise", 100);
  assert.equal(at(t, 8, 8), 100);
  assert.equal(at(t, 0, 0), 0);
  assert.equal(at(t, 0, 8), 0, "the edge itself");
  assert.ok(at(t, 4, 8) > 30 && at(t, 4, 8) < 70);
  for (let x = 0; x < 16; x++) assert.ok(Math.abs(at(t, x + 1, 8) - at(t, x, 8)) < 25, "steep steps would need a cliff");
  assert.ok(changed.length > 100 && changed.includes(8 * 17 + 8));
});

test("lowering, flattening and smoothing", () => {
  const t = field();
  sculptCorners(t, hill, "ellipse", "lower", 50);
  assert.equal(at(t, 8, 8), -50);
  sculptCorners(t, hill, "ellipse", "flatten", 0);
  assert.equal(at(t, 8, 8), 0);
  const bumpy = field();
  bumpy.corners[8 * 17 + 8].rawHeight += 400;
  sculptCorners(bumpy, hill, "ellipse", "smooth", undefined);
  assert.ok(at(bumpy, 8, 8) < 20, "a spike goes");
});

test("smoothing doesn't pull heights across a cliff", () => {
  const t = field();
  for (let y = 0; y < 17; y++) for (let x = 9; x < 17; x++) { t.corners[y * 17 + x].layer = 4; t.corners[y * 17 + x].rawHeight += 400; }
  sculptCorners(t, hill, "ellipse", "smooth", undefined);
  assert.equal(at(t, 8, 8), 0);
});

test("the map's boundary stays as it is", () => {
  const t = field();
  t.corners[8 * 17 + 8].boundary = true;
  sculptCorners(t, hill, "ellipse", "raise", 100);
  assert.equal(at(t, 8, 8), 0);
});

test("painting a patch: its middle is solid and its edge frays", () => {
  const t = field();
  const changed = paintCorners(t, hill, "ellipse", 1, 0.4, seeded());
  assert.equal(t.corners[8 * 17 + 8].texture, 1);
  assert.equal(t.corners[8 * 17 + 7].texture, 1);
  assert.equal(t.corners[0].texture, 0);
  const n = t.corners.filter((c) => c.texture === 1).length;
  assert.equal(changed.length, n);
  const solid = field();
  assert.ok(paintCorners(solid, hill, "ellipse", 1, 0, seeded()).length > n, "edge 0 paints all of it");
  assert.equal(paintCorners(solid, hill, "ellipse", 1, 0, seeded()).length, 0, "what has the tile doesn't change");
});

test("a tile not in the map's list gets a slot, while there's room", () => {
  const t = field();
  assert.equal(groundSlot(t, "Agrs"), 1);
  assert.equal(groundSlot(t, "Lgrs"), 2);
  t.groundTiles = Array.from({ length: 16 }, (_, i) => `T${i}`);
  assert.throws(() => groundSlot(t, "Lgrs"), /already has 16/);
});

test("objects near the change follow the ground, except doodads with a fixed height", () => {
  const t = field();
  const changed = sculptCorners(t, hill, "ellipse", "raise", 100);
  const on = { position: [1024, 1024, 0] }, fixed = { position: [1024, 1024, 0], flags: 6 }, far = { position: [9000, 9000, 7] };
  assert.equal(followGround([on, fixed, far], t, changed, true), 1);
  assert.equal(on.position[2], heightAt(t, 1024, 1024));
  assert.equal(fixed.position[2], 0);
  assert.equal(far.position[2], 7);
  const unit = { position: [1024, 1024, 0], flags: 6 };
  assert.equal(followGround([unit], t, changed, false), 1, "the flag is a doodad's");
  assert.equal(followGround([on], t, [], true), 0);
});

test("the height grid has north first and stays small", () => {
  const t = field();
  sculptCorners(t, hill, "ellipse", "raise", 100);
  const small = heightGrid(t, { left: 0, bottom: 0, right: 512, top: 1024 });
  assert.equal(small.rows.length, 9);
  assert.equal(small.rows[0].length, 5);
  assert.equal(small.rows[0][4], Math.round(heightAt(t, 512, 1024)));
  assert.equal(small.rows[8][0], 0);
  assert.ok(heightGrid({ ...t }, { left: 0, bottom: 0, right: 12800, top: 12800 }).cellSize === 512);
});

test("height colours run from blue to red, with lines between levels", () => {
  const t = field();
  sculptCorners(t, hill, "ellipse", "raise", 100);
  const { rgba, width, height } = heightColors(t);
  assert.deepEqual([width, height, rgba.length], [64, 64, 64 * 64 * 4]);
  const px = (x: number, y: number) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
  assert.ok(px(1, 1)[2] > px(1, 1)[0], "low is blue");
  assert.ok(px(32, 32)[0] > px(32, 32)[2], "high is red");
  assert.ok(Array.from({ length: 64 }, (_, x) => px(x, 32)).some((p) => p[0] === 0 && p[3] === 220), "a line crosses the slope");
});

test("the playable area comes from the map's border, and leaving it is said", () => {
  const t = { offsetX: -4096, offsetY: -4096, width: 65, height: 65 };
  const p = playableArea({ cameraComplements: [6, 6, 4, 8] }, t);
  assert.deepEqual(p, { left: -3328, right: 3328, bottom: -3584, top: 3072 });
  assert.equal(beyondPlayable({ left: 0, bottom: 0, right: 100, top: 100 }, p), null);
  assert.match(beyondPlayable({ left: -3500, bottom: 0, right: 100, top: 3200 }, p) ?? "", /west and north/);
});

test("keep-clear places: areas, and lines with a width", () => {
  assert.equal(distanceToLine(5, 3, [[0, 0], [10, 0]]), 3);
  assert.equal(distanceToLine(13, 4, [[0, 0], [10, 0]]), 5);
  assert.equal(distanceToLine(1, 1, [[1, 1]]), 0);
  const keep = [{ left: 0, bottom: 0, right: 10, top: 10 }, { points: [[100, 0], [200, 0]] as [number, number][], width: 40 }];
  assert.equal(isKeptClear(5, 5, keep), true);
  assert.equal(isKeptClear(150, 19, keep), true);
  assert.equal(isKeptClear(150, 21, keep), false);
});

test("a path paints along its line, frays at its sides and ends, and leaves the rest", () => {
  const t = field();
  const changed = paintPath(t, [[256, 1024], [1792, 1024]], 256, 1, 0.5, false, seeded());
  assert.equal(t.corners[8 * 17 + 8].texture, 1);
  assert.equal(t.corners[2 * 17 + 8].texture, 0);
  assert.equal(t.corners[0].texture, 0);
  assert.ok(changed.includes(8 * 17 + 8));
  assert.ok(changed.length > 8 && changed.length < 40);
  const hard = field();
  assert.ok(paintPath(hard, [[256, 1024], [1792, 1024]], 256, 1, 0, false, seeded()).length >= changed.length);
});

test("a flattened path levels the ground across it towards its middle", () => {
  const t = field();
  for (let i = 8 * 17; i < 9 * 17; i++) t.corners[i].rawHeight += 400;
  for (let i = 0; i < 289; i++) if (i % 17 === 8 && i !== 8 * 17 + 8) t.corners[i].rawHeight += 0;
  const crown = at(t, 8, 8);
  paintPath(t, [[0, 896], [2048, 896]], 512, 1, 0, true, seeded());
  assert.ok(at(t, 8, 8) < crown, "a bump beside the line is brought down");
  assert.equal(t.corners[0].rawHeight, 0x2000);
});

test("looking for room goes outwards, on the pathing grid", () => {
  const spots = spotsAround(320, 320);
  assert.ok(spots.every(([x, y]) => x % 32 === 0 && y % 32 === 0));
  const d = (s: [number, number]) => Math.hypot(s[0] - 320, s[1] - 320);
  assert.ok(d(spots[0]) < 50 && d(spots.at(-1)!) > 250);
});

test("a size range is used instead of the type's", () => {
  const e = { variation: 0, angle: 0, scale: [1, 1, 1] as [number, number, number] };
  dress(e, tree, { scaleRange: [0.3, 0.5] }, true, seeded());
  assert.ok(e.scale[0] >= 0.3 && e.scale[0] <= 0.5);
});

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
  const v = viewOfArea({ left: 0, bottom: 0, right: 2000, top: 1000 }, 40, 2, Math.PI / 2, "top");
  assert.deepEqual(v.target, [1000, 500, 40]);
  assert.ok(Math.abs(v.distance - 600) < 0.001);
  assert.ok(v.pitch > viewOfArea(box, 0, 1, 1, "angled").pitch && viewOfArea(box, 0, 1, 1, "angled").pitch > viewOfArea(box, 0, 1, 1, "low").pitch);
  assert.equal(viewOfArea({ left: 0, bottom: 0, right: 1, top: 1 }, 0, 1, 1, "top").distance, 400);
});
