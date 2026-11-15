import assert from "node:assert/strict";
import { test } from "node:test";
import { pickerKey } from "./filepicker";

test("picker keys: arrows move within the rows, Enter chooses, Escape cancels", () => {
  assert.deepEqual(pickerKey("ArrowDown", 0, 3), { kind: "move", active: 1 });
  assert.deepEqual(pickerKey("ArrowDown", 2, 3), { kind: "move", active: 2 });
  assert.deepEqual(pickerKey("ArrowUp", 0, 3), { kind: "move", active: 0 });
  assert.deepEqual(pickerKey("ArrowUp", 2, 3), { kind: "move", active: 1 });
  assert.deepEqual(pickerKey("ArrowDown", 0, 0), { kind: "move", active: 0 });
  assert.deepEqual(pickerKey("Enter", 1, 3), { kind: "choose" });
  assert.deepEqual(pickerKey("Escape", 1, 3), { kind: "cancel" });
  // Typing is left to the search box; Enter on a focused button presses it.
  assert.equal(pickerKey("a", 0, 3), null);
  assert.equal(pickerKey("Enter", 0, 3, true), null);
});
