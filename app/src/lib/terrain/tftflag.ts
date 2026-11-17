// war3map.w3i's flag 0x4000, "Requires The Frozen Throne data", as the World Editor's save leaves it. Measured with
// we-drive 2026-11-17 (tests/we-compare/tft-flag-we.json; inputs make-melee-valid.mjs tft-*): the save sets it when a
// placed unit or item (war3mapUnits.doo), or an item of a unit's drop sets, is of a type whose `version` in the game's
// tables (Units\UnitData.slk, Units\ItemData.slk) is 1 (The Frozen Throne) or 2 (Reforged): a tavern, a creep, a
// Reforged unit, an item, a Rune of Mana in a frog's drops; and clears it when none is (flat.w3x). Not reasons: a unit
// of version 0, a destructable, doodad or ground tile of version 1, a random item (YjI5) in the drops. The Melee flag is
// independent (tft-tavern-off: Melee cleared, the save put it back on and set 0x4000).
//
// The save also kept the flag on the game's (12)WormWar, which places nothing of version 1 but has custom units based
// on ones of version 1 and its own triggers: what of those counts isn't measured, so Studio clears the flag only on a
// map without custom object data and custom triggers (tftFlagsAfter's `mayClear`). Neither measured: a hero's
// inventory and the map's item tables (war3map.w3i), counted as "can't tell" when they hold a type of version 1; the
// drops of destructables, not looked at.

/** The w3i flag. */
export const REQUIRES_TFT = 0x4000;

/** Placed objects that aren't a type of the tables: start locations (version 0 for this rule: every melee map has one).
 *  Random units, buildings and items (uDNR, bDNR, iDNR …) and custom objects aren't in the tables either, so Studio
 *  can't tell them (typeVersions has no entry). */
const NOT_TFT = new Set(["sloc"]);
/** A random item of a level and class (YjI5: permanent, level 5) in a drop set: not a reason (tft-drop-random). */
const RANDOM_ITEM = /^Y[a-zA-Z]I[0-9a-zA-Z]$/;

interface DropLike { id?: unknown }
interface PlacedLike { id?: unknown; itemSets?: unknown; inventory?: unknown }

/** A table's id → version, from rows of parseSlk. Rows without a version are left out (not known). */
export function typeVersions(rows: readonly Record<string, string>[], key: string, into = new Map<string, number>()): Map<string, number> {
  for (const r of rows) {
    const id = r[key], v = Number(r.version);
    if (id && r.version !== undefined && r.version !== "" && Number.isInteger(v)) into.set(id, v);
  }
  return into;
}

/** The ids of a list of drop sets (each a list of { id, chance }); null when it isn't such a list. */
function dropIds(sets: unknown): string[] | null {
  if (sets === undefined) return [];
  if (!Array.isArray(sets)) return null;
  const out: string[] = [];
  for (const set of sets) {
    if (!Array.isArray(set)) return null;
    for (const d of set as DropLike[]) {
      if (typeof d?.id !== "string") return null;
      out.push(d.id);
    }
  }
  return out;
}

/**
 * Whether the placed units and items need The Frozen Throne's data: true when one of them, or an item of a unit's drop
 * sets, is of version 1 or more; false when every one is known and of version 0; null when that can't be told (a type
 * `versions` doesn't have, no versions, a drop list of another shape, or a type of version 1 only where it isn't
 * measured: a hero's inventory, `itemTables` of war3map.w3i).
 */
export function placedNeedTft(placed: readonly PlacedLike[], versions: ReadonlyMap<string, number> | null | undefined, itemTables?: unknown): boolean | null {
  if (!versions) return null;
  let unknown = false;
  const counted = (id: string) => {
    if (NOT_TFT.has(id)) return false;
    const v = versions.get(id);
    if (v === undefined) unknown = true;
    return v !== undefined && v >= 1;
  };
  /** Ids where a type of version 1 can't be told to count. */
  const unsure = (ids: string[] | null) => {
    if (ids === null || ids.some((id) => versions.get(id) !== 0 && !RANDOM_ITEM.test(id))) unknown = true;
  };
  for (const p of placed) {
    if (typeof p.id !== "string") { unknown = true; continue; }
    if (counted(p.id)) return true;
    const drops = dropIds(p.itemSets);
    if (drops === null) unknown = true;
    else if (drops.some((id) => !RANDOM_ITEM.test(id) && counted(id))) return true;
    if (p.inventory !== undefined) {
      unsure(Array.isArray(p.inventory) ? (p.inventory as DropLike[]).map((i) => (typeof i?.id === "string" ? i.id : "")) : null);
    }
  }
  if (itemTables !== undefined) {
    if (!Array.isArray(itemTables)) unknown = true;
    else for (const t of itemTables as { sets?: unknown }[]) unsure(dropIds(t?.sets ?? null));
  }
  return unknown ? null : false;
}

/** The flags after a save: 0x4000 set or cleared by `need` (placedNeedTft); left as they are when it's null, and not
 *  cleared unless `mayClear` (the map has no custom object data and no custom triggers, as far as Studio knows). */
export function tftFlagsAfter(flags: number, need: boolean | null, mayClear = true): number {
  if (need === true) return flags | REQUIRES_TFT;
  return need === false && mayClear ? flags & ~REQUIRES_TFT : flags;
}
