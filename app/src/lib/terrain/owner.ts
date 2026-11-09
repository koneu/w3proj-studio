// The player field of war3mapUnits.doo holds more than the owner: the low 16 bits are the player,
// and bit 16 says an Ancient is placed uprooted. Everything that shows or edits an owner uses the
// low half; the flags go back into the file unchanged.

interface Owned { player?: number; playerFlags?: number }

const OWNER = 0xffff;

/** Players 0 to 23 play; from 24 on it's the neutral ones, which also hold the map's items (27). */
const FIRST_NEUTRAL = 24;
export const NEUTRAL_PASSIVE = 27;

export const ownerOf = <T extends number | undefined>(player: T): T => (player === undefined ? player : ((player & OWNER) as T));

/** Whether a player owns something placed, other than a start location or an item. The World Editor
 *  takes the Melee flag off such a map when saving: of the game's 326 maps, none has both. */
export function hasPlayerUnits(list: readonly (Owned & { id: string })[], isItem: (id: string) => boolean): boolean {
  return list.some((u) => u.id !== "sloc" && !isItem(u.id) && (ownerOf(u.player) ?? FIRST_NEUTRAL) < FIRST_NEUTRAL);
}

/** war3map.w3i flag: a melee map. */
export const MELEE_MAP = 4;

/** The map's flags with `list` placed on it: Melee goes off once a player owns something placed (see
 *  hasPlayerUnits), as the World Editor does when saving. It never comes back on by itself. */
export function meleeFlagsAfter(flags: number, list: readonly (Owned & { id: string })[], isItem: (id: string) => boolean): number {
  return flags & MELEE_MAP && hasPlayerUnits(list, isItem) ? flags & ~MELEE_MAP : flags;
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
