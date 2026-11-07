import assert from "node:assert/strict";
import { test } from "node:test";
import { copyText } from "./dom";

test("copyText writes exactly the given text to the clipboard", async () => {
  const got: string[] = [];
  assert.equal(await copyText("War3.w3mod: not found\nline 2", { writeText: async (t) => { got.push(t); } }), true);
  assert.deepEqual(got, ["War3.w3mod: not found\nline 2"]);
});

test("copyText reports a refusing or missing clipboard instead of throwing", async () => {
  assert.equal(await copyText("x", { writeText: async () => { throw new Error("denied"); } }), false);
  assert.equal(await copyText("x", undefined), false);
});
