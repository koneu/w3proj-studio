import assert from "node:assert/strict";
import { test } from "node:test";
import { readFixture } from "../../lib/testhelpers/testutil";
import { SOUND_LIMITS, soundNumber } from "./numbers";

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

test("SOUND_LIMITS agree with every Sound Properties value recorded from the World Editor (sound-limits-we.json)", () => {
  const rec = JSON.parse(readFixture("we-specs", "sound-limits-we.json")) as { sounds: { field: keyof typeof SOUND_LIMITS; typed: number; we: number; minusDropped?: boolean }[] };
  const kinds = { volume: "i32", fadeInRate: "u32", fadeOutRate: "u32", pitch: "f32", minDistance: "f32", maxDistance: "f32", distanceCutoff: "f32" } as const;
  assert.deepEqual(Object.keys(SOUND_LIMITS).sort(), Object.keys(kinds).sort());
  let kept = 0, changed = 0;
  for (const row of rec.sounds) {
    assert.ok(row.field in SOUND_LIMITS, `unknown field ${row.field}`);
    if (row.minusDropped) continue;
    const got = soundNumber(kinds[row.field], String(row.typed), row.field, SOUND_LIMITS[row.field]);
    if (row.we === row.typed) { kept++; assert.ok(!("refused" in got), `${row.field} = ${row.typed}: the editor kept it, Studio refused`); }
    else { changed++; assert.ok("refused" in got, `${row.field} = ${row.typed}: the editor changed it (to ${row.we}), Studio took it`); }
  }
  assert.deepEqual({ kept, changed }, { kept: 4, changed: 12 });
  // The ends themselves go through (controls), a step past them doesn't.
  for (const [field, { min, max }] of Object.entries(SOUND_LIMITS) as [keyof typeof SOUND_LIMITS, { min: number; max: number }][]) {
    for (const v of [min, max]) assert.ok(!("refused" in soundNumber(kinds[field], String(v), field, { min, max })), `${field} ${v}`);
    const step = kinds[field] === "f32" ? 0.01 : 1;
    for (const v of [min - step, max + step]) assert.ok("refused" in soundNumber(kinds[field], String(v), field, { min, max }), `${field} ${v}`);
  }
});

test("Sound Editor: the stored result and the refusal text of each field type", () => {
  // stored results: leading zeros dropped, -0 stored as +0, fractions kept exactly as typed
  assert.deepEqual(soundNumber("f32", "007.50", "Pitch"), { value: 7.5 });
  assert.ok(Object.is((soundNumber("f32", "-0.0", "Pitch") as { value: number }).value, 0));
  assert.ok(Object.is((soundNumber("u32", "-0", "Fade in rate") as { value: number }).value, 0));
  assert.deepEqual(soundNumber("f32", "0.1", "Pitch", SOUND_LIMITS.pitch), { value: 0.1 });
  assert.deepEqual(soundNumber("f32", "2", "Pitch", SOUND_LIMITS.pitch), { value: 2 });
  assert.deepEqual(soundNumber("i32", "-2147483648", "Priority"), { value: -2147483648 });
  assert.deepEqual(soundNumber("i32", "2147483647", "Priority"), { value: 2147483647 });
  // a fraction ending in zeros is a fraction in a whole field; a comma decimal isn't understood
  assert.ok("refused" in soundNumber("i32", "5.0", "Priority"));
  assert.ok("refused" in soundNumber("f32", "0,5", "Pitch", SOUND_LIMITS.pitch));
  assert.ok("refused" in soundNumber("u32", "4294967296", "Fade out rate"));
  assert.ok("refused" in soundNumber("i32", "-2147483649", "Priority"));
  // past the largest float, either way; the largest itself is fine
  assert.ok("refused" in soundNumber("f32", "350000000000000000000000000000000000000", "Min distance"));
  assert.ok("refused" in soundNumber("f32", "-350000000000000000000000000000000000000", "Min distance"));
  assert.deepEqual(soundNumber("f32", "-100", "Min distance"), { value: -100 });
  // limits are inclusive, refuse on both sides, and a refused limit text names the range
  const lim = SOUND_LIMITS.pitch;
  assert.ok("refused" in soundNumber("f32", "0.09", "Pitch", lim));
  assert.ok("refused" in soundNumber("f32", "2.01", "Pitch", lim));
  assert.equal((soundNumber("f32", "3", "Pitch", lim) as { refused: string }).refused, "Pitch must be a number from 0.1 to 2.");
  assert.equal((soundNumber("u32", "0", "Fade in rate", SOUND_LIMITS.fadeInRate) as { refused: string }).refused, "Fade in rate must be a whole number from 1 to 127.");
  // a form error inside the limits is refused too, with the same range text
  assert.equal((soundNumber("i32", " 5", "Volume", SOUND_LIMITS.volume) as { refused: string }).refused, "Volume must be a whole number from 0 to 127.");
  // only one limit given: the other end is the type's
  assert.equal((soundNumber("u32", "-1", "Fade in rate", { max: 10 }) as { refused: string }).refused, "Fade in rate must be a whole number from 0 to 10.");
  assert.deepEqual(soundNumber("i32", "-5", "Priority", { max: 10 }), { value: -5 });
  // a limit that is in negative: the stored number keeps its sign
  assert.deepEqual(soundNumber("i32", "-1", "Outside cone volume", { min: -1, max: 127 }), { value: -1 });
  assert.ok("refused" in soundNumber("i32", "-2", "Outside cone volume", { min: -1, max: 127 }));
});
