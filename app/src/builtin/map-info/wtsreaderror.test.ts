import { test } from "node:test";
import assert from "node:assert/strict";
import { wtsReadError } from "./movetexts";

test("a war3map.wts that isn't UTF-8 gets a plain message, other errors pass through", () => {
  const bad = Object.assign(new Error("x/war3map.wts is not valid UTF-8"), { name: "NotUtf8Error" });
  assert.equal((wtsReadError(bad) as Error).message, "war3map.wts isn't UTF-8 text, so no texts were moved. Nothing changed.");
  const other = new Error("disk gone");
  assert.equal(wtsReadError(other), other);
});
