import assert from "node:assert/strict";
import { test } from "node:test";
import { resultsStale } from "./projectkey";

test("results of one project are stale for another, or for none", () => {
  assert.equal(resultsStale("C:/maps/a", "C:/maps/b"), true);
  assert.equal(resultsStale("C:/maps/a", null), true);
  assert.equal(resultsStale("C:/maps/a", "C:/maps/a"), false);
});
