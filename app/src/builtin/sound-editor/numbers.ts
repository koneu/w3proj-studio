// A number typed into the Sound Editor: war3map.w3s stores the fade rates as u32, volume, priority and the outside cone
// volume as i32 and pitch, distances and cone angles as f32 (crates/w3proj/formats/sounds.json). A fraction in an integer
// field, a value past the type or outside the editor's own limits for the field (volume 0 to 127) is refused (user
// decision 2026-11-15: refuse, never round, clamp or wrap). The sound stays as it was. The limits are the World
// Editor's Sound Properties' (SOUND_LIMITS); the cone fields, which that dialog doesn't have, keep the old ones (cone
// angles 0..360, outside cone volume -1..127).

import { typedBetween, type StoredNumber } from "../../lib/formats/numbers";

/** The typed value of a sound number field: the value, or why it is refused. */
export function soundNumber(kind: StoredNumber, typed: string, label: string, limits: { min?: number; max?: number } = {}): { value: number } | { refused: string } {
  return typedBetween(kind, typed, label, limits);
}

/**
 * What the World Editor's Sound Properties keeps of a typed number: it puts anything past these on the nearest end
 * when the box is left or OK pressed (we-drive 2026-11-18, branch we-compare-4, sound-order.w3m, four sounds edited and
 * saved; tests/fixtures/we-specs/sound-limits-we.json): Volume 200 and 128 gave 127; Fade In Rate 99999 gave 127, 0
 * gave 1; Fade Out Rate 5000000000 gave 127; Pitch 100 gave 2, 0 and 0.001 gave 0.1; Min and Max Distance and
 * Distance Cutoff 99999999 gave 100000, 0 stayed. A `-` typed into a whole-number box is dropped (Volume -5 became 5,
 * a distance -100 became 100). Studio refuses such a value instead. Music's own dialog wasn't measured.
 */
export const SOUND_LIMITS = {
  volume: { min: 0, max: 127 },
  fadeInRate: { min: 1, max: 127 },
  fadeOutRate: { min: 1, max: 127 },
  pitch: { min: 0.1, max: 2 },
  minDistance: { min: 0, max: 100000 },
  maxDistance: { min: 0, max: 100000 },
  distanceCutoff: { min: 0, max: 100000 },
} as const;
