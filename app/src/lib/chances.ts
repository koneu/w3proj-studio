// Chances that share 100%: the lines of a random group, the items of an item table's set (Map Properties) and the
// six hero chances of an AI (AI Editor). Setting one of them scales the others as the World Editor does
// (we-drive 2026-11-25, docs/testing/numeric-limits-measured.md "Rounding of the scaling"; the cases are the tests).

/** How the other chances follow the one that was set: `cap` (random groups, item sets) scales them down only when the
 *  total would pass 100, a lower chance leaves them; `sum100` (hero chances) keeps the total at 100 both ways, and a
 *  chance set while all the others are 0 goes back to 100. */
export type ChanceMode = "cap" | "sum100";

/** The chances after the one at `index` is set to `value` (a whole number, 0 to 100). The others share 100 - `value` in
 *  proportion to what they held, each rounded half up; what that leaves over or short is then taken one at a time from
 *  the largest (or given to the smallest) of them, the later line first on a tie. Lines at 0 can get one that way, as
 *  in the editor. Whole numbers always; the input is not changed. */
export function scaleChances(chances: readonly number[], index: number, value: number, mode: ChanceMode): number[] {
  const out = chances.slice();
  out[index] = value;
  const others = chances.map((_, i) => i).filter((i) => i !== index);
  const held = others.reduce((a, i) => a + chances[i], 0);
  if (mode === "cap" ? value + held <= 100 : value + held === 100) return out;
  if (held === 0) {
    // Nothing to scale: under `cap` the total is value <= 100 (handled above); the editor's hero boxes go back to 100.
    out[index] = 100;
    return out;
  }
  const rest = 100 - value;
  for (const i of others) out[i] = Math.floor((chances[i] * rest) / held + 0.5);
  let left = rest - others.reduce((a, i) => a + out[i], 0);
  // Each line's rounding is off by half at most, so |left| <= others / 2 (finite guards a broken list).
  while (left !== 0 && Number.isFinite(left)) {
    const step = Math.sign(left);
    let at = -1;
    // Ties go to the later line (>=, <=); the largest is above 0 whenever something is over.
    for (const i of others) if (at === -1 || (step > 0 ? out[i] <= out[at] : out[i] >= out[at])) at = i;
    out[at] += step;
    left -= step;
  }
  return out;
}
