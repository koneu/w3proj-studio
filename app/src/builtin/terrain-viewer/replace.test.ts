import assert from "node:assert/strict";
import { test } from "node:test";
import { CornerUndo } from "../../lib/terrain/cliffs";
import type { Corner, Terrain } from "../../lib/terrain/w3e";
import { replacePlaced } from "./aitools";
import { replaceCorners, swapsOf } from "./replace";

/** 4 corners: tiles 0, 1, 2, 1; cliff types 0, 1, 15 (flat ground's), 0. */
function ground(): Terrain {
  const c = (texture: number, cliffTexture: number) => ({ texture, cliffTexture, variation: 3, layer: 2 }) as Corner;
  return { groundTiles: ["Ldrt", "Lgrs", "Lrok"], cliffTiles: ["CLdi", "CLgr"], width: 2, height: 2, corners: [c(0, 0), c(1, 1), c(2, 15), c(1, 0)] } as unknown as Terrain;
}

test("Replace Tiles: the old tile's corners get the new one, the rest stays", () => {
  const t = ground(), log = new CornerUndo();
  assert.deepEqual(replaceCorners(t, "texture", 1, 2, false, log), [1, 3]);
  assert.deepEqual(t.corners.map((c) => c.texture), [0, 2, 2, 2]);
  assert.deepEqual(t.corners.map((c) => c.variation), [3, 3, 3, 3]);
});

test("Swap Both Tiles: each takes the other's corners; undo puts every corner back", () => {
  const t = ground(), log = new CornerUndo();
  assert.deepEqual(replaceCorners(t, "texture", 0, 1, true, log), [0, 1, 3]);
  assert.deepEqual(t.corners.map((c) => c.texture), [1, 0, 2, 0]);
  const step = log.step(t);
  assert.deepEqual(step.corners, [0, 1, 3]);
  step.undo();
  assert.deepEqual(t.corners.map((c) => c.texture), [0, 1, 2, 1]);
  step.redo();
  assert.deepEqual(t.corners.map((c) => c.texture), [1, 0, 2, 0]);
});

test("Replace Cliff Type: the cliff type numbers change, a number past the list (15) stays", () => {
  const t = ground(), log = new CornerUndo();
  assert.deepEqual(replaceCorners(t, "cliffTexture", 0, 1, false, log), [0, 3]);
  assert.deepEqual(t.corners.map((c) => c.cliffTexture), [1, 1, 15, 1]);
  assert.deepEqual(t.corners.map((c) => c.texture), [0, 1, 2, 1], "the ground stays");
});

test("the same old and new type changes nothing", () => {
  const t = ground(), log = new CornerUndo();
  assert.deepEqual(replaceCorners(t, "texture", 1, 1, true, log), []);
  assert.deepEqual(log.step(t).corners, []);
});

test("Replace Doodads / Units: one way, or both ways with Swap Both", () => {
  assert.deepEqual(swapsOf({ from: "LTlt", to: "FTtw" }), { LTlt: "FTtw" });
  assert.deepEqual(swapsOf({ from: "LTlt", to: "FTtw", swap: true }), { LTlt: "FTtw", FTtw: "LTlt" });
  assert.deepEqual(swapsOf({ from: "hfoo", to: "hfoo", swap: true }), { hfoo: "hfoo" });
  const list = [{ id: "LTlt", position: [0, 0], variation: 4 }, { id: "FTtw", position: [1, 0], variation: 1 }, { id: "ATtr", position: [2, 0], variation: 0 }];
  assert.equal(replacePlaced(list, swapsOf({ from: "LTlt", to: "FTtw", swap: true }), null, (id) => (id === "FTtw" ? 3 : 10)), 2);
  // each swapped once (not back again), and a variation the new type hasn't got becomes its last
  assert.deepEqual(list.map((e) => [e.id, e.variation]), [["FTtw", 2], ["LTlt", 1], ["ATtr", 0]]);
});
