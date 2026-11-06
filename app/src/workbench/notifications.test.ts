import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteQuestionKey } from "./notifications";

const key = (k: string, repeat = false, target: unknown = { tagName: "DIV" }) => ({ key: k, repeat, target });

test("a new press of Delete answers yes, and Escape no", () => {
  assert.equal(deleteQuestionKey(key("Delete")), "yes");
  assert.equal(deleteQuestionKey(key("Escape")), "no");
});

test("a key held down from opening the question means nothing", () => {
  assert.equal(deleteQuestionKey(key("Delete", true)), null);
  assert.equal(deleteQuestionKey(key("Escape", true)), null);
});

test("typing in a field stays typing", () => {
  assert.equal(deleteQuestionKey(key("Delete", false, { tagName: "INPUT" })), null);
  assert.equal(deleteQuestionKey(key("Delete", false, { tagName: "TEXTAREA" })), null);
  assert.equal(deleteQuestionKey(key("Delete", false, { tagName: "DIV", isContentEditable: true })), null);
});

test("other keys don't answer", () => {
  assert.equal(deleteQuestionKey(key("Enter")), null);
  assert.equal(deleteQuestionKey(key("x")), null);
});
