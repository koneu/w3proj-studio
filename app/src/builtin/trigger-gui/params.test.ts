import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnsetParam } from "./params";

// What the GUI shows as an unset parameter (its argument's name in red) is what Validate Map Triggers reports as
// "isn't set": round 4 found a variable parameter of no name drawn as an empty sliver.
test("isUnsetParam: no parameter, type -1, a nameless preset or variable, a call without a function", () => {
  assert.equal(isUnsetParam(undefined), true);
  assert.equal(isUnsetParam({ type: -1, value: "" }), true);
  assert.equal(isUnsetParam({ type: 0, value: "" }), true);
  assert.equal(isUnsetParam({ type: 1, value: "" }), true);
  assert.equal(isUnsetParam({ type: 2, value: "", call: { kind: 3, name: "", hasParams: false, params: [] } }), true);
  assert.equal(isUnsetParam({ type: 2, value: "" }), true);
  // Set ones, and an empty value of a literal (an empty string is one).
  assert.equal(isUnsetParam({ type: 0, value: "PlayerNA" }), false);
  assert.equal(isUnsetParam({ type: 1, value: "udg_Hero" }), false);
  assert.equal(isUnsetParam({ type: 2, value: "GetTriggerUnit", call: { kind: 3, name: "GetTriggerUnit", hasParams: false, params: [] } }), false);
  assert.equal(isUnsetParam({ type: 3, value: "" }), false);
});
