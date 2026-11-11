// Ground variations: which of a texture's tile images a corner shows.

import type { CornerLog } from "./cliffs";
import { randomVariation, type Terrain } from "./w3e";

/** Reset Texture Variations: every corner's ground variation rolled again with the World Editor's spread
 *  (randomVariation), as the World Editor does (we-drive, 2026-11-11: it re-randomises, it doesn't write one value).
 *  Cliff variation, ramps, heights, flags and textures stay. Returns how many corners changed; each is reported to
 *  `log` first. */
export function resetVariations(t: Terrain, log: CornerLog, random: () => number = Math.random): number {
  let n = 0;
  t.corners.forEach((c, i) => {
    const v = randomVariation(random);
    if (c.variation === v) return;
    log.touch(t, i);
    c.variation = v;
    n++;
  });
  return n;
}
