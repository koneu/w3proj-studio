import assert from "node:assert/strict";
import { test } from "node:test";
import { textViewIn } from "./viewstate";

test("a remembered text view comes back as it was in an unchanged file", () => {
  assert.deepEqual(textViewIn({ anchor: 10, head: 20, top: 3 }, 100, 9), { anchor: 10, head: 20, top: 3 });
});

test("a file that got shorter meanwhile: positions go to its end, the top line to its last", () => {
  assert.deepEqual(textViewIn({ anchor: 500, head: 40, top: 80 }, 50, 4), { anchor: 50, head: 40, top: 4 });
  assert.deepEqual(textViewIn({ anchor: -5, head: 2.7, top: 0 }, 50, 4), { anchor: 0, head: 2, top: 1 });
});

test("anything else (another editor's state, damaged storage) is no state", () => {
  for (const bad of [null, undefined, 3, "x", [], { anchor: 1, head: 2 }, { anchor: "1", head: 2, top: 1 }, { anchor: NaN, head: 2, top: 1 }, { anchor: 1, head: Infinity, top: 1 }]) {
    assert.equal(textViewIn(bad, 100, 10), null, JSON.stringify(bad));
  }
});
