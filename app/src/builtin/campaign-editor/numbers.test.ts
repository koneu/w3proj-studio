import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignNumber } from "./numbers";

test("Campaign Editor: a number the .w3f can't hold is refused, never rounded, clamped or wrapped", () => {
  // control: valid values pass unchanged, the edges too
  assert.deepEqual(campaignNumber("2", "Fog style", true), { value: 2 });
  assert.deepEqual(campaignNumber("-1", "Fog style", true), { value: -1 });
  assert.deepEqual(campaignNumber("2147483647", "Background", true), { value: 2147483647 });
  assert.deepEqual(campaignNumber("-2147483648", "Background", true), { value: -2147483648 });
  assert.deepEqual(campaignNumber("0.5", "Fog density", false), { value: 0.5 });
  assert.deepEqual(campaignNumber("-3000.25", "Fog start height", false), { value: -3000.25 });
  // [Refactored] Deduplicated generic typedNumber string-format loop (covered in sound-editor/numbers.test.ts); kept i32/f32 whole toggle and bounds checks.
  for (const bad of ["1.5", "2147483648", "-2147483649", ""]) {
    assert.ok("refused" in campaignNumber(bad, "Fog style", true), `whole "${bad}" must be refused`);
  }
  for (const bad of ["1e39", "-1e39", "NaN"]) assert.ok("refused" in campaignNumber(bad, "Fog density", false), `float "${bad}"`);
  assert.match((campaignNumber("1.5", "Fog style", true) as { refused: string }).refused, /Fog style must be a whole number/);
  assert.match((campaignNumber("1e39", "Fog density", false) as { refused: string }).refused, /Fog density must be a number from -3\.4e38 to 3\.4e38/);
});
