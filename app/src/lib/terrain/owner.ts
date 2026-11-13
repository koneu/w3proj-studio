// The player field of war3mapUnits.doo holds more than the owner: the low 16 bits are the player,
// and bit 16 says an Ancient is placed uprooted. Everything that shows or edits an owner uses the
// low half; the flags go back into the file unchanged.

import { readIni } from "../formats/iniedit";

interface Owned { player?: number; playerFlags?: number }

const OWNER = 0xffff;

/** Players 0 to 23 play; from 24 on it's the neutral ones, which also hold the map's items (27). */
const FIRST_NEUTRAL = 24;
export const NEUTRAL_PASSIVE = 27;

export const ownerOf = <T extends number | undefined>(player: T): T => (player === undefined ? player : ((player & OWNER) as T));

/** Whether a player owns something placed, other than a start location: a unit, or an item (the editor places items
 *  for Neutral Passive, but one given to a player in the file counts as well: a we-drive save of World Editor 7003,
 *  2026-11-09, took the Melee flag off for an item of Player 1). */
export function hasPlayerUnits(list: readonly (Owned & { id: string })[]): boolean {
  return list.some((u) => u.id !== "sloc" && (ownerOf(u.player) ?? FIRST_NEUTRAL) < FIRST_NEUTRAL);
}

/** war3map.w3i flag: a melee map. */
export const MELEE_MAP = 4;

/** What of war3map.w3i the melee rules look at. */
export interface MeleeInfo {
  flags: number;
  players?: readonly { fixedStart?: number }[];
  gameDataSet?: number;
  upgrades?: readonly unknown[];
  techs?: readonly unknown[];
  /** The map's war3mapMisc.txt sets a value (customConstants); not in war3map.w3i, the caller tells. */
  customConstants?: boolean;
}

/** Whether a war3mapMisc.txt sets a gameplay constant: a value in any section. Ticking "Use Custom Gameplay Constants"
 *  alone changes nothing in World Editor 7003; editing one value writes the file ([Misc] ScaledAnimTime=75.0) and takes
 *  the Melee flag off (2026-11-12). An empty file (Studio's Gameplay Constants opened, nothing changed) sets none. */
export function hasCustomConstants(misc: string): boolean {
  return [...readIni(misc).values()].some((section) => section.size > 0);
}

/**
 * Why the World Editor's save would take the Melee flag off (its WESTRING_NOTMELEE_* reasons), as far as war3map.w3i
 * and the placed units tell. Found with we-drive saves of World Editor 7003 (2026-11-09): copies of (4)PhantomGrove with
 * the flag cleared and one thing changed each; the flag came back with none of these and stayed off with each. The game's
 * 258 melee maps have none of them. Not reasons: custom techtree, abilities or upgrades turned on in the options without
 * entries, Fixed Player Settings without custom forces, Race selectable, neutral units, computer players, races.
 * Custom gameplay constants count when the caller tells (`customConstants`, see hasCustomConstants).
 * Its other reasons aren't here: custom object data or interface, triggers other than the default
 * Melee Initialization (renaming it, dropping an action or disabling it counted; its description and the custom script
 * header didn't), and start locations "in invalid positions" (trees about 200 from a start made it one; a start 250 from
 * a tavern also took the flag off). That one counts only when the caller tells (`startsInvalid`): a start under water is
 * one (World Editor 7003's new maps on shallow or deep water, we-drive 2026-11-11), the rest Studio can't tell.
 */
export function meleeBlockers(info: MeleeInfo, placed: readonly (Owned & { id: string })[], startsInvalid = false): string[] {
  const out: string[] = [];
  if (startsInvalid) out.push("Start locations are in invalid positions");
  if (hasPlayerUnits(placed)) out.push("Player-owned units have been placed");
  if (info.flags & 0x0001) out.push("'Hide minimap' option has been turned on");
  if (!(info.flags & 0x0010)) out.push("'Partially visible masked areas' option has been turned off");
  if (info.flags & 0x0040) out.push("Custom forces have been specified");
  if (info.players?.some((p) => ((p.fixedStart ?? 0) & 1) !== 0)) out.push("Fixed starting locations have been specified");
  if (info.upgrades?.length) out.push("Custom upgrade settings have been specified");
  if (info.techs?.length) out.push("Custom techtree or ability settings have been specified");
  if (info.customConstants) out.push("Custom gameplay constants have been specified");
  // 0 and -1 (0xffffffff, what World Editor 7003 gives its new maps, Melee on) are the default; 1 was a reason.
  if (info.gameDataSet && (info.gameDataSet >>> 0) !== 0xffffffff) out.push("Non-default game data set has been specified");
  return out;
}

/** The map's flags after a save: Melee goes off when one of meleeBlockers applies, as the World Editor's save does.
 *  This never turns it back on: that needs the project's triggers, object data and what stands around the start
 *  locations (meleesave.ts meleeSetBlockers). */
export function meleeFlagsAfter(info: MeleeInfo, placed: readonly (Owned & { id: string })[], startsInvalid = false): number {
  return info.flags & MELEE_MAP && meleeBlockers(info, placed, startsInvalid).length ? info.flags & ~MELEE_MAP : info.flags;
}

/** The player field's bit for an Ancient placed uprooted. */
export const UPROOTED = 0x10000;

/** Whether an entry is placed uprooted, before or after splitOwners. */
export const isUprooted = (e: Owned): boolean => (((e.player ?? 0) | (e.playerFlags ?? 0)) & UPROOTED) !== 0;

/** Replaces each entry's field by its owner, keeping the rest in `playerFlags` until saving. */
export function splitOwners(list: Owned[]): void {
  for (const e of list) {
    const p = e.player;
    if (p === undefined || p <= OWNER) continue;
    e.player = p & OWNER;
    e.playerFlags = p - e.player;
  }
}

/** An entry as the file has it. */
export function joinOwners<T extends Owned>(e: T): T {
  const { playerFlags, ...rest } = e;
  return (playerFlags === undefined ? e : { ...rest, player: (e.player ?? 0) + playerFlags }) as T;
}

/** The document as JSON, with the flags back in the player field. */
export function placedText(doc: unknown): string {
  return JSON.stringify(doc, (_, v: unknown) => {
    if (!v || typeof v !== "object") return v;
    const e = "playerFlags" in v ? joinOwners(v as Owned) : v;
    return savedUnitValues(e as Record<string, unknown>);
  });
}

/**
 * A war3mapUnits.doo entry as the World Editor saves it: hit points or mana of 0 become -1, the type's own. World
 * Editor 7003 does that to every placed unit, start location and item when it saves (we-drive saves, 2026-11-09:
 * start locations with 0 and 0, a footman, a sorceress, a Paladin and an item with 0; 50 and 5 stay). Of the game's
 * 375 maps only a starter map's two start locations have a 0 there. Any other object (a doodad has no `hp`) is given
 * back as it is.
 */
export function savedUnitValues<T extends Record<string, unknown>>(e: T): T {
  const zero = (k: string) => k in e && e[k] === 0;
  if (typeof e.id !== "string" || !("hp" in e) || !("mana" in e) || (!zero("hp") && !zero("mana"))) return e;
  return { ...e, ...(zero("hp") ? { hp: -1 } : {}), ...(zero("mana") ? { mana: -1 } : {}) };
}
