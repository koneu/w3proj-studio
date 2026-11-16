// A number typed into the Sound Editor: war3map.w3s stores the fade rates as u32, volume, priority and the outside cone
// volume as i32 and pitch, distances and cone angles as f32 (crates/w3proj/formats/sounds.json). A fraction in an integer
// field, a value past the type or outside the editor's own limits for the field (volume 0 to 127) is refused (user
// decision 2026-11-15: refuse, never round, clamp or wrap). The sound stays as it was. The editor's limits are the ones
// it already had (volume 0..127, cone angles 0..360, outside cone volume -1..127, no negatives); they are not World
// Editor numbers.

import { typedBetween, type StoredNumber } from "../../lib/formats/numbers";

/** The typed value of a sound number field: the value, or why it is refused. */
export function soundNumber(kind: StoredNumber, typed: string, label: string, limits: { min?: number; max?: number } = {}): { value: number } | { refused: string } {
  return typedBetween(kind, typed, label, limits);
}
