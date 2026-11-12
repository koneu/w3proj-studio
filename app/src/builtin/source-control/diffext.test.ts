import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorView } from "@codemirror/view";
import { diffExtensions } from "./diffext";

test("a diff side wraps long lines", () => {
  assert.ok(diffExtensions("a.txt").includes(EditorView.lineWrapping));
  assert.ok(diffExtensions("a.json").includes(EditorView.lineWrapping));
  // control: the check can fail
  assert.ok(!([] as unknown[]).includes(EditorView.lineWrapping));
});
