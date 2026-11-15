import assert from "node:assert/strict";
import { test } from "node:test";
import { CornerUndo } from "../../lib/terrain/cliffs";
import type { Corner, Terrain } from "../../lib/terrain/w3e";
import { replacePlaced } from "./aitools";
import { replaceCorners, roomCells, roomForReplaced, swapsOf } from "./replace";
import type { RoomShape } from "./occupancy";

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

// ---- Replace Doodads' rule for room (tests/we-compare/replace-doodad-overlap.json) ----

/** The empty 64x64 map's grid: 256 x 256 cells from -4096. */
const MAP = { width: 65, height: 65, offsetX: -4096, offsetY: -4096 } as unknown as Terrain;
const square = (n: number) => ({ width: n, height: n, mask: new Uint8Array(n * n).fill(1) });
const SOUTH = (270 * Math.PI) / 180;
const cell = (x: number, y: number) => ((y + 4096) / 32) * 256 + (x + 4096) / 32;

test("roomCells: a texture covers its cells; a circle each cell it reaches into", () => {
  // A crate (4x4) at 64, 64 covers x 0..128, y 0..128.
  const crate = roomCells(MAP, square(4), 64, 64, SOUTH);
  assert.equal(crate.length, 16);
  assert.ok(crate.includes(cell(0, 0)) && crate.includes(cell(96, 96)) && !crate.includes(cell(128, 0)));
  // A footman (collision 31) with its middle 8 and 24 east of that crate's edge reaches into its cells, 40 east doesn't.
  for (const [dx, reaches] of [[8, true], [24, true], [40, false], [-8, true]] as const) {
    const cells = roomCells(MAP, { radius: 31 }, 128 + dx, 64, SOUTH);
    assert.equal(cells.some((c) => crate.includes(c)), reaches, `footman ${dx} east of the edge`);
  }
  assert.deepEqual(roomCells(MAP, null, 0, 0, SOUTH), [], "nothing for a pathless doodad");
  assert.deepEqual(roomCells(MAP, { radius: 31 }, -4096 - 200, 0, SOUTH), [], "nothing off the map");
});

test("Replace Doodads: barrels to crates as the World Editor did it, case by case", () => {
  // The input of tests/fixtures/we-compare/make-replace-doodad-input.mjs: per case the lower-left corner (X, Y) of a
  // barrel's crate; the barrel stands at X + 32, Y + 32, the crate goes to X + 64, Y + 64.
  const CELLS = [[-1024, 1024], [-512, 1024], [0, 1024], [512, 1024], [-1024, 512], [-512, 512], [0, 512], [512, 512], [-1024, 0], [-512, 0], [0, 0],
    [-1024, -512], [-512, -512], [0, -512], [-1024, -1024], [-512, -1024], [576, -512]];
  const at = (c: number, dx: number, dy: number) => [CELLS[c - 1][0] + dx, CELLS[c - 1][1] + dy] as const;
  const barrel = (c: number, dx = 32, dy = 32) => ({ barrel: true, at: at(c, dx, dy), name: `c${c}${dx === 32 && dy === 32 ? "" : ` (${dx}, ${dy})`}` });
  const thing = (shape: RoomShape, c: number, dx: number, dy: number) => ({ barrel: false, shape, at: at(c, dx, dy) });
  const doodads = [
    barrel(1),
    barrel(2), thing(square(4), 2, 192, 64), // a tree touching the crate's east edge
    barrel(3), thing(square(4), 3, 128, 64), // a tree over its east half
    barrel(4), thing(square(4), 4, 128, 64), // crates
    barrel(5), thing(square(2), 5, 96, 96), // a doodad (LOsh) on its north-east quarter
    barrel(6), thing(null, 6, 96, 96), // a pathless doodad there
    barrel(7), barrel(8),
    barrel(9, 96, -32), barrel(9), // two whose crates overlap: the first in the file wins
    barrel(10), barrel(10, 96, -32),
    barrel(11), barrel(11, 96, 32), // the first's crate covers the second barrel
    barrel(12), barrel(13), barrel(14), barrel(15), barrel(16), barrel(17), // c17's cliff isn't an object: the ground doesn't count
  ];
  const units = [
    thing({ radius: 31 }, 7, 96, 96), thing(square(4), 8, 128, 128), // a footman, a farm
    thing({ radius: 31 }, 12, 136, 64), thing({ radius: 31 }, 13, 152, 64), thing({ radius: 31 }, 14, 168, 64), thing({ radius: 31 }, 15, 120, 64),
    thing({ radius: 16 }, 16, 96, 96), // an item
  ];
  const others = [...doodads, ...units].flatMap((d) => ("shape" in d ? [roomCells(MAP, d.shape, d.at[0], d.at[1], SOUTH)] : []));
  const barrels = doodads.filter((d) => d.barrel) as ReturnType<typeof barrel>[];
  const ok = roomForReplaced(others, barrels.map((b) => ({
    before: roomCells(MAP, square(2), b.at[0], b.at[1], SOUTH),
    after: roomCells(MAP, square(4), b.at[0] + 32, b.at[1] + 32, SOUTH),
  })));
  const crates = barrels.filter((_, i) => ok[i]).map((b) => b.name);
  assert.deepEqual(crates, ["c1", "c2", "c6", "c9 (96, -32)", "c10", "c11 (96, 32)", "c14", "c17"]);
});

test("roomForReplaced: an object's own old cells don't count; one refused keeps its old cells for the next", () => {
  // A over cells 1, 2 becomes 1, 2, 3: only its own cells there. B (cell 5) would take 3, 4: A has 3 now.
  assert.deepEqual(roomForReplaced([], [{ before: [1, 2], after: [1, 2, 3] }, { before: [5], after: [3, 4] }]), [true, false]);
  // Refused, A keeps cell 2, which stops B; another object's cell 9 stops A.
  assert.deepEqual(roomForReplaced([[9]], [{ before: [2], after: [8, 9] }, { before: [5], after: [2, 6] }]), [false, false]);
  // B moved off cell 7 first, so A may take it.
  assert.deepEqual(roomForReplaced([], [{ before: [7], after: [6] }, { before: [1], after: [1, 7] }]), [true, true]);
});
