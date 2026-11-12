// The water offset of a terrain's tileset (TerrainArt/Water.slk, the height of its "<letter>Sha" row), applied
// to the terrain's corner waters. The stored water levels stay as they are, so a save writes the same bytes.
import type { W3Api } from "../../extensions/api";
import { parseSlk } from "../../lib/formats/text";
import { parseWaterOffsets, setWaterOffset, type Terrain } from "../../lib/terrain/w3e";

/** Reads the terrain's corner waters with its tileset's offset; a Water.slk that is missing or unreadable leaves 89.6. */
export async function applyTilesetWater(w3: { game: Pick<W3Api["game"], "readText"> }, terrain: Terrain): Promise<Terrain> {
  const text = await w3.game.readText("TerrainArt\\Water.slk").catch(() => "");
  let offset: number | undefined;
  try { offset = parseWaterOffsets(parseSlk(text)).get(terrain.tileset); } catch { /* unreadable: the default */ }
  setWaterOffset(terrain, offset);
  return terrain;
}
