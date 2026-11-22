// The one colour of a texture as the World Editor's minimap gives it (the terrain view's minimap, Export Minimap, and
// the Terrain Layout editor's ground colours).

import type { DecodedImage } from "./index";

/** The colour the World Editor's minimap gives a texture: its smallest mip level as the file stores it (1×1 in a
 *  full chain, which is not the plain average of the full-size picture), averaged by alpha where it is bigger; null
 *  when it is all transparent. */
export function smallestMipColor(image: DecodedImage): [number, number, number] | null {
  const mip = image.mip(image.mipCount - 1);
  const sum = [0, 0, 0];
  let weight = 0;
  for (let i = 0; i < mip.width * mip.height; i++) {
    const a = mip.rgba[i * 4 + 3];
    for (let k = 0; k < 3; k++) sum[k] += mip.rgba[i * 4 + k] * a;
    weight += a;
  }
  return weight > 0 ? sum.map((s) => s / weight) as [number, number, number] : null;
}
