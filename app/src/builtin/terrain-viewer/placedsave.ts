// What an AI tool's edit of a placement file (index.ts editPlaced: place_objects, scatter_objects, move, delete,
// replace, new owners, …) does besides changing the entries, as the terrain view's save would do it: the players follow
// the start locations, the w3i's flags follow what is placed (meleesave.ts savedMelee), the units file takes the layout
// of flag 0x4000 (tftflag.ts savedUnitsLayout). Apart from the tools so a test drives the same code.

import type { MeleeInfo } from "../../lib/terrain/owner";
import { startLocations, syncWithStarts, type PlayerInfo } from "../../lib/terrain/startlocations";
import { savedUnitsLayout } from "../../lib/terrain/tftflag";
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
 * it is, and changes `doc` to the layout it is written in. A w3i that is missing, kept raw or can't be read is left
 * alone: the placing doesn't depend on it.
 */
export async function afterPlacedEdit(edit: PlacedEditAfter): Promise<string | null> {
  const w3i = await settleInfo(edit);
  // Under flag 0x4000 as the edit leaves the w3i, the units file in the layout with item tables and hero attributes, as
  // the terrain view's save writes it (tftflag.ts savedUnitsLayout). A w3i that can't be read leaves it as it is.
  if (edit.key === "units") savedUnitsLayout(edit.doc, w3i.flags);
  return w3i.text;
}

/** The w3i's text to write (null: stays) and its flags after the edit (undefined: it can't be read). */
async function settleInfo({ key, list, infoText, startsBefore, flagsAfter }: PlacedEditAfter): Promise<{ text: string | null; flags?: number }> {
  if (key !== "units" || infoText === null) return { text: null };
  type Info = { flags?: unknown; players?: unknown; forces?: unknown };
  let info: Info | null = null;
  try { info = JSON.parse(infoText) as Info; } catch { /* left alone */ }
  if (!info || typeof info.flags !== "number") return { text: null };
  if (!Array.isArray(info.players) || !Array.isArray(info.forces)) return { text: null, flags: info.flags };
  let changed = false;
  // Placed, moved or removed start locations add, move or remove the map's players, as the terrain editor's save does,
  // in the same edit (one undo step).
  if (startsBefore && syncWithStarts(info as unknown as PlayerInfo & { flags: number }, startLocations(list), startsBefore)) changed = true;
  // Placing can make a player own something: Melee goes off as the save would take it off. The ground is the saved
  // terrain's (a start under water).
  const flags = info.flags, after = await flagsAfter(info as unknown as MeleeInfo, list);
  if (after !== flags) { info.flags = after; changed = true; }
  return { text: changed ? JSON.stringify(info) : null, flags: after };
}

/** The w3i's flags as stored (war3map.w3i.json read through an edit's `read`): for an edit that moves units without
 *  changing what is placed (a ground tool's), so the flags stay. Undefined when the w3i is missing, kept raw or can't be
 *  read. */
export async function storedFlags(read: (path: string) => Promise<string | null>): Promise<number | undefined> {
  try {
    const text = await read("map/war3map.w3i.json");
    const flags = text === null ? undefined : (JSON.parse(text) as { flags?: unknown } | null)?.flags;
    return typeof flags === "number" ? flags : undefined;
  } catch { return undefined; }
}
