// A number typed into the AI Editor: every number of a .wai is a u32 (lib/ai/wai.ts), so a fraction, a negative or a
// value past 4294967295 is refused (user decision 2026-11-15: refuse, never round, clamp or wrap), and so is a value
// outside the editor's own limits for the field (a handicap of 50 to 100). The AI stays as it was.

import { typedBetween } from "../../lib/formats/numbers";

/** The typed value of a .wai number field: the value, or why it is refused. */
export function aiNumber(typed: string, label: string, limits: { min?: number; max?: number } = {}): { value: number } | { refused: string } {
  return typedBetween("u32", typed, label, limits);
}

/** The limits the World Editor's AI Editor holds a typed field to (we-drive 2026-11-18: a value past the end is pulled in to it
 *  there, here it is refused): the test game's speed 1 to 25, and Repeat Waves up to the number of attack waves. */
export const HARVEST_WORKER_LIMITS = { min: 1, max: 100 };
export const GAME_SPEED_LIMITS = { min: 1, max: 25 };
export const repeatWavesLimits = (waves: number) => ({ min: 0, max: waves });
