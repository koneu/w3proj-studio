import assert from "node:assert/strict";
import { test } from "node:test";
import { watchContextLoss } from "./contextloss";

/** What a canvas fires: the loss is cancelable, and only a cancelled loss is restored by the browser. */
const lose = (canvas: EventTarget) => {
  const e = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
};
const restore = (canvas: EventTarget) => canvas.dispatchEvent(new Event("webglcontextrestored"));

test("a lost context is accepted for restoring, reported once, and its restore reported", () => {
  const canvas = new EventTarget(), calls: string[] = [];
  const watch = watchContextLoss(canvas, { lost: () => calls.push("lost"), restored: () => calls.push("restored") });
  assert.equal(watch.lost, false);
  const e = lose(canvas);
  assert.equal(e.defaultPrevented, true, "without preventDefault the browser never gives the context back");
  assert.equal(watch.lost, true);
  lose(canvas);
  assert.deepEqual(calls, ["lost"], "a second loss event while lost isn't a second loss");
  restore(canvas);
  assert.equal(watch.lost, false);
  assert.deepEqual(calls, ["lost", "restored"]);
  restore(canvas);
  assert.deepEqual(calls, ["lost", "restored"], "a restore without a loss is nothing");
  lose(canvas);
  restore(canvas);
  assert.deepEqual(calls, ["lost", "restored", "lost", "restored"], "it keeps working after a restore");
});

test("after dispose a loss is nothing: dispose() of a renderer loses its context on purpose", () => {
  const canvas = new EventTarget(), calls: string[] = [];
  const watch = watchContextLoss(canvas, { lost: () => calls.push("lost"), restored: () => calls.push("restored") });
  watch.dispose();
  lose(canvas);
  restore(canvas);
  assert.deepEqual(calls, []);
  assert.equal(watch.lost, false);
});
