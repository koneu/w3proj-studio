import assert from "node:assert/strict";
import { test } from "node:test";
import { joinPlan, minus, nameProblem, parseRect, placePlan, planText, renamePlan, type SubRect } from "./subterrainplan";

/** A 2×2 grid over a canvas of 10×8 corners. */
const grid: SubRect[] = [
  { name: "sw", x: 0, y: 0, w: 5, h: 4 }, { name: "se", x: 5, y: 0, w: 5, h: 4 },
  { name: "nw", x: 0, y: 4, w: 5, h: 4 }, { name: "ne", x: 5, y: 4, w: 5, h: 4 },
];

test("what is left of a rectangle: itself, nothing, the rest when a whole side goes, else not a rectangle", () => {
  const s = { name: "s", x: 2, y: 2, w: 4, h: 3 };
  assert.equal(minus(s, { x: 7, y: 0, w: 2, h: 9 }), s, "no overlap");
  assert.equal(minus(s, { x: 0, y: 0, w: 9, h: 9 }), "empty");
  assert.deepEqual(minus(s, { x: 0, y: 0, w: 3, h: 9 }), { ...s, x: 3, w: 3 }, "the west column");
  assert.deepEqual(minus(s, { x: 5, y: 2, w: 1, h: 3 }), { ...s, w: 3 }, "the east column, exactly as high");
  assert.deepEqual(minus(s, { x: 2, y: 4, w: 4, h: 5 }), { ...s, h: 2 }, "the north row");
  assert.equal(minus(s, { x: 3, y: 0, w: 1, h: 9 }), null, "a column through the middle: two pieces");
  assert.equal(minus(s, { x: 0, y: 0, w: 3, h: 3 }), null, "a corner: an L is left");
});

test("a new subterrain takes a whole side off its neighbours, keeps the list's order, is refused when it would cut one in pieces", () => {
  const p = placePlan(grid, { name: "east", x: 8, y: 0, w: 2, h: 8, from: [] });
  assert.deepEqual(p, [
    { name: "sw", x: 0, y: 0, w: 5, h: 4, from: ["sw"] }, { name: "se", x: 5, y: 0, w: 3, h: 4, from: ["se"] },
    { name: "nw", x: 0, y: 4, w: 5, h: 4, from: ["nw"] }, { name: "ne", x: 5, y: 4, w: 3, h: 4, from: ["ne"] },
    { name: "east", x: 8, y: 0, w: 2, h: 8, from: [] },
  ]);
  assert.equal((p as { name: string }[]).map(planText as never).join(" "), "sw=sw:0,0,5,4 se=se:5,0,3,4 nw=nw:0,4,5,4 ne=ne:5,4,3,4 east=:8,0,2,8");
  assert.match(placePlan(grid, { name: "mid", x: 6, y: 1, w: 2, h: 2, from: [] }) as string, /would leave se in pieces/);
  // One covered whole is taken in: its ranges go with the new one.
  assert.deepEqual((placePlan(grid, { name: "south", x: 0, y: 0, w: 10, h: 4, from: [] }) as { name: string; from?: string[] }[]).map((s) => [s.name, s.from]), [["south", ["sw", "se"]], ["nw", ["nw"]], ["ne", ["ne"]]]);
  assert.match(placePlan(grid, { name: "x", x: 0, y: 0, w: 0, h: 2 }) as string, /isn't a rectangle/);
});

test("a resize keeps its place and its ranges, and moves the seam into the neighbour", () => {
  assert.deepEqual(placePlan(grid, { name: "sw", x: 0, y: 0, w: 7, h: 4, from: ["sw"] }, "sw"), [
    { name: "sw", x: 0, y: 0, w: 7, h: 4, from: ["sw"] }, { name: "se", x: 7, y: 0, w: 3, h: 4, from: ["se"] },
    { name: "nw", x: 0, y: 4, w: 5, h: 4, from: ["nw"] }, { name: "ne", x: 5, y: 4, w: 5, h: 4, from: ["ne"] },
  ]);
});

test("rename and join: the names checked, the ranges continued", () => {
  assert.deepEqual((renamePlan(grid, "ne", "north_east") as SubRect[]).map((s) => s.name), ["sw", "se", "nw", "north_east"]);
  assert.match(renamePlan(grid, "ne", "SW") as string, /already/);
  assert.match(renamePlan(grid, "nope", "x") as string, /no subterrain/);
  assert.match(renamePlan(grid, "ne", "a=b") as string, /can't hold/);
  const j = joinPlan(grid, ["sw", "se"], "south") as { name: string; x: number; w: number; from?: string[] }[];
  assert.deepEqual(j.map((s) => [s.name, s.x, s.w, s.from]), [["south", 0, 10, ["sw", "se"]], ["nw", 0, 5, ["nw"]], ["ne", 5, 5, ["ne"]]]);
  assert.match(joinPlan(grid, ["sw", "ne"], "diag") as string, /reaches into se, nw: join them too/, "the box round two diagonal ones takes in the others");
  assert.equal((joinPlan(grid, ["sw", "ne", "se", "nw"], "all") as unknown[]).length, 1);
  assert.match(joinPlan(grid, ["sw"], "x") as string, /two subterrains or more/);
  assert.equal(nameProblem("sw", grid, "sw"), null, "its own name is fine when it's the one renamed");
  assert.deepEqual(parseRect(" 1, 2,3 ,4"), { x: 1, y: 2, w: 3, h: 4 });
  assert.equal(parseRect("1,2,3"), null);
  assert.equal(parseRect("1,2,-3,4"), null);
});
