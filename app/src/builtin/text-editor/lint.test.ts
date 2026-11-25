// lineDiagnostics: line numbers of a finding made elsewhere (JassHelper's) as marks on whole lines.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import { lineDiagnostics } from "./lint";

test("lineDiagnostics marks the whole line, drops lines outside the text, and an empty line still gets a mark", () => {
  const doc = Text.of(["abc", "", "defg"]);
  const d = lineDiagnostics(doc, [{ line: 1, message: "a" }, { line: 2, message: "b", severity: "warning" }, { line: 3, message: "c" }, { line: 4, message: "x" }, { line: 0, message: "y" }, { line: 1.5, message: "z" }, { line: NaN, message: "n" }]);
  assert.deepEqual(d, [
    { from: 0, to: 3, message: "a", severity: "error" },
    { from: 4, to: 5, message: "b", severity: "warning" },
    { from: 5, to: 9, message: "c", severity: "error" },
  ]);
  // Control: the right line number is what places it.
  assert.notDeepEqual(lineDiagnostics(doc, [{ line: 3, message: "c" }]), lineDiagnostics(doc, [{ line: 1, message: "c" }]));
});
