// The map's cliff type list (the w3e's cliff list, see cliffs.ts cliffList): adding a game cliff type to it and taking
// one out, the corners following. A corner names its cliff type by its number in that list, in 4 bits where 15 is
// reserved (a new map's corners hold it; it is drawn as the first type), so only the first 15 entries can be painted.
// The game draws a list of three or more (openpoints example map 29: CLdi CLgr CAdi, corners on index 2).

import { MAX_CLIFF_TYPES } from "../../lib/terrain/cliffs";
import type { Terrain } from "../../lib/terrain/w3e";
import type { CliffType } from "./cliffs";
import { cliffTypeUse } from "./tilecleanup";

export { MAX_CLIFF_TYPES };

/** Per entry of the cliff list: corners whose cliff type number is the entry's, and cliff tiles drawn with it (as
 *  tilecleanup.ts cliffTypeUse counts them: entry 0 also draws a 15 or a number past the list). */
export interface CliffEntryUse { corners: number[]; tiles: number[] }

export function cliffEntryUse(t: Terrain, types: ReadonlyMap<string, CliffType>): CliffEntryUse {
  const corners = t.cliffTiles.map(() => 0);
  // 15 is the reserved "none", not the 16th entry of a longer list.
  for (const c of t.corners) if (c.cliffTexture < corners.length && c.cliffTexture < MAX_CLIFF_TYPES) corners[c.cliffTexture]++;
  const drawn = cliffTypeUse(t, types);
  return { corners, tiles: t.cliffTiles.map((_, i) => drawn[i] ?? 0) };
}

/** The cliff list with the game's cliff type `id` added at the end. Throws, changing nothing, when the game doesn't
 *  define it, the list has it already, or the list holds MAX_CLIFF_TYPES (or more) entries. */
export function cliffListWith(list: readonly string[], id: string, types: ReadonlyMap<string, CliffType>): string[] {
  if (!types.has(id)) throw new Error(`${id} isn't one of the game's cliff types.`);
  if (list.includes(id)) throw new Error(`The map's cliff list has ${id} already (number ${list.indexOf(id)}).`);
  if (list.length >= MAX_CLIFF_TYPES) throw new Error(`The map's cliff list has ${list.length} entries: a corner can name only ${MAX_CLIFF_TYPES} (0 to ${MAX_CLIFF_TYPES - 1}). Remove one first.`);
  return [...list, id];
}

/** Taking an entry out of the cliff list: the new list, and each corner's new cliff type number. */
export interface CliffRemovalPlan { list: string[]; map: (old: number) => number; removed: string }

/** Plans taking entry `index` out of the cliff list. An entry in use (corners name it, or cliffs are drawn with it)
 *  needs `replacement`, another entry's number, which those corners get; the entries after it move up one, and a
 *  corner's 15 or a number past the list stays as it is. Throws with the reason, changing nothing: no such entry, the
 *  last one, an entry in use without a replacement, or a replacement that isn't another entry a corner can name. */
export function planCliffRemoval(list: readonly string[], index: number, replacement: number | undefined, use: CliffEntryUse): CliffRemovalPlan {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new Error(`There is no cliff type ${index} in the map's cliff list (0 to ${list.length - 1}).`);
  if (list.length < 2) throw new Error("A map's cliff list needs at least one cliff type: keep one.");
  const corners = use.corners[index] ?? 0, tiles = use.tiles[index] ?? 0;
  if (replacement === undefined) {
    if (corners + tiles > 0) throw new Error(`${list[index]} is in use (${corners} corners, ${tiles} cliff tiles): say which cliff type its corners get.`);
  } else if (!Number.isInteger(replacement) || replacement === index || replacement < 0 || replacement >= list.length || replacement >= MAX_CLIFF_TYPES) {
    throw new Error(`${list[index]}'s corners can't get cliff type ${replacement}: choose another entry of the list, 0 to ${Math.min(list.length, MAX_CLIFF_TYPES) - 1}.`);
  }
  const shift = (n: number) => (n > index ? n - 1 : n);
  // The numbers a corner can hold for an entry: 15 is no entry's, whatever the list's length.
  const named = Math.min(list.length, MAX_CLIFF_TYPES);
  return {
    list: list.filter((_, i) => i !== index),
    map: (old) => (old === index && replacement !== undefined ? shift(replacement) : old > index && old < named ? old - 1 : old),
    removed: list[index],
  };
}

/** Gives the terrain the planned cliff list and renumbers its corners. */
export function applyCliffRemoval(t: Terrain, plan: CliffRemovalPlan): void {
  t.cliffTiles = [...plan.list];
  for (const c of t.corners) c.cliffTexture = plan.map(c.cliffTexture);
}
