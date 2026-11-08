// The map's ground tile list: what uses each tile, and changing the list with the corners following
// (Tiles…: order, remove, clean up). A tile is in use where corners are painted with it, and also where a
// cliff is drawn with its cliff type: cliff types follow the ground tile list (see cliffList), so a tile
// no corner shows can still be what a cliff is made of.

import { customTilesFlag } from "../../lib/terrain/tilesets";
import type { Terrain } from "../../lib/terrain/w3e";
import { cliffList, type CliffType } from "./cliffs";

/** Per ground tile (by index in the map's list): corners painted with it, and cliff tiles drawn with its cliff type. */
export interface TileUse { ground: number[]; cliffs: number[] }

/** What uses each of the map's ground tiles. A cliff tile is one whose corners aren't all on one layer and not all
 *  ramp (where planCliffs draws a cliff or ramp model); its bottom-left corner's cliff type decides, 15 or a number
 *  past the list meaning the first type, as the renderer takes it. */
export function tileUse(t: Terrain, types: ReadonlyMap<string, CliffType>): TileUse {
  const ground = t.groundTiles.map(() => 0), cliffs = t.groundTiles.map(() => 0);
  for (const c of t.corners) if (c.texture < ground.length) ground[c.texture]++;
  const list = cliffList(t, types as Map<string, CliffType>);
  if (!list.length) return { ground, cliffs };
  const owner = list.map((type) => t.groundTiles.indexOf(type.groundTile));
  const at = (x: number, y: number) => t.corners[y * t.width + x];
  for (let y = 0; y < t.height - 1; y++) {
    for (let x = 0; x < t.width - 1; x++) {
      const bl = at(x, y), cs = [bl, at(x, y + 1), at(x + 1, y + 1), at(x + 1, y)];
      if (cs.every((c) => c.layer === bl.layer) || cs.every((c) => c.ramp)) continue;
      const i = owner[bl.cliffTexture] ?? owner[0];
      if (i >= 0) cliffs[i]++;
    }
  }
  return { ground, cliffs };
}

/** The tiles nothing uses, by index. */
export function unusedTiles(use: TileUse): number[] {
  return use.ground.flatMap((n, i) => (n === 0 && use.cliffs[i] === 0 ? [i] : []));
}

/** A removal of several tiles at once: the new list, and where each old index goes (a removed tile's to its
 *  replacement's new index). */
export interface RemovalPlan { tiles: string[]; map: (oldIndex: number) => number; removed: string[] }

/** Plans taking the tiles `remove` (indices) out of the list. A tile in use needs a replacement in `replace`
 *  (its index → the index of a tile that stays); its corners and cliffs get that one. A tile nothing uses needs
 *  none. Throws with what's wrong: at least one tile stays, and a replacement is a tile that stays. */
export function planRemoval(tiles: readonly string[], remove: readonly number[], replace: ReadonlyMap<number, number>, use: TileUse): RemovalPlan {
  const gone = new Set(remove);
  for (const i of gone) if (!Number.isInteger(i) || i < 0 || i >= tiles.length) throw new Error(`There is no ground tile ${i} in the map's list (0 to ${tiles.length - 1}).`);
  if (!gone.size) throw new Error("No ground tile to remove.");
  if (gone.size >= tiles.length) throw new Error("A map needs at least one ground tile: keep one.");
  const kept = tiles.map((_, i) => i).filter((i) => !gone.has(i));
  const newIndex = new Map(kept.map((old, i) => [old, i]));
  const to = new Map<number, number>();
  for (const i of gone) {
    const used = (use.ground[i] ?? 0) + (use.cliffs[i] ?? 0) > 0;
    const r = replace.get(i);
    if (r === undefined) {
      if (used) throw new Error(`${tiles[i]} is in use (${use.ground[i]} corners, ${use.cliffs[i]} cliff tiles): say which tile replaces it.`);
      to.set(i, 0);
      continue;
    }
    const n = newIndex.get(r);
    if (n === undefined) throw new Error(`${tiles[i]} can't be replaced by ${tiles[r] ?? r}: that one ${r >= 0 && r < tiles.length ? "is removed too" : "isn't in the list"}.`);
    to.set(i, n);
  }
  return {
    tiles: kept.map((i) => tiles[i]),
    map: (old) => to.get(old) ?? newIndex.get(old) ?? Math.min(old, kept.length - 1),
    removed: [...gone].sort((a, b) => a - b).map((i) => tiles[i]),
  };
}

/** Gives the terrain a new ground tile list: `map` takes each old index to its new one. Corners are repainted,
 *  cliff types follow (a type that stays keeps its cliffs; a removed one's cliffs take the cliff type of the tile
 *  that replaced its ground tile, else that of the corner's ground, else the first), the stored cliff list is the
 *  derived order then entries no tile uses, and the custom tiles flag follows the list (`own`: the tileset's own
 *  list, see customTilesFlag). */
export function applyTileList(t: Terrain, tiles: readonly string[], map: (oldIndex: number) => number, types: ReadonlyMap<string, CliffType>, own: readonly string[] | undefined): void {
  const all = types as Map<string, CliffType>;
  const beforeGround = [...t.groundTiles], beforeCliffs = [...t.cliffTiles];
  const oldCliffs = cliffList(t, all);
  t.groundTiles = [...tiles];
  const newCliffs = cliffList(t, all);
  const cliffOf = (tile: string | undefined) => newCliffs.findIndex((c) => c.groundTile === tile);
  for (const c of t.corners) {
    c.texture = map(c.texture);
    if (c.cliffTexture < 15 && oldCliffs.length) {
      const type = oldCliffs[c.cliffTexture];
      const same = type ? newCliffs.indexOf(type) : -1;
      const replaced = same < 0 && type ? cliffOf(tiles[map(beforeGround.indexOf(type.groundTile))]) : -1;
      c.cliffTexture = same >= 0 ? same : replaced >= 0 ? replaced : Math.max(0, cliffOf(tiles[c.texture]));
    }
  }
  const derived = newCliffs.map((c) => c.cliffID);
  t.cliffTiles = [...derived, ...beforeCliffs.filter((id) => !derived.includes(id) && !oldCliffs.some((c) => c.cliffID === id))];
  t.customTilesetsRaw = customTilesFlag(t.groundTiles, own);
  t.customTilesets = t.customTilesetsRaw !== 0;
}
