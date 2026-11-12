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

test("keyOf: a dead key is its place (the German ^ is Backquote); the character it makes otherwise stays", () => {
  assert.equal(keyOf({ key: "Dead", code: "Backquote" }), "Backquote", "German ^, US International `");
  assert.equal(keyOf({ key: "Dead", code: "Backquote", shiftKey: true }), "Backquote", "US International Shift+` (~)");
  assert.equal(keyOf({ key: "Dead", code: "Equal" }), "Equal", "German ´");
  assert.equal(keyOf({ key: "Dead" }), "Dead", "no place to go by: left as it is");
  // Control: a key that gives its character is that character, on that place or not.
  assert.equal(keyOf({ key: "°", code: "Backquote", shiftKey: true }), "°", "German Shift+^");
  assert.equal(keyOf({ key: "`", code: "Backquote" }), "`", "US `");
});

test("keyOf: the rest of WebKitGTK's Unidentified chords (Ctrl+Alt+F-keys and number pad operators), Shift's capitals, modifiers", () => {
  assert.equal(keyOf({ key: "Unidentified", code: "F5" }), "F5", "Ctrl+Alt+F5");
  assert.equal(keyOf({ key: "Unidentified", code: "NumpadAdd" }), "+", "Ctrl+Alt+Numpad +");
  assert.equal(keyOf({ key: "Unidentified", code: "NumpadSubtract" }), "-");
  assert.equal(keyOf({ key: "Unidentified", code: "NumpadMultiply" }), "*");
  assert.equal(keyOf({ key: "Unidentified", code: "NumpadDivide" }), "/");
  assert.equal(keyOf({ key: "Unidentified", code: "NumpadEnter" }), "Enter");
  assert.equal(keyOf({ key: "Unidentified", code: "Numpad7" }), "7");
  assert.equal(keyOf({ key: "Unidentified", code: "KeyZ", shiftKey: true }), "Z", "with Shift a letter is its capital, as e.key gives it");
  assert.equal(keyOf({ key: "Unidentified", code: "AltLeft" }), "Alt");
  assert.equal(keyOf({ key: "Unidentified", code: "ControlRight" }), "Control");
  // Control: what the webview names stays, Shift or not.
  assert.equal(keyOf({ key: "z", code: "KeyZ", shiftKey: true }), "z");
  assert.equal(keyOf({ key: "Home", code: "Numpad7" }), "Home", "Shift+Numpad 7 is Home: the key counts, not the place");
});
