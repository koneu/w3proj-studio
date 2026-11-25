// What an AI tool's edit of a placement file (index.ts editPlaced: place_objects, scatter_objects, move, delete,
// replace, new owners, …) does besides changing the entries, as the terrain view's save would do it: the players follow
// the start locations, the w3i's flags follow what is placed (meleesave.ts savedMelee). Apart from the tools so a test
// drives the same code.

import type { MeleeInfo } from "../../lib/terrain/owner";
import { startLocations, syncWithStarts, type PlayerInfo } from "../../lib/terrain/startlocations";
import type { Placed } from "./objects";

export interface PlacedEditAfter {
  key: "doodads" | "units";
  /** The placement file's document as the edit left it. */
  doc: Record<string, unknown>;
  /** Its entries (doc[key]). */
  list: Placed[];
  /** war3map.w3i.json's text; null when it is missing, kept raw or wasn't read. */
  infoText: string | null;
  /** The start locations before the edit (units only). */
  startsBefore: Map<number, number[]> | null;
  /** The w3i's flags as the World Editor's save leaves them with these entries (meleesave.ts savedMelee). */
  flagsAfter: (info: MeleeInfo, list: readonly Placed[]) => Promise<number>;
}

/**
 * Settles an edit of a placement file: gives the w3i to write along (its JSON, not canonical yet), null when it stays as
 * it is. A w3i that is missing, kept raw or can't be read is left alone: the placing doesn't depend on it.
 */
export async function afterPlacedEdit({ key, list, infoText, startsBefore, flagsAfter }: PlacedEditAfter): Promise<string | null> {
  if (key !== "units" || infoText === null) return null;
  type Info = { flags?: unknown; players?: unknown; forces?: unknown };
  let info: Info | null = null;
  try { info = JSON.parse(infoText) as Info; } catch { /* left alone */ }
  if (!info || typeof info.flags !== "number" || !Array.isArray(info.players) || !Array.isArray(info.forces)) return null;
  let changed = false;
  // Placed, moved or removed start locations add, move or remove the map's players, as the terrain editor's save does,
  // in the same edit (one undo step).
  if (startsBefore && syncWithStarts(info as unknown as PlayerInfo & { flags: number }, startLocations(list), startsBefore)) changed = true;
  // Placing can make a player own something: Melee goes off as the save would take it off. The ground is the saved
  // terrain's (a start under water).
  const flags = info.flags, after = await flagsAfter(info as unknown as MeleeInfo, list);
  if (after !== flags) { info.flags = after; changed = true; }
  return changed ? JSON.stringify(info) : null;
}
