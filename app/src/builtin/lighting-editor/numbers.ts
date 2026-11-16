// A number typed into the Lighting Editor: the lighting model's values are stored as 32-bit floats (MDX), so a value
// past what a float holds is refused (user decision 2026-11-15: refuse, never clamp), and so is one outside the editor's
// own limits (the hour of a key, 0 to 24). The model stays as it was.

import { typedBetween } from "../../lib/formats/numbers";

/** The typed value of a lighting number field: the value, or why it is refused. */
export function lightNumber(typed: string, label: string, limits: { min?: number; max?: number } = {}): { value: number } | { refused: string } {
  return typedBetween("f32", typed, label, limits);
}
