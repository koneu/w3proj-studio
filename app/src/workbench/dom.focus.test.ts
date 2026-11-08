import assert from "node:assert/strict";
import { test } from "node:test";
import { focusAfterClick } from "./dom";

// WebKitGTK focuses the clicked control after its handlers ran: the focus has to be given again after the event.
test("focusAfterClick focuses now and once more after the event, while the element is still shown", async () => {
  let calls = 0;
  const el = { isConnected: true, focus: () => { calls++; } };
  focusAfterClick(el);
  assert.equal(calls, 1, "at once");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2, "after the event");

  let gone = 0;
  const removed = { isConnected: true, focus: () => { gone++; } };
  focusAfterClick(removed);
  removed.isConnected = false;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gone, 1, "an element removed meanwhile isn't focused again");
});
