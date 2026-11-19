import test from "node:test";
import assert from "node:assert/strict";
import { closeInOrder, tabsToClose } from "./tabclose";

test("Close Others on the 2nd of 4 tabs leaves only it", async () => {
  const tabs = ["a", "b", "c", "d"];
  const open = [...tabs];
  const ok = await closeInOrder(tabsToClose(open, "b", "others"), async (t) => { open.splice(open.indexOf(t), 1); return true; });
  assert.ok(ok);
  assert.deepEqual(open, ["b"]);
});

test("to the Right and All pick the right tabs", () => {
  const tabs = ["a", "b", "c", "d"];
  assert.deepEqual(tabsToClose(tabs, "b", "right"), ["c", "d"]);
  assert.deepEqual(tabsToClose(tabs, "d", "right"), []);
  assert.deepEqual(tabsToClose(tabs, "b", "all"), tabs);
  assert.deepEqual(tabsToClose(tabs, "x", "others"), []);
});

test("a dirty tab that cancels stays and stops the rest", async () => {
  const open = ["a", "b", "c", "d"];
  const asked: string[] = [];
  const ok = await closeInOrder(tabsToClose(open, "b", "others"), async (t) => {
    asked.push(t);
    if (t === "c") return false; // Save question cancelled
    open.splice(open.indexOf(t), 1);
    return true;
  });
  assert.equal(ok, false);
  assert.deepEqual(asked, ["a", "c"], "d is not asked after the cancel");
  assert.deepEqual(open, ["b", "c", "d"]);
});
