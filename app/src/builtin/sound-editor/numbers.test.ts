import assert from "node:assert/strict";
import { test } from "node:test";
import { soundNumber } from "./numbers";

test("Sound Editor: a number the .w3s can't hold is refused, never rounded, clamped or wrapped", () => {
  // control: valid values pass unchanged, the edges too
  assert.deepEqual(soundNumber("i32", "0", "Volume", { min: 0, max: 127 }), { value: 0 });
  assert.deepEqual(soundNumber("i32", "127", "Volume", { min: 0, max: 127 }), { value: 127 });
  assert.deepEqual(soundNumber("i32", "007", "Volume", { min: 0, max: 127 }), { value: 7 });
  assert.deepEqual(soundNumber("f32", "-3.5", "Pitch"), { value: -3.5 });
  assert.deepEqual(soundNumber("i32", "-0", "Volume"), { value: 0 });
  assert.deepEqual(soundNumber("u32", "4294967295", "Fade in rate"), { value: 4294967295 });
  assert.deepEqual(soundNumber("i32", "-1", "Outside cone volume", { min: -1, max: 127 }), { value: -1 });
  assert.deepEqual(soundNumber("f32", "0.75", "Pitch", { min: 0 }), { value: 0.75 });
  assert.deepEqual(soundNumber("f32", "360", "Inside cone angle", { min: 0, max: 360 }), { value: 360 });
  // refused
  for (const bad of ["1.5", "128", "-1", "1e3", "", "abc", "NaN", "Infinity"]) {
    assert.ok("refused" in soundNumber("i32", bad, "Volume", { min: 0, max: 127 }), `volume "${bad}" must be refused`);
  }
  // only plain decimal text: no exponent, hex/binary/octal, sign, padding, bare or trailing dot, Infinity, even with no max
  for (const bad of ["1e3", "1E3", "1e-2", "0x10", "0b1", "0o7", "+5", " 5", "5 ", " 5 ", "\t5", ".5", "5.", "1,5", "1_0", "--5", "- 5", "Infinity", "-Infinity", ""]) {
    assert.ok("refused" in soundNumber("f32", bad, "Pitch"), `f32 "${bad}" refused for its form`);
    assert.ok("refused" in soundNumber("i32", bad, "Priority"), `i32 "${bad}" refused for its form`);
    assert.ok("refused" in soundNumber("u32", bad, "Fade in rate"), `u32 "${bad}" refused for its form`);
  }
  assert.ok("refused" in soundNumber("f32", "1.5.2", "Pitch"));
  for (const bad of ["-1", "0.5", "4294967296", "1e10"]) assert.ok("refused" in soundNumber("u32", bad, "Fade in rate"), `fade "${bad}"`);
  for (const bad of ["1e39", "-1", "Infinity", "x"]) assert.ok("refused" in soundNumber("f32", bad, "Pitch", { min: 0 }), `pitch "${bad}"`);
  assert.ok("refused" in soundNumber("f32", "361", "Inside cone angle", { min: 0, max: 360 }));
  assert.ok("refused" in soundNumber("i32", "2147483648", "Priority"));
  assert.ok("refused" in soundNumber("i32", "1.5", "Priority"));
  assert.match((soundNumber("i32", "128", "Volume", { min: 0, max: 127 }) as { refused: string }).refused, /Volume must be a whole number from 0 to 127/);
});
