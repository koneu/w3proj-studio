import test from "node:test";
import assert from "node:assert/strict";
import { CLOSED, cornersOpen, editableAt, HALO, mergeOpenPathing, notOpenText, OPEN, partialMask, type OpenState } from "./openset";

/** 4×3 corners: the west two columns open, the third halo, the fourth closed (rows from the south). */
const state = (mask: string): OpenState => ({ partial: true, source: "file", corners: [4, 3], halo: 2, subterrains: [], mask, error: null });
const MASK = "2210".repeat(3);

test("the mask: corners' states, tiles left out where a corner is closed, dimmed where one is in the halo, locked corners", () => {
  assert.equal(partialMask({ ...state(""), partial: false }, 4, 3), null, "everything open: no mask");
  const m = partialMask(state(MASK), 4, 3)!;
  assert.deepEqual([...m.corners.slice(0, 4)], [OPEN, OPEN, HALO, CLOSED]);
  // 3×2 tiles: x 0 open, x 1 halo (corner 2 is halo), x 2 hidden (corner 3 closed).
  assert.deepEqual([...m.hiddenTiles], [0, 0, 1, 0, 0, 1]);
  assert.deepEqual([...m.haloTiles], [0, 1, 0, 0, 1, 0]);
  assert.deepEqual(m.locked, [2, 3, 6, 7, 10, 11]);
  assert.throws(() => partialMask(state("22"), 4, 3), /2 corners/);
  assert.throws(() => partialMask(state("2219".repeat(3)), 4, 3), /holds "9"/);
});

test("an object may go where its corner (the one at or south-west of it) is open", () => {
  const m = partialMask(state(MASK), 4, 3)!;
  assert.equal(editableAt(null, 0, 0, 999, 999), true, "no mask: anywhere");
  assert.equal(editableAt(m, 0, 0, 10, 10), true);
  assert.equal(editableAt(m, 0, 0, 255, 10), true, "corner 1");
  assert.equal(editableAt(m, 0, 0, 256, 10), false, "corner 2: halo");
  assert.equal(editableAt(m, 0, 0, -1, 10), false, "off the map");
});

test("a paste's ground box is open only when every corner of it is; corners off the map don't count", () => {
  const m = partialMask(state(MASK), 4, 3)!;
  assert.equal(cornersOpen(null, 0, 0, 99, 99), true, "no mask");
  assert.equal(cornersOpen(m, 0, 0, 1, 2), true, "the two open columns");
  assert.equal(cornersOpen(m, 0, 0, 2, 0), false, "reaching the halo column");
  assert.equal(cornersOpen(m, -5, -5, 1, 2), true, "off the map to the south-west");
  assert.equal(cornersOpen(m, 3, 0, 9, 0), false, "the closed column");
  assert.match(notOpenText("Not placed: the spot", 10.4, -3.6), /^Not placed: the spot 10, -4 isn't in an open subterrain/);
});

test("a partial derive keeps the stored pathing cells outside the open subterrains", () => {
  const m = partialMask(state(MASK), 4, 3)!;
  // 12×8 cells (4 per tile), header 16 bytes with width and height at 8 and 12.
  const wpm = (fill: number) => {
    const b = new Uint8Array(16 + 12 * 8).fill(fill);
    const v = new DataView(b.buffer);
    v.setUint32(8, 12, true);
    v.setUint32(12, 8, true);
    return b;
  };
  const out = mergeOpenPathing(wpm(1), wpm(9), m);
  const cell = (x: number, y: number) => out[16 + y * 12 + x];
  assert.equal(cell(0, 0), 1, "tile 0: its south-west corner is open");
  assert.equal(cell(7, 0), 1, "tile 1: corner 1 open");
  assert.equal(cell(8, 0), 9, "tile 2: corner 2 is halo: stored");
  assert.equal(cell(11, 7), 9);
  assert.deepEqual(mergeOpenPathing(wpm(1), null, m), wpm(1), "nothing stored: made whole");
  const other = wpm(9).slice(0, 40);
  assert.deepEqual(mergeOpenPathing(wpm(1), other, m), wpm(1), "another size: made whole");
});
