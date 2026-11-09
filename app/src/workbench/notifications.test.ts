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

test("typing in a field stays typing, and ends the question", () => {
  assert.equal(deleteQuestionKey(key("a", false, { tagName: "INPUT" })), "away");
  assert.equal(deleteQuestionKey(key("Delete", false, { tagName: "INPUT" })), null);
  assert.equal(deleteQuestionKey(key("Delete", false, { tagName: "TEXTAREA" })), null);
  assert.equal(deleteQuestionKey(key("Delete", false, { tagName: "DIV", isContentEditable: true })), null);
});

test("other keys move on, so the next Delete can't answer for something else", () => {
  assert.equal(deleteQuestionKey(key("ArrowDown")), "away");
  assert.equal(deleteQuestionKey(key("ArrowDown", true)), "away");
  assert.equal(deleteQuestionKey(key("Enter")), "away");
});

test("holding a modifier isn't moving on", () => {
  for (const k of ["Shift", "Control", "Alt", "Meta"]) assert.equal(deleteQuestionKey(key(k)), null);
});

test("keys the webview calls Unidentified (WebKitGTK) go by the physical key (lib/keys.ts)", () => {
  const unnamed = (code: string, repeat = false) => ({ key: "Unidentified", code, repeat, target: { tagName: "DIV" } });
  assert.equal(deleteQuestionKey(unnamed("Delete")), "yes");
  assert.equal(deleteQuestionKey(unnamed("Escape")), "no");
  assert.equal(deleteQuestionKey(unnamed("ShiftLeft")), null, "a modifier");
});
