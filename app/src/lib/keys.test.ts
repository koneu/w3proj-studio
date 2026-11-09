import assert from "node:assert/strict";
import { test } from "node:test";
import { keyOf } from "./keys";

test("keyOf: the key as the webview names it; the physical key where WebKitGTK says Unidentified", () => {
  // Control: a key the webview knows stays as it is, whatever the code.
  assert.equal(keyOf({ key: "Tab", code: "Tab" }), "Tab");
  assert.equal(keyOf({ key: "z", code: "KeyY" }), "z", "a German layout's z is on the Y key: the key counts, not the place");
  // WebKitGTK's Shift+Tab.
  assert.equal(keyOf({ key: "Unidentified", code: "Tab" }), "Tab");
  assert.equal(keyOf({ key: "Unidentified", code: "KeyZ" }), "z");
  assert.equal(keyOf({ key: "Unidentified", code: "Digit3" }), "3");
  assert.equal(keyOf({ key: "Unidentified", code: "Space" }), " ");
  assert.equal(keyOf({ key: "", code: "PageUp" }), "PageUp");
  assert.equal(keyOf({ key: "Unidentified", code: "" }), "Unidentified", "nothing to go by: left as it is");
  assert.equal(keyOf({ key: "Unidentified" }), "Unidentified");
});
