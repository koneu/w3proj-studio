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
  for (const bad of ["1.5", "2147483648", "-2147483649", ""]) {
    assert.ok("refused" in campaignNumber(bad, "Fog style", true), `whole "${bad}" must be refused`);
  }
  for (const bad of ["1e39", "-1e39", "NaN"]) assert.ok("refused" in campaignNumber(bad, "Fog density", false), `float "${bad}"`);
  assert.match((campaignNumber("1.5", "Fog style", true) as { refused: string }).refused, /Fog style must be a whole number/);
  assert.match((campaignNumber("1e39", "Fog density", false) as { refused: string }).refused, /Fog density must be a number from -3\.4e38 to 3\.4e38/);
});

test("Campaign Editor: only plain decimal text goes in, for the whole and the float fields alike", () => {
  // the stored result of accepted forms
  assert.deepEqual(campaignNumber("007", "Fog style", true), { value: 7 });
  assert.deepEqual(campaignNumber("-0", "Fog style", true), { value: 0 });
  assert.ok(Object.is((campaignNumber("-0", "Fog style", true) as { value: number }).value, 0), "-0 is stored as +0");
  assert.ok(Object.is((campaignNumber("-0.0", "Fog density", false) as { value: number }).value, 0));
  assert.deepEqual(campaignNumber("340282000000000000000000000000000000000", "Fog density", false), { value: 3.40282e38 });
  assert.deepEqual(campaignNumber("10", "Fog density", false), { value: 10 });
  // exponent, hex/binary/octal, sign, padding, bare dot, comma decimal (no locale handling), separators, Infinity
  for (const bad of ["1e3", "1E3", "1e-2", "0x10", "0b1", "0o7", "+5", " 5", "5 ", " 5 ", "\t5", "5\n", ".5", "5.", "1,5", "1_0", "--5", "- 5", "Infinity", "-Infinity", "NaN", "", " "]) {
    assert.ok("refused" in campaignNumber(bad, "Fog style", true), `whole "${bad}" refused for its form`);
    assert.ok("refused" in campaignNumber(bad, "Fog density", false), `float "${bad}" refused for its form`);
  }
  assert.ok("refused" in campaignNumber("1.5.2", "Fog density", false));
  // the float limit is the 32-bit float's, to the last digit; the whole fields are i32
  assert.ok("refused" in campaignNumber("350000000000000000000000000000000000000", "Fog density", false), "just past the largest float");
  assert.ok("refused" in campaignNumber("-350000000000000000000000000000000000000", "Fog density", false));
  assert.ok("refused" in campaignNumber("2147483648", "Fog style", true));
  assert.ok("refused" in campaignNumber("-2147483649", "Fog style", true));
  assert.ok("refused" in campaignNumber("99999999999999999999", "Fog style", true));
  // a fraction ending in zeros is still a fraction in a whole field
  assert.ok("refused" in campaignNumber("2.0", "Fog style", true));
  // no narrower limits than the type: a huge but storable value goes through
  assert.deepEqual(campaignNumber("-99999", "Fog start height", false), { value: -99999 });
  // each refusal names the field and its type
  assert.match((campaignNumber("x", "Fog style", true) as { refused: string }).refused, /^Fog style must be a whole number from -2147483648 to 2147483647/);
  assert.match((campaignNumber("x", "Fog density", false) as { refused: string }).refused, /^Fog density must be a number from -3\.4e38 to 3\.4e38/);
});
