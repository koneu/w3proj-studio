import assert from "node:assert/strict";
import { test } from "node:test";
import { LAYOUT_COLOURS as C, layoutPicture, type LayoutFacts } from "./layoutpicture";

/** 8 x 8 cells from (0, 0): a wall in cell (1, 0), deep water in (2, 0), shallows in (3, 0), a tree in (4, 0), a
 *  doodad in (5, 0), border in (7, 7). */
function facts(more: Partial<LayoutFacts> = {}): LayoutFacts {
  const trees = new Uint8Array(64), standing = new Uint8Array(64);
  trees[4] = 1;
  standing[5] = 1;
  return {
    width: 8, height: 8, offsetX: 0, offsetY: 0, noWalk: (i) => i === 1 || i === 2, water: (i) => i === 2 || i === 3, trees, standing, border: (i) => i === 63,
    starts: [], mines: [], shops: [], camps: [], routes: [], ...more,
  };
}
const at = (p: { width: number; rgba: Uint8Array }, x: number, y: number) => [...p.rgba.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 3)];

test("every kind of ground has its colour, north up", () => {
  const p = layoutPicture(facts(), 2);
  assert.deepEqual([p.width, p.height, p.rgba.length], [16, 16, 16 * 16 * 4]);
  // Row 0 of the cells is the south: the picture's last rows.
  const south = (cell: number) => at(p, cell * 2, 15);
  assert.deepEqual([south(0), south(1), south(2), south(3), south(4), south(5)], [[...C.ground], [...C.wall], [...C.water], [...C.shallows], [...C.forest], [...C.object]]);
  assert.deepEqual(at(p, 15, 0), [...C.border], "the north-east corner");
  assert.deepEqual(at(p, 0, 0), [...C.ground]);
  assert.ok(p.rgba.every((v, i) => i % 4 !== 3 || v === 255), "opaque");
});

test("starts, mines, shops, camps with their sight and routes are drawn over the ground", () => {
  const p = layoutPicture(facts({
    starts: [[48, 208]], mines: [[208, 208]], shops: [[208, 48]],
    camps: [{ centre: [128, 128], level: 9, sight: 96, guard: false }],
    routes: [[[16, 16], [100, 16]]],
  }), 4);
  const px = (x: number, y: number) => at(p, Math.round((x / 32) * 4), Math.round(32 - (y / 32) * 4));
  assert.deepEqual(px(48, 208), [...C.start]);
  assert.deepEqual(px(208, 208), [...C.mine]);
  assert.deepEqual(px(208, 48), [...C.shop]);
  assert.deepEqual(px(128, 128), [...C.camp]);
  assert.deepEqual(px(128 + 96, 128), [...C.sight], "the ring, 96 east of the camp");
  assert.deepEqual(px(64, 16), [...C.route]);
  // A guard is the darker red.
  assert.deepEqual(at(layoutPicture(facts({ camps: [{ centre: [128, 128], level: 9, sight: 64, guard: true }] }), 4), 16, 16), [...C.guard]);
});
