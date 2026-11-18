import assert from "node:assert/strict";
import { test } from "node:test";
import { planMoves, takenOnDisk } from "./moves";

const none = () => false;

test("files and folders move into a folder, or to the top", () => {
  assert.deepEqual(planMoves(["map/a.txt", "docs"], "other", none), { moves: [["map/a.txt", "other/a.txt"], ["docs", "other/docs"]], problem: null });
  assert.deepEqual(planMoves(["map/sub/a.txt"], "", none).moves, [["map/sub/a.txt", "a.txt"]]);
});

test("what's inside a selected folder goes with it", () => {
  assert.deepEqual(planMoves(["docs", "docs/a.txt", "docs/x/b.txt"], "other", none).moves, [["docs", "other/docs"]]);
  assert.deepEqual(planMoves(["docs", "docs2/a.txt"], "other", none).moves.length, 2);
});

test("already there: nothing to do", () => {
  assert.deepEqual(planMoves(["map/a.txt"], "map", none), { moves: [], problem: null });
  assert.deepEqual(planMoves(["Map/a.txt"], "map", none), { moves: [], problem: null });
});

test("not into itself", () => {
  assert.match(planMoves(["docs"], "docs", none).problem!, /into itself/);
  assert.match(planMoves(["docs"], "docs/sub", none).problem!, /into itself/);
  assert.equal(planMoves(["docs"], "docs2", none).problem, null);
});

test("a name that's taken, on disk or by another moved file", () => {
  assert.match(planMoves(["a/x.txt"], "b", (p) => p === "b/x.txt").problem!, /b\/x.txt already exists/);
  assert.match(planMoves(["a/x.txt", "c/X.txt"], "b", none).problem!, /already exists/);
});

test("nothing happens when one of them can't move", () => {
  assert.deepEqual(planMoves(["a/ok.txt", "docs"], "docs/sub", none).moves, []);
});

test("what the project needs stays", () => {
  assert.match(planMoves(["map"], "other", none).problem!, /has to stay/);
  assert.match(planMoves(["w3proj.toml"], "other", none).problem!, /has to stay/);
  assert.equal(planMoves(["map/w3proj.toml"], "other", none).problem, null);
});

test("takenOnDisk asks the disk, not the file list", async () => {
  const moves = [["a/x.txt", "b/x.txt"], ["a/y.txt", "b/y.txt"]] as const;
  const asked: string[] = [];
  const disk = new Set(["b/y.txt"]);
  const ask = async (p: string) => { asked.push(p); return disk.has(p); };
  assert.equal(await takenOnDisk(moves, ask), "b/y.txt already exists.");
  assert.deepEqual(asked, ["b/x.txt", "b/y.txt"]);
  // Control: nothing there, no problem.
  assert.equal(await takenOnDisk(moves, async () => false), null);
  // Can't be told: not free.
  assert.match((await takenOnDisk(moves, async () => { throw new Error("denied"); }))!, /b\/x\.txt can't be checked: denied/);
});
