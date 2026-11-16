import assert from "node:assert/strict";
import { test } from "node:test";
import { lightNumber } from "./numbers";

test("Lighting Editor: a number is a 32-bit float or refused; the hour stays within the day", () => {
  // control: valid values pass, fractions included
  assert.deepEqual(lightNumber("0.25", "Value"), { value: 0.25 });
  assert.deepEqual(lightNumber("-3.5", "Value"), { value: -3.5 });
  assert.deepEqual(lightNumber("12.5", "Hour", { min: 0, max: 24 }), { value: 12.5 });
  assert.deepEqual(lightNumber("0", "Hour", { min: 0, max: 24 }), { value: 0 });
  assert.deepEqual(lightNumber("24", "Hour", { min: 0, max: 24 }), { value: 24 });
  for (const bad of ["1e39", "-1e39", "Infinity", "NaN", "", " ", "abc"]) {
    assert.ok("refused" in lightNumber(bad, "Value"), `"${bad}" must be refused`);
  }
  // refused, not pulled into 0..24
  for (const bad of ["-0.5", "24.5", "100"]) {
    const r = lightNumber(bad, "Hour", { min: 0, max: 24 });
    assert.ok("refused" in r, `hour ${bad} must be refused`);
    assert.match((r as { refused: string }).refused, /Hour must be a number from 0 to 24/);
  }
});
