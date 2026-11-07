import assert from "node:assert/strict";
import { test } from "node:test";
import { pushMoveEdit, type Pose } from "./moveedit";

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
