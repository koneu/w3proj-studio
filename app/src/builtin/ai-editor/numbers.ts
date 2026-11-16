// A number typed into the AI Editor: every number of a .wai is a u32 (lib/ai/wai.ts), so a fraction, a negative or a
// value past 4294967295 is refused (user decision 2026-11-15: refuse, never round, clamp or wrap), and so is a value
// outside the editor's own limits for the field (a handicap of 50 to 100). The AI stays as it was.

import { typedBetween } from "../../lib/formats/numbers";

/** The typed value of a .wai number field: the value, or why it is refused. */
export function aiNumber(typed: string, label: string, limits: { min?: number; max?: number } = {}): { value: number } | { refused: string } {
  return typedBetween("u32", typed, label, limits);
}
