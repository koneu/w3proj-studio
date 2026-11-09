import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXED_START, fixedStartForRace, priorityOf, RACE_SELECTABLE, withPriority } from "./priorities";
import { playersSection } from "../../lib/script/setup";

test("a priority reads from the two masks, low first as the map script takes it", () => {
  // GoldRush-like: player 0 has 1 (low) and 3 (high)
  assert.equal(priorityOf(0b0010, 0b1000, 1), "low");
  assert.equal(priorityOf(0b0010, 0b1000, 3), "high");
  assert.equal(priorityOf(0b0010, 0b1000, 2), "none");
  assert.equal(priorityOf(0b0100, 0b0100, 2), "low");
});

test("setting one player's priority changes only its bit", () => {
  assert.deepEqual(withPriority(0b0010, 0b1000, 2, "high"), [0b0010, 0b1100]);
  assert.deepEqual(withPriority(0b0010, 0b1000, 3, "low"), [0b1010, 0b0000]);
  assert.deepEqual(withPriority(0b0010, 0b1000, 1, "none"), [0b0000, 0b1000]);
  // player 31: the top bit stays an unsigned number
  assert.deepEqual(withPriority(0, 0, 31, "high"), [0, 0x80000000]);
});

test("what is set reaches the map script's InitAllyPriorities", () => {
  const player = (id: number) => ({ id, controller: 1, race: 1, fixedStart: 0, name: `P${id}`, start: [0, 0] as [number, number], allyLow: 0, allyHigh: 0 });
  const players = [player(0), player(1), player(2)];
  [players[0].allyLow, players[0].allyHigh] = withPriority(0, 0, 2, "high");
  const script = playersSection({ info: { players, forces: [], flags: 0x0002 } } as unknown as Parameters<typeof playersSection>[0]);
  assert.match(script, /call SetStartLocPrioCount\( 0, 1 \)/);
  assert.match(script, /call SetStartLocPrio\( 0, 0, 2, MAP_LOC_PRIO_HIGH \)/);
});

test("the fixed start field: Race selectable (bit 1) follows the race, Fixed start and unknown bits stay", () => {
  assert.equal(fixedStartForRace(0, 0), RACE_SELECTABLE);
  assert.equal(fixedStartForRace(FIXED_START, 0), FIXED_START | RACE_SELECTABLE);
  assert.equal(fixedStartForRace(3, 1), FIXED_START);
  assert.equal(fixedStartForRace(2, 4), 0);
  assert.equal(fixedStartForRace(0x80000002, 2), 0x80000000, "a bit nobody knows stays, unsigned");
  assert.equal(fixedStartForRace(0x80000000, 0), 0x80000002);
});
