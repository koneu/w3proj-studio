// check-keys.mjs: src/ as it is passes (the control), and made-up sources with a keyboard event's key read directly
// are caught, by the usual names and by the names a file gives its events; `keys-ok:` lines and other `.key`s aren't.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { checkKeys, directKeyUses, eventNames } from "./check-keys.mjs";

// npm test, the gate and the coverage run all start the runner in app/.
const src = join(process.cwd(), "src");

test("src/ reads every shortcut's key through keyOf", () => {
  assert.deepEqual(checkKeys(src), []);
});

test("a direct e.key is found, by the usual names and by a name typed or bound as a keyboard event", () => {
  const lines = (s) => directKeyUses(s).map((u) => u.line);
  assert.deepEqual(lines(`el.onkeydown = (e) => {\n  if (e.key === "Escape") close();\n};`), [2]);
  assert.deepEqual(lines(`const k = event.key.toLowerCase();`), [1]);
  assert.deepEqual(lines(`switch (ev.key) {}`), [1]);
  assert.deepEqual(lines(`const f = (press: KeyboardEvent) => {\n  return press.key === "Delete";\n};`), [2]);
  assert.deepEqual(lines(`input.addEventListener("keydown", (kd) => { if (kd.key === "Enter") go(); });`), [1]);
  assert.deepEqual(lines(`h("input", { onkeydown: (x: KeyboardEvent) => { if (x.key === "Enter") go(); } });`), [1]);
  assert.deepEqual(lines(`if (e.key === "a" && e.ctrlKey) all(); // select all`), [1], "a trailing comment doesn't hide the code before it");
  assert.ok(eventNames(`function f(stroke?: KeyboardEvent) {}`).has("stroke"));
});

test("keys-ok lines, comments, other objects' key and keyOf itself aren't reported", () => {
  const none = (s, why) => assert.deepEqual(directKeyUses(s), [], why);
  none(`if (keyOf(e) === "Escape") close();`, "keyOf");
  none(`const name = menuFor(names, e.key); // keys-ok: the typed letter picks the menu`, "said why");
  none(`// e.key is "Unidentified" there`, "a comment");
  none(` * WebKitGTK gives e.key "Unidentified"`, "a doc comment");
  none(`if (cached.key !== saved.key) rebuild();`, "not an event");
  none(`if (job.key !== root) return;`, "not an event");
  none(`const code = e.keyCode;`, "keyCode is another property");
  none(`const k = row.e.key;`, "a property named e");
  none(`const x = (e: KeyboardEvent) => e.code === "Tab";`, "code is the physical key, not the one in question");
  // keys-ok needs a reason.
  assert.equal(directKeyUses(`if (e.key === "x") y(); // keys-ok:`).length, 1);
});
