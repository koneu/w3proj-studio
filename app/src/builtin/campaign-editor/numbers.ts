// A number typed into the Campaign Editor: war3campaign.w3f stores the screen preset, ambient sound preset and fog style
// as i32 and the fog start, end and density as f32 (crates/w3proj/formats/campaign.json). A fraction in an integer
// field or a value past the type is refused (user decision 2026-11-15: refuse, never round, clamp or wrap); the campaign
// stays as it was. No narrower limits: the files' own ranges aren't known, so none are guessed.

import { typedBetween } from "../../lib/formats/numbers";

/** The typed value of a campaign number field (`whole`: an i32 field, else a 32-bit float): the value, or why it is refused. */
export function campaignNumber(typed: string, label: string, whole: boolean): { value: number } | { refused: string } {
  return typedBetween(whole ? "i32" : "f32", typed, label);
}
