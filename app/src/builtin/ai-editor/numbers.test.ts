import assert from "node:assert/strict";
import { test } from "node:test";
import { aiNumber, GAME_SPEED_LIMITS, repeatWavesLimits } from "./numbers";

test("AI Editor: game speed 1 to 25 and Repeat Waves up to the wave count, as the World Editor holds them", () => {
  assert.deepEqual(aiNumber("1", "Game Speed", GAME_SPEED_LIMITS), { value: 1 });
  assert.deepEqual(aiNumber("25", "Game Speed", GAME_SPEED_LIMITS), { value: 25 });
  assert.ok("refused" in aiNumber("0", "Game Speed", GAME_SPEED_LIMITS));
  assert.ok("refused" in aiNumber("26", "Game Speed", GAME_SPEED_LIMITS));
  assert.deepEqual(aiNumber("2", "Repeat Waves", repeatWavesLimits(2)), { value: 2 });
  assert.deepEqual(aiNumber("0", "Repeat Waves", repeatWavesLimits(2)), { value: 0 });
  assert.ok("refused" in aiNumber("3", "Repeat Waves", repeatWavesLimits(2)));
  assert.ok("refused" in aiNumber("2", "Repeat Waves", repeatWavesLimits(1)));
});

test("AI Editor: a .wai number (u32) is taken whole or refused, never rounded or clamped", () => {
  // control: valid values pass unchanged, the type's edges too
  assert.deepEqual(aiNumber("0", "Team"), { value: 0 });
  assert.deepEqual(aiNumber("12", "Team"), { value: 12 });
  assert.deepEqual(aiNumber("4294967295", "Delay", { min: 0 }), { value: 4294967295 });
  assert.deepEqual(aiNumber("75", "Handicap", { min: 50, max: 100 }), { value: 75 });
  assert.deepEqual(aiNumber("50", "Handicap", { min: 50, max: 100 }), { value: 50 });
  assert.deepEqual(aiNumber("100", "Handicap", { min: 50, max: 100 }), { value: 100 });
  for (const bad of [" 12 ", "+5", "0x10", "1e3", "1.5", "2.4999", "-1", "4294967296", "1e10", "", "  ", "abc", "NaN", "Infinity"]) {
    assert.ok("refused" in aiNumber(bad, "Team"), `"${bad}" must be refused`);
  }
  // the editor's own limits refuse instead of pulling the value in
  const low = aiNumber("49", "Handicap", { min: 50, max: 100 });
  const high = aiNumber("101", "Handicap", { min: 50, max: 100 });
  assert.ok("refused" in low && "refused" in high);
  assert.match((low as { refused: string }).refused, /Handicap must be a whole number from 50 to 100/);
  assert.ok("refused" in aiNumber("101", "Workers", { min: 0, max: 100 }));
});
