import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyText, cutAtBrace, fileFine } from "./wts-verdict.mjs";

test("a `}` inside a line is the cut the current rule makes", () => {
  assert.equal(cutAtBrace("Name ends } and more"), "Name ends ");
  assert.equal(cutAtBrace("one\r\n}\r\nx"), "one");
  assert.equal(cutAtBrace("a \\} b"), "a \\} b");
  assert.equal(classifyText("Name ends } and more", "Name ends "), "inline");
  assert.equal(classifyText("same", "same"), "same");
});

test("anything but that cut is a difference", () => {
  // control: the verdict can fail
  assert.equal(classifyText("Name ends } and more", "Name"), "CHANGED");
  assert.equal(classifyText("Name ends } and more", "Name ends } and"), "CHANGED");
  assert.equal(classifyText("abc", "xbc"), "CHANGED");
  assert.equal(classifyText("abc", "abc and more"), "CHANGED");
  // a text that swallowed the next block is not an inline cut
  assert.equal(classifyText("one }\n\nSTRING 2\n{\ntwo", "one "), "cut");
});

test("a file is fine with inline cuts, or cuts that have their recovered block", () => {
  assert.equal(fileFine(["inline 3", "inline 9"]), true);
  assert.equal(fileFine(["cut 4", "new 5"]), true);
  assert.equal(fileFine(["cut 4", "inline 6", "new 5"]), true);
  assert.equal(fileFine(["cut 4"]), false);
  assert.equal(fileFine(["new 5"]), false);
  assert.equal(fileFine(["inline 3", "CHANGED 4"]), false);
  assert.equal(fileFine(["inline 3", "LOST 4"]), false);
  assert.equal(fileFine(["inline 3", "NEW-NOT-SWALLOWED 4"]), false);
  assert.equal(fileFine([]), false);
});
