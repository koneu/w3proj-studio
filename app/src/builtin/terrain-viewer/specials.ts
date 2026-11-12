// The special doodads (war3map.doo's second list: caves, collapsed cliffs) as drawable placements. They are placed by
// tile, so the editor turns each into a position, a facing and a height; nothing here writes to the doodad file.

import type { W3Api } from "../../extensions/api";
import type { Placed, Skin } from "./objects";
import { loadPathingData, type SpecialDoodad } from "./pathmap";

/** The facing a special doodad stands at: the one its pathing texture is drawn for (pathmap's stamp, 270°). */
export const SPECIAL_FACING = -Math.PI / 2;

/** Its pathing texture's size in cells, unturned. */
export interface Footprint { width: number; height: number }

/** The specials as placed doodads: the model's origin is the middle of the pathing footprint, whose bottom left is
 *  the tile's (as buildPathingMap stamps it), on the ground there (`groundAt`). Ids with no entry in `skins` (no
 *  model) are left out; one whose footprint isn't known stands in the middle of its tile. The result is for drawing
 *  only: it is not part of the doodad file. */
export function specialPlacements(specials: readonly SpecialDoodad[], skins: ReadonlyMap<string, Skin>,
  footprint: (id: string) => Footprint | undefined, offset: { x: number; y: number }, groundAt: (x: number, y: number) => number): Placed[] {
  const out: Placed[] = [];
  for (const sp of specials) {
    if (!skins.has(sp.id)) continue;
    const f = footprint(sp.id);
    const x = offset.x + sp.x * 128 + (f ? f.width * 16 : 64), y = offset.y + sp.y * 128 + (f ? f.height * 16 : 64);
    out.push({ id: sp.id, variation: 0, position: [x, y, groundAt(x, y)], angle: SPECIAL_FACING, scale: [1, 1, 1] });
  }
  return out;
}

/** The pathing texture sizes of the specials' types, as buildPathingMap reads them (`readFile`: the map's imports,
 *  then the game); a type whose texture can't be read isn't in the result. */
export async function specialFootprints(w3: W3Api, specials: readonly SpecialDoodad[],
  readFile: (path: string) => Promise<Uint8Array>): Promise<Map<string, Footprint>> {
  const out = new Map<string, Footprint>();
  if (!specials.length) return out;
  const data = await loadPathingData(w3, readFile);
  for (const id of new Set(specials.map((s) => s.id))) {
    const info = data.placedTex(id);
    if (!info?.path || info.dest) continue;
    const { image } = await data.placedImage(info);
    if (image) out.set(id, { width: image.width, height: image.height });
  }
  return out;
}
