// The special doodads (war3map.doo's second list: caves, collapsed cliffs) as drawable placements. They are placed by
// tile, so the editor turns each into a position, a facing and a height; nothing here writes to the doodad file.

import type { W3Api } from "../../extensions/api";
import type { Terrain } from "../../lib/terrain/w3e";
import { cliffRetexture, type CliffType } from "./cliffs";
import type { Placed, PlacedTextures, Skin } from "./objects";
import { loadPathingData, type SpecialDoodad } from "./pathmap";

/** The facing a special doodad stands at: the one its pathing texture is drawn for (pathmap's stamp, 270°). */
export const SPECIAL_FACING = -Math.PI / 2;

/** Its pathing texture's size in cells, unturned. */
export interface Footprint { width: number; height: number }

/** Tiles x0..x1, y0..y1 (inclusive). */
export interface TileRect { x0: number; y0: number; x1: number; y1: number }

/** The tiles a special's pathing footprint covers (4 cells a tile; its tile alone when the footprint isn't known). */
export function specialTiles(sp: Pick<SpecialDoodad, "x" | "y">, f: Footprint | undefined): TileRect {
  const w = f ? Math.max(1, Math.ceil(f.width / 4)) : 1, h = f ? Math.max(1, Math.ceil(f.height / 4)) : 1;
  return { x0: sp.x, y0: sp.y, x1: sp.x + w - 1, y1: sp.y + h - 1 };
}

/** The specials as placed doodads: the model's origin is the middle of the pathing footprint, whose bottom left is
 *  the tile's (as buildPathingMap stamps it), at the height `groundAt` gives for it and the tiles it covers. Ids with
 *  no entry in `skins` (no model) are left out; one whose footprint isn't known stands in the middle of its tile.
 *  The result is for drawing only: it is not part of the doodad file. */
export function specialPlacements(specials: readonly SpecialDoodad[], skins: ReadonlyMap<string, Skin>,
  footprint: (id: string) => Footprint | undefined, offset: { x: number; y: number },
  groundAt: (x: number, y: number, tiles: TileRect) => number): Placed[] {
  const out: Placed[] = [];
  for (const sp of specials) {
    if (!skins.has(sp.id)) continue;
    const f = footprint(sp.id);
    const x = offset.x + sp.x * 128 + (f ? f.width * 16 : 64), y = offset.y + sp.y * 128 + (f ? f.height * 16 : 64);
    out.push({ id: sp.id, variation: 0, position: [x, y, groundAt(x, y, specialTiles(sp, f))], angle: SPECIAL_FACING, scale: [1, 1, 1] });
  }
  return out;
}

/** The height a special doodad's model stands at, before the ground: like a cliff model it stands on the lowest
 *  cliff layer of the corners it covers, (layer - 2) × 128, and follows the ground's height (without layers) per
 *  vertex. The models span one layer (0 to 128), from the low side of a cliff to its high side; placed on the
 *  ground at their middle instead, they float above the cliff's top as a flat, hard-edged square. */
export function specialBase(t: Terrain, tiles: TileRect): number {
  let low = Infinity;
  for (let y = Math.max(0, tiles.y0); y <= Math.min(t.height - 1, tiles.y1 + 1); y++) {
    for (let x = Math.max(0, tiles.x0); x <= Math.min(t.width - 1, tiles.x1 + 1); x++) low = Math.min(low, t.corners[y * t.width + x].layer);
  }
  return Number.isFinite(low) ? (low - 2) * 128 : 0;
}

/** The tile indexes (y × (width - 1) + x) the specials cover, inside the map: the terrain draws no cliff model there,
 *  the special is the cliff (a cave's mouth would be behind the cliff's wall otherwise). */
export function specialCliffTiles(t: Terrain, rects: readonly TileRect[]): Set<number> {
  const out = new Set<number>(), tw = t.width - 1;
  for (const r of rects) {
    for (let y = Math.max(0, r.y0); y <= Math.min(t.height - 2, r.y1); y++) {
      for (let x = Math.max(0, r.x0); x <= Math.min(tw - 1, r.x1); x++) out.add(y * tw + x);
    }
  }
  return out;
}

/** The cliff type a special doodad at world position x, y shows: the special models (cliff collapses, caves, ruined
 *  floors) draw their cliff part with replaceable texture 11 (classic) or the HD cliff placeholders, which stand for
 *  the cliff texture of the ground they're on, as a cliff model's do. Like a cliff model it's the type of the
 *  bottom-left corner of its tile (planCliffs), here the tile under the model's origin; `list` is cliffList's.
 *  Undefined when the map has no cliff types. */
export function specialCliffType(t: Terrain, list: readonly CliffType[], x: number, y: number): CliffType | undefined {
  const cx = Math.min(t.width - 1, Math.max(0, Math.floor((x - t.offsetX) / 128)));
  const cy = Math.min(t.height - 1, Math.max(0, Math.floor((y - t.offsetY) / 128)));
  return list[t.corners[cy * t.width + cx]?.cliffTexture ?? 0] ?? list[0];
}

/** The textures a special doodad of cliff type `type` is drawn with: the type's texture as replaceable 11 (without
 *  it the game's generic ReplaceableTextures\Cliff\Cliff0, a summer cliff with green grass and tan rock), and its HD
 *  set for the placeholders. */
export function specialTextures(type: Pick<CliffType, "texDir" | "texFile">): PlacedTextures {
  const texture = `${type.texDir}\\${type.texFile}.blp`;
  return { key: texture, replaceable: { 11: texture }, retexture: (p, slot) => cliffRetexture(p, type, slot) };
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
