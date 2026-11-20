// war3map.w3i's flag 0x4000, "Requires The Frozen Throne data", as the World Editor's save leaves it. Measured with
// we-drive 2026-11-17 (tests/we-compare/tft-flag-we.json; inputs make-melee-valid.mjs tft-*): the save sets it when a
// placed unit or item (war3mapUnits.doo), or an item of a unit's drop sets, is of a type whose `version` in the game's
// tables (Units\UnitData.slk, Units\ItemData.slk) is 1 (The Frozen Throne) or 2 (Reforged): a tavern, a creep, a
// Reforged unit, an item, a Rune of Mana in a frog's drops; and clears it when none is (flat.w3x). Not reasons: a unit
// of version 0, a destructable, doodad or ground tile of version 1, a random item (YjI5) in the drops. The Melee flag is
// independent (tft-tavern-off: Melee cleared, the save put it back on and set 0x4000).
//
// The save also kept the flag on the game's (12)WormWar, which places nothing of version 1: its custom abilities and
// buffs keep it (we-compare corpus-saves, 2026-11-20: ability, buff and upgrade data, custom or a changed original, set
// it on flat.w3x; unit, item, destructable and doodad data and war3mapSkin.txt don't, custom units based on Ucrl
// included). That rule is
// meleesave.ts objectDataTft; custom triggers alone aren't measured, so they still keep Studio from clearing the flag
// (tftFlagsAfter's `mayClear`).
//
// Branch we-batch-3 (2026-11-20, tests/we-compare/tft-flag-we.json tft-inventory*, tft-item-table*, tft-dest-drop*):
// an item of version 1 (shas) in a destructable's drop set (a crate LTcr, version 0) sets the flag, ratc there doesn't;
// the same item in a hero's inventory (Hpal) or in a war3map.w3i item table nothing uses is not a reason, either way
// (the flag stays off, and a stored one is cleared). An item table a unit or destructable uses isn't measured: counted
// as "can't tell" when it holds a type that isn't of version 0.

/** The w3i flag. */
export const REQUIRES_TFT = 0x4000;

/** The units file's (war3mapUnits.doo) subversion with map item tables and hero attributes. */
export const TFT_UNITS_SUBVERSION = 11;

/**
 * war3mapUnits.doo in the layout the World Editor's save gives a map with flag 0x4000: subversion 9 becomes 11, every
 * entry with item table -1 (none) and hero attributes 0, the values the editor writes. Measured with we-drive
 * 2026-11-20 (branch we-terrain-items; nine saves): the save writes 11 exactly when the saved w3i has 0x4000, whatever
 * set it (a placed tavern ntav, marketplace nmrk or Naga hero Nngs, all of version 1; a custom ability; (12)WormWar's
 * kept flag) and on .w3m and .w3x alike; without it (a creep nfrl or a gold mine ngol, version 0) 9. The editor also
 * writes a file of 11 without the flag back as 9, dropping the tables and attributes: Studio doesn't (a save never loses
 * data). Changes `doc` in place; true when it did.
 */
export function tftUnitsLayout(doc: { subversion?: unknown; units?: unknown }): boolean {
  if (Number(doc.subversion) !== 9 || !Array.isArray(doc.units)) return false;
  for (const u of doc.units as Record<string, unknown>[]) {
    if (!u || typeof u !== "object") return false;
  }
  for (const u of doc.units as Record<string, unknown>[]) {
    u.itemTable ??= -1;
    u.strength ??= 0;
    u.agility ??= 0;
    u.intelligence ??= 0;
  }
  doc.subversion = TFT_UNITS_SUBVERSION;
  return true;
}

/** Placed objects that aren't a type of the tables: start locations (version 0 for this rule: every melee map has one).
 *  Random units, buildings and items (uDNR, bDNR, iDNR …) and custom objects aren't in the tables either, so Studio
 *  can't tell them (typeVersions has no entry). */
const NOT_TFT = new Set(["sloc"]);
/** A random item of a level and class (YjI5: permanent, level 5) in a drop set: not a reason (tft-drop-random). */
const RANDOM_ITEM = /^Y[a-zA-Z]I[0-9a-zA-Z]$/;

interface DropLike { id?: unknown }
interface PlacedLike { id?: unknown; itemSets?: unknown; inventory?: unknown; itemTable?: unknown }

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
 * Whether the placed units and items need The Frozen Throne's data: true when one of them, or an item of a unit's or a
 * destructable's drop sets, is of version 1 or more; false when every one is known and of version 0; null when that
 * can't be told (a type `versions` doesn't have, no versions, a drop list of another shape, `doodads` null: the doodad
 * file can't be read, or an item table of war3map.w3i that a unit or destructable uses holding a type that isn't of
 * version 0). A hero's inventory and an item table nothing uses are not reasons. `doodads`: war3map.doo's entries
 * (undefined: none); only their drops count, never their own type.
 */
export function placedNeedTft(placed: readonly PlacedLike[], versions: ReadonlyMap<string, number> | null | undefined, itemTables?: unknown, doodads?: readonly PlacedLike[] | null): boolean | null {
  if (!versions) return null;
  let unknown = doodads === null;
  let tableUsed = false;
  const counted = (id: string) => {
    if (NOT_TFT.has(id)) return false;
    const v = versions.get(id);
    if (v === undefined) unknown = true;
    return v !== undefined && v >= 1;
  };
  /** Whether an entry's drop sets hold an item of version 1 (a random item isn't one); marks `unknown` on the way. */
  const dropsNeed = (p: PlacedLike) => {
    const drops = dropIds(p.itemSets);
    if (drops === null) unknown = true;
    else if (drops.some((id) => !RANDOM_ITEM.test(id) && counted(id))) return true;
    if (p.itemTable !== undefined && p.itemTable !== -1) tableUsed = true;
    return false;
  };
  for (const p of placed) {
    if (typeof p.id !== "string") { unknown = true; continue; }
    if (counted(p.id)) return true;
    if (dropsNeed(p)) return true;
  }
  if (Array.isArray(doodads)) {
    for (const d of doodads) {
      if (!d || typeof d !== "object") { unknown = true; continue; }
      if (dropsNeed(d)) return true;
    }
  }
  if (tableUsed && itemTables !== undefined) {
    if (!Array.isArray(itemTables)) unknown = true;
    else for (const t of itemTables as { sets?: unknown }[]) {
      const ids = dropIds(t?.sets ?? null);
      if (ids === null || ids.some((id) => versions.get(id) !== 0 && !RANDOM_ITEM.test(id))) unknown = true;
    }
  }
  return unknown ? null : false;
}

/** The flags after a save: 0x4000 set or cleared by `need` (placedNeedTft); left as they are when it's null, and not
 *  cleared unless `mayClear` (the map has no custom object data and no custom triggers, as far as Studio knows). */
export function tftFlagsAfter(flags: number, need: boolean | null, mayClear = true): number {
  if (need === true) return flags | REQUIRES_TFT;
  return need === false && mayClear ? flags & ~REQUIRES_TFT : flags;
}
