// war3map.w3i's flag 0x0008 as the World Editor's save leaves it: on when war3map.w3e's custom tilesets flag is set, off
// when it isn't. Measured with we-drive 2026-11-18 (branch we-compare-3; spec tests/we-compare/tileset-flag-we.json,
// inputs make-melee-valid.mjs ct-* cases): flat.w3x with custom tilesets on gets it whatever the ground list holds (the
// tileset's own list, Zdrt of The Frozen Throne used or not, Barrens' Bdrt) and keeps it; with custom tilesets off the
// save clears it (flags 0x9c1c to 0x9c14) and painting a tile changes nothing. All 273 maps under the game's Maps folder
// and the 14 of smoketest_maps agree (77 and 3 with custom tilesets, every one with the flag). Earlier documentation
// called the bit "playable area was large and never shrunk"; this editor doesn't keep that.

/** The w3i flag. */
export const CUSTOM_TILESETS_FLAG = 0x0008;

/** The flags with 0x0008 following the terrain's custom tilesets flag (customTilesetsRaw, any non-zero value counting
 *  as on, as drawnGroundTiles reads it); unchanged when the terrain isn't known (missing or unreadable, or without that
 *  value). */
export function tilesetFlagAfter(flags: number, terrain: { customTilesetsRaw?: number } | null | undefined): number {
  if (!terrain || typeof terrain.customTilesetsRaw !== "number") return flags;
  return (terrain.customTilesetsRaw !== 0 ? flags | CUSTOM_TILESETS_FLAG : flags & ~CUSTOM_TILESETS_FLAG) >>> 0;
}
