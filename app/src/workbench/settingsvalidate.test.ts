// A hand-edited settings value is checked against its declaration (type, enum, range); the SettingsService reports it per layer.

import test from "node:test";
import assert from "node:assert/strict";
import type { ConfigurationProperty } from "../extensions/api";
import { validateSetting } from "./settingsvalidate";

test("each declared type refuses a value of another type, with a message naming the key", () => {
  assert.equal(validateSetting("a", { type: "boolean" }, true), null);
  assert.match(validateSetting("a", { type: "boolean" }, "yes")!, /a must be true or false, not string "yes"/);
  assert.match(validateSetting("a", { type: "string" }, 3)!, /must be a string/);
  assert.match(validateSetting("a", { type: "array" }, {})!, /must be a list, not an object/);
  assert.match(validateSetting("a", { type: "object" }, [])!, /must be an object, not an array/);
  assert.match(validateSetting("a", { type: "number" }, null)!, /not null/);
  assert.match(validateSetting("a", { type: "number" }, NaN)!, /must be a number/);
});

test("range, integer and enum are checked", () => {
  const n = { type: "integer", minimum: 1, maximum: 5 } as const;
  assert.equal(validateSetting("n", n, 3), null);
  assert.match(validateSetting("n", n, 0)!, /at least 1/);
  assert.match(validateSetting("n", n, 6)!, /at most 5/);
  assert.match(validateSetting("n", n, 2.5)!, /whole number/);
  const e: ConfigurationProperty = { type: "string", enum: ["a", "b"] };
  assert.equal(validateSetting("e", e, "b"), null);
  assert.match(validateSetting("e", e, "c")!, /one of "a", "b", not "c"/);
});
