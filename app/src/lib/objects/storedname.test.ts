import { test } from "node:test";
import assert from "node:assert/strict";
import { storedName } from "./metadata";

const we = new Map([["WESTRING_DOOD_APMS", "Apple Tree"]]);

test("a WESTRING_ key becomes its text; a plain value and an unknown key stay", () => {
  assert.equal(storedName(we, "WESTRING_DOOD_APMS"), "Apple Tree");
  assert.equal(storedName(we, "Footman"), "Footman");
  assert.equal(storedName(we, "WESTRING_NOPE"), "WESTRING_NOPE");
});
