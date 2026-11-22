import assert from "node:assert/strict";
import { test } from "node:test";
import { addCut, addSub, cellAt, cutAt, deleteSub, describe, dragHandle, dragRect, draftCuts, draftOf, evenCuts, freeName, gridRects, handleAt, joinSubs, moveCut, normalGrid, planOf, removeCut, renameSub, resizeSub, sideBySide, unchanged, type Draft } from "./layoutdraft";
import { planText, type SubRect } from "./subterrainplan";

/** A 2×2 grid over a canvas of 10×8 corners. */
const grid: SubRect[] = [
  { name: "sw", x: 0, y: 0, w: 5, h: 4 }, { name: "se", x: 5, y: 0, w: 5, h: 4 },
  { name: "nw", x: 0, y: 4, w: 5, h: 4 }, { name: "ne", x: 5, y: 4, w: 5, h: 4 },
];
const start = () => draftOf(grid, [10, 8]);
const ok = (d: Draft | string): Draft => { if (typeof d === "string") throw new Error(d); return d; };
const plan = (d: Draft) => planOf(d).map(planText).join(" ");

test("the draft of the layout on disk is unchanged and plans every subterrain as itself", () => {
  const d = start();
  assert.ok(unchanged(d, grid));
  assert.equal(plan(d), "sw=sw:0,0,5,4 se=se:5,0,5,4 nw=nw:0,4,5,4 ne=ne:5,4,5,4");
  assert.deepEqual(describe(d, grid), []);
});

test("steps one after the other make one plan that traces every subterrain back to disk", () => {
  // Renamed, then resized, then a new one carved out of it, then joined: the plan names what is on disk.
  let d = ok(renameSub(start(), "sw", "south_west"));
  d = ok(resizeSub(d, "south_west", { x: 0, y: 0, w: 7, h: 4 }));
  d = ok(addSub(d, "mid", { x: 5, y: 0, w: 2, h: 4 }));
  d = ok(joinSubs(d, ["nw", "ne"], "north"));
  // (mid took back the two columns south_west had grown by; a new one goes to the end of the list.)
  assert.equal(plan(d), "south_west=sw:0,0,5,4 se=se:7,0,3,4 north=nw+ne:0,4,10,4 mid=:5,0,2,4");
  assert.ok(!unchanged(d, grid));
  assert.deepEqual(describe(d, grid), [
    "Renamed: sw → south_west (its folder too).",
    "Resized: se, 5×4 at 5,0 → 3×4 at 7,0.",
    "Joined: nw + ne → north, 10×4 at 0,4 (all their creation numbers).",
    "New: mid, 2×4 at 5,0 (it gets the next block of creation numbers).",
  ]);
  // A renamed one renamed back is itself again.
  assert.ok(unchanged(ok(renameSub(ok(renameSub(start(), "sw", "x")), "x", "sw")), grid));
});

test("refusals in words: a name taken, a rectangle past the canvas or cutting one in pieces, nothing changed", () => {
  const d = start();
  assert.match(addSub(d, "SE", { x: 0, y: 0, w: 1, h: 1 }) as string, /already/);
  assert.match(addSub(d, "x", { x: 8, y: 0, w: 4, h: 8 }) as string, /past the map's 10×8 corners/);
  assert.match(addSub(d, "x", { x: 6, y: 1, w: 2, h: 2 }) as string, /would leave se in pieces/);
  assert.match(resizeSub(d, "nope", { x: 0, y: 0, w: 1, h: 1 }) as string, /no subterrain "nope"/);
  assert.match(joinSubs(d, ["sw", "ne"], "x") as string, /reaches into/);
  assert.ok(unchanged(d, grid), "the draft itself is left as it was");
});

test("delete joins into a neighbour side by side, else leaves the corners uncovered; the last one stays", () => {
  const joined = deleteSub(start(), "se");
  assert.ok(typeof joined !== "string");
  assert.equal(joined.into, "sw");
  assert.equal(plan(joined.draft), "sw=sw+se:0,0,10,4 nw=nw:0,4,5,4 ne=ne:5,4,5,4");
  // A subterrain no neighbour lines up with: dropped, its corners left to the default corner.
  const odd = draftOf([{ name: "a", x: 0, y: 0, w: 4, h: 8 }, { name: "b", x: 4, y: 0, w: 6, h: 3 }, { name: "c", x: 4, y: 3, w: 6, h: 5 }], [10, 8]);
  const dropped = deleteSub(odd, "a");
  assert.ok(typeof dropped !== "string");
  assert.equal(dropped.into, null);
  assert.equal(plan(dropped.draft), "b=b:4,0,6,3 c=c:4,3,6,5");
  assert.match(describe(dropped.draft, [{ name: "a", x: 0, y: 0, w: 4, h: 8 }, { name: "b", x: 4, y: 0, w: 6, h: 3 }, { name: "c", x: 4, y: 3, w: 6, h: 5 }]).join(" "), /Deleted: a/);
  assert.match(deleteSub(draftOf([{ name: "main", x: 0, y: 0, w: 10, h: 8 }], [10, 8]), "main") as string, /only subterrain/);
  assert.ok(sideBySide(grid[0], grid[1]) && sideBySide(grid[0], grid[2]) && !sideBySide(grid[0], grid[3]));
});

test("the pointer: cells, dragged rectangles, handles and their drags snap to whole corners", () => {
  const d = start();
  assert.deepEqual(cellAt(d, [3.7, -2]), [3, 0]);
  assert.deepEqual(cellAt(d, [99, 7.9]), [9, 7]);
  assert.deepEqual(dragRect([6, 5], [2, 1]), { x: 2, y: 1, w: 5, h: 5 });
  const r = { x: 2, y: 2, w: 4, h: 3 };
  assert.equal(handleAt(r, [2.1, 3], 0.3), "w");
  assert.equal(handleAt(r, [6, 5.2], 0.3), "ne");
  assert.equal(handleAt(r, [4, 3], 0.3), "inside");
  assert.equal(handleAt(r, [9, 9], 0.3), null);
  assert.deepEqual(dragHandle(d, r, "e", [7.6, 0]), { x: 2, y: 2, w: 6, h: 3 });
  assert.deepEqual(dragHandle(d, r, "w", [9, 0]), { x: 5, y: 2, w: 1, h: 3 }, "at least one corner stays");
  assert.deepEqual(dragHandle(d, r, "sw", [-3, 0.4]), { x: 0, y: 0, w: 6, h: 5 });
  assert.deepEqual(dragHandle(d, r, "inside", [0, 0], [7, -1.2]), { x: 6, y: 1, w: 4, h: 3 }, "kept on the canvas");
  assert.equal(freeName(grid, "new"), "new");
  assert.equal(freeName([...grid, { name: "New", x: 0, y: 0, w: 1, h: 1 }], "new"), "new2");
});

test("a flat project's split grid: even cuts, names, dragging a cut between its neighbours", () => {
  assert.deepEqual(evenCuts(10, 3), [3, 7]);
  assert.deepEqual(evenCuts(10, 1), []);
  assert.deepEqual(gridRects({ canvas: [10, 8], xs: [], ys: [] }), [{ name: "main", x: 0, y: 0, w: 10, h: 8 }]);
  assert.deepEqual(gridRects({ canvas: [10, 8], xs: [5], ys: [4] }).map((r) => r.name), ["sw", "se", "nw", "ne"]);
  assert.deepEqual(gridRects({ canvas: [10, 8], xs: [3, 7], ys: [4] }), [
    { name: "r1c1", x: 0, y: 0, w: 3, h: 4 }, { name: "r1c2", x: 3, y: 0, w: 4, h: 4 }, { name: "r1c3", x: 7, y: 0, w: 3, h: 4 },
    { name: "r2c1", x: 0, y: 4, w: 3, h: 4 }, { name: "r2c2", x: 3, y: 4, w: 4, h: 4 }, { name: "r2c3", x: 7, y: 4, w: 3, h: 4 },
  ]);
  assert.deepEqual(normalGrid({ canvas: [10, 8], xs: [7, 0, 3, 3, 10], ys: [8] }), { canvas: [10, 8], xs: [3, 7], ys: [] });
  const g = { canvas: [10, 8] as [number, number], xs: [3, 7], ys: [4] };
  assert.deepEqual(cutAt(g, [6.8, 1], 0.5), { axis: "x", index: 1 });
  assert.deepEqual(cutAt(g, [5, 4.2], 0.5), { axis: "y", index: 0 });
  assert.equal(cutAt(g, [5, 1], 0.5), null);
  assert.deepEqual(moveCut(g, "x", 0, 9).xs, [6, 7], "stays west of the next cut");
  assert.deepEqual(moveCut(g, "y", 0, -5).ys, [1]);
});

test("one more column cuts every subterrain it crosses; one fewer joins them back", () => {
  const d = ok(addCut(start(), "x"));
  // The widest band is 5 wide (0–5): cut at 2; sw and nw are cut, their east parts are new.
  assert.deepEqual(draftCuts(d, "x"), [2, 5]);
  assert.equal(plan(d), "sw=sw:0,0,2,4 se=se:5,0,5,4 nw=nw:0,4,2,4 ne=ne:5,4,5,4 sw2=:2,0,3,4 nw2=:2,4,3,4");
  // The last cut (5) goes: se and ne join the subterrains left of it.
  const back = ok(removeCut(d, "x"));
  assert.deepEqual(draftCuts(back, "x"), [2]);
  assert.deepEqual(back.subs.map((s) => s.name).sort(), ["nw", "nw2", "sw", "sw2"].sort());
  const rows = ok(addCut(start(), "y"));
  assert.deepEqual(draftCuts(rows, "y"), [2, 4]);
});

test("column and row steps say why they can't", () => {
  assert.match(String(removeCut(draftOf([{ name: "main", x: 0, y: 0, w: 10, h: 8 }], [10, 8]), "x")), /one column already/);
  assert.match(String(addCut(draftOf([{ name: "main", x: 0, y: 0, w: 1, h: 8 }], [1, 8]), "x")), /no room/);
  // Staggered subterrains don't line up across the cut.
  const odd = draftOf([{ name: "a", x: 0, y: 0, w: 5, h: 8 }, { name: "b", x: 5, y: 0, w: 5, h: 3 }, { name: "c", x: 5, y: 3, w: 5, h: 5 }], [10, 8]);
  assert.match(String(removeCut(odd, "x")), /don't line up/);
});
