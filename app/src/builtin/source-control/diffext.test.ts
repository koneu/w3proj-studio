import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorView } from "@codemirror/view";
import { diffExtensions } from "./diffext";

test("a diff side wraps long lines", () => {
  assert.ok(diffExtensions("a.txt").includes(EditorView.lineWrapping));
  assert.ok(diffExtensions("a.json").includes(EditorView.lineWrapping));
  // control: includes() tells extensions apart, and a JSON side has the language on top
  assert.ok(!diffExtensions("a.txt").includes(EditorView.editable as never));
  assert.equal(diffExtensions("a.json").length, diffExtensions("a.txt").length + 1);
});
