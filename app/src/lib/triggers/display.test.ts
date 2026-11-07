import assert from "node:assert/strict";
import { test } from "node:test";
import { paramParts, paramText, type DisplayContext } from "./display";
import { parseTriggerData } from "./triggerdata";
import type { Param } from "./wtg";

const ctx: DisplayContext = { data: parseTriggerData("[TriggerActions]\n") };
const count: Param = { type: 1, value: "fooCount" };
const list: Param = { type: 1, value: "fooList", index: count };
const nested: Param = { type: 1, value: "fooList", index: { type: 1, value: "fooList", index: { type: 3, value: "2" } } };

test("paramText shows an array index exactly once", () => {
  assert.equal(paramText(list, ctx), "fooList[fooCount]");
  assert.equal(paramText(nested, ctx), "fooList[fooList[2]]");
  assert.equal(paramText(count, ctx), "fooCount");
});

// The trigger GUI draws the index as its own clickable link, so it needs the text without it.
test("paramParts splits the base text from the index", () => {
  assert.deepEqual(paramParts(list, ctx), { text: "fooList", index: count });
  assert.deepEqual(paramParts(count, ctx), { text: "fooCount", index: undefined });
  const { text, index } = paramParts(nested, ctx);
  assert.equal(text, "fooList");
  assert.equal(paramText(index!, ctx, "integer"), "fooList[2]");
  assert.equal(`${text}[${paramText(index!, ctx, "integer")}]`, paramText(nested, ctx));
});
