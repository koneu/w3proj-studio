// Display names of the tilesets (the w3e tileset letter).

export const TILESETS: Record<string, string> = {
  A: "Ashenvale", B: "Barrens", C: "Felwood", D: "Dungeon", F: "Lordaeron Fall", G: "Underground",
  I: "Icecrown Glacier", J: "Dalaran Ruins", K: "Black Citadel", L: "Lordaeron Summer", N: "Northrend",
  O: "Outland", P: "Cityscape Ruins", Q: "Village Fall", R: "Lordaeron Capital Ruins", V: "Village", W: "Lordaeron Winter",
  X: "Dalaran", Y: "Cityscape", Z: "Sunken Ruins", e: "Lordaeron Capital", u: "Undercity", M: "Misc",
};

/** A tileset's own ground tiles from Terrain.slk's rows (`rows` in the table's order): those whose id starts with the
 *  tileset's letter (case counts: "e" isn't "E"), the first 16. That list, in that order, is what a new map gets and
 *  what the World Editor draws by slot under the w3e flag "custom tilesets" 0 (w3e.ts drawnGroundTiles); the same rule
 *  as newmap.ts loadTilesets. */
export function ownGroundTiles(rows: readonly { tileID?: string }[], tileset: string): string[] {
  return rows.flatMap((r) => (r.tileID && r.tileID[0] === tileset ? [r.tileID] : [])).slice(0, 16);
}

/** The w3e's "custom tiles" flag for a ground tile list: 0 when it is exactly the tileset's own list (`own`, in
 *  order), 1 otherwise. That's what the World Editor writes: of the game's 375 maps, 236 have their tileset's own
 *  list and the flag 0 (11 more have it 1), and none with another list (the same tiles in another order too) has 0.
 *  With the tileset's list unknown it stays 1, which the game reads either way. */
export function customTilesFlag(tiles: readonly string[], own: readonly string[] | undefined): 0 | 1 {
  return own && own.length === tiles.length && own.every((t, i) => t === tiles[i]) ? 0 : 1;
}
