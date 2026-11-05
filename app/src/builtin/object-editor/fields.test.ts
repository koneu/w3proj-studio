import assert from "node:assert/strict";
import { test } from "node:test";
import { checkState, setListValue } from "./fields";

test("a list entry goes in and out, with its other spellings", () => {
  assert.equal(setListValue("giant,undead", "worker", [], true), "giant,undead,worker");
  assert.equal(setListValue("giant, undead", "undead", [], false), "giant");
  assert.equal(setListValue("Giant", "giant", [], true), "giant");
  assert.equal(setListValue("aliv,enemy", "alive", ["aliv"], false), "enemy");
  assert.equal(setListValue("_", "giant", [], true), "giant");
  assert.equal(setListValue("giant", "giant", [], false), "");
});

test("a box for several objects: all, none, or some of them", () => {
  const has = (v: string) => v.includes("x");
  assert.deepEqual(checkState(["x", "xy"], has), { checked: true, indeterminate: false });
  assert.deepEqual(checkState(["a", "b"], has), { checked: false, indeterminate: false });
  assert.deepEqual(checkState(["x", "b"], has), { checked: false, indeterminate: true });
  assert.deepEqual(checkState([], has), { checked: false, indeterminate: false });
});
