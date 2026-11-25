import assert from "node:assert/strict";
import { test } from "node:test";
import { keyName } from "w3c-keyname";
import { keyOf } from "../lib/keys";
import * as lib from "./lib";

test("extensions lib offers the app's own keyOf", () => {
  assert.equal(lib.keys.keyOf, keyOf);
  assert.equal(lib.keys.keyOf({ key: "Unidentified", code: "Tab" }), "Tab");
  // Control: a known key stays as the webview names it.
  assert.equal(lib.keys.keyOf({ key: "z", code: "KeyY" }), "z");
});

// CodeMirror's keymap names an event with w3c-keyname: for key "Unidentified" (WebKitGTK's Shift+Tab) it goes by
// event.keyCode, not code. So indentWithTab works there only while the webview fills keyCode (9); keyCode itself
// can't be seen headlessly (app-smoke over WebDriver on Linux covers the real webview).
test("CodeMirror's key naming: Unidentified falls back to keyCode (Tab, Shift+Tab), not to code", () => {
  assert.equal(keyName({ key: "Unidentified", keyCode: 9, shiftKey: true } as KeyboardEvent), "Tab");
  assert.equal(keyName({ key: "Unidentified", keyCode: 9, shiftKey: false } as KeyboardEvent), "Tab");
  assert.equal(keyName({ key: "Unidentified", code: "Tab", keyCode: 0 } as KeyboardEvent), "Unidentified", "no keyCode: code isn't used");
  // Control: a named key needs no keyCode.
  assert.equal(keyName({ key: "Tab", keyCode: 0 } as KeyboardEvent), "Tab");
});
