import assert from "node:assert/strict";
import { test } from "node:test";
import { clampShift, pushMoveEdit, type Bounds, type Pose } from "./moveedit";

const pose = (x: number, y: number): Pose => ({ position: [x, y, 0], angle: 0 });

test("a move's undo step redraws the selection rings now, and after undo and redo (a Ctrl+Arrow nudge)", () => {
  const log: string[] = [];
  let edit!: { undo: () => void; redo: () => void };
  const deps = {
    setPlacement: (e: string, p: number[]) => log.push(`${e}@${p[0]}`),
    refreshRings: () => log.push("rings"),
    pushEdit: (e: typeof edit) => { edit = e; log.push("push"); },
  };
  pushMoveEdit(["a", "b"], [pose(0, 0), pose(5, 0)], [pose(1, 0), pose(6, 0)], deps);
  assert.deepEqual(log, ["push", "rings"], "the do-step: the entries already moved, so the rings follow at once");
  log.length = 0;
  edit.undo();
  assert.deepEqual(log, ["a@0", "b@5", "rings"]);
  log.length = 0;
  edit.redo();
  assert.deepEqual(log, ["a@1", "b@6", "rings"]);
});

const map: Bounds = { left: -100, right: 100, bottom: -100, top: 100 };

test("clampShift: inside the bounds the shift is as asked", () => {
  assert.deepEqual(clampShift([[0, 0], [10, 10]], [map, map], 20, -30), [20, -30]);
});

test("clampShift: a group stops at the edge together and keeps its shape", () => {
  // The right-most point reaches x=100 after 70; the left one doesn't go further than the group.
  assert.deepEqual(clampShift([[0, 0], [30, 0]], [map, map], 500, 0), [70, 0]);
  assert.deepEqual(clampShift([[0, 0], [30, 50]], [map, map], -500, 500), [-100, 50]);
  // x=-263 from the bug: a single object dragged past the left edge stops on it.
  assert.deepEqual(clampShift([[-50, 0]], [map], -213, 0), [-50, 0]);
});

test("clampShift: each point has its own bounds, and one already outside doesn't hold the rest", () => {
  const small: Bounds = { left: 0, right: 10, bottom: 0, top: 10 };
  assert.deepEqual(clampShift([[5, 5], [50, 50]], [small, map], 100, 0), [5, 0]);
  assert.deepEqual(clampShift([[500, 500], [0, 0]], [map, map], 20, 20), [20, 20], "the one outside the map is ignored");
});
