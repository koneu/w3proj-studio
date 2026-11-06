// Ground variations: which of a texture's tile images a corner shows.

import type { CornerLog } from "./cliffs";
import type { Terrain } from "./w3e";

/** The plain variation: the full tile, without the extended patches. It's what randomVariation
 *  picks most often (16, then 17); textures with no extended part show plain tiles for every value.
 *  Whether the World Editor's Reset Texture Variations writes exactly 16 is not verified. */
export const PLAIN_VARIATION = 16;

/** Sets every corner's ground variation to the plain one. Cliff variation, ramps, heights, flags and
 *  textures stay. Returns how many corners changed; each is reported to `log` first. */
export function resetVariations(t: Terrain, log: CornerLog): number {
  let n = 0;
  t.corners.forEach((c, i) => {
    if (c.variation === PLAIN_VARIATION) return;
    log.touch(t, i);
    c.variation = PLAIN_VARIATION;
    n++;
  });
  return n;
}
