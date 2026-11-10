// What the script needs to know about objects beyond the placement files. Both come from data the
// generator doesn't read itself: the game's ability tables and the map's object data.

export interface AbilityOrders {
  /** The order that switches the ability on when placed that way. */
  on: string;
  /** The order for off; toggles like Defend have none (they start off anyway). */
  off?: string;
}

/** The game's ability tables with the orders abilityOrders reads (paths in the game's storage). */
export const ABILITY_FUNC_FILES = ["Campaign", "Common", "Human", "Item", "Neutral", "NightElf", "Orc", "Undead"].map((r) => `Units\\${r}AbilityFunc.txt`);

/** Orders per ability from the `Units\*AbilityFunc.txt` tables (parseIni: lower-case keys): real
 *  autocast has Orderon and Orderoff, a toggle like Defend has Order and Unorder. */
export function abilityOrders(tables: Iterable<Map<string, Map<string, string>>>): Map<string, AbilityOrders> {
  const out = new Map<string, AbilityOrders>();
  for (const table of tables) {
    for (const [id, sec] of table) {
      if (out.has(id)) continue;
      const on = sec.get("orderon"), off = sec.get("orderoff"), order = sec.get("order");
      if (on && off) out.set(id, { on, off });
      else if (order && sec.get("unorder")) out.set(id, { on: order });
    }
  }
  return out;
}

/** The orders of an ability placed switched on, a map's own ability's through its base (war3map.w3a and its Skin file):
 *  World Editor 2.0 writes "healon" for a custom ability based on Heal (we-drive, 2026-11-10). */
export function autocastOrdersOf(orders: ReadonlyMap<string, AbilityOrders>, files: (ObjectFile | null | undefined)[]): (ability: string) => AbilityOrders | undefined {
  const bases = new Map<string, string>();
  for (const f of files) for (const o of f?.custom ?? []) if (o.id && !bases.has(o.id)) bases.set(o.id, o.base);
  return (id) => orders.get(id) ?? orders.get(bases.get(id) ?? "");
}

/** The game's unit types that allow a custom team colour (the customTeamColor column of Units\unitUI.slk, parsed:
 *  only the waygate). */
export function gameCustomColors(rows: Record<string, string>[]): Set<string> {
  // A table that couldn't be read (or has no such column) leaves the waygate, as the game's has it.
  if (!rows.some((r) => r.customTeamColor !== undefined)) return new Set(["nwgt"]);
  return new Set(rows.filter((r) => r.customTeamColor?.trim() === "1").map((r) => r.unitUIID));
}

/** Whether a placed unit's own colour counts: its type allows a custom team colour (field utcc, as the map sets it, a
 *  custom type's from its base). World Editor 2.0 writes SetUnitColor for those only (we-drive, 2026-11-10: a footman
 *  type given utcc, yes; a waygate type without it, no). */
export function customColorTypes(files: (ObjectFile | null | undefined)[], game: ReadonlySet<string> = new Set(["nwgt"])): (id: string) => boolean {
  return flagOf(files, "utcc", game);
}

interface ObjectMod { field: string; value: unknown }
interface ObjectEntry { id?: string; base: string; mods?: ObjectMod[] }
export interface ObjectFile { original?: ObjectEntry[]; custom?: ObjectEntry[] }

/** The object data kinds the script is made from. */
export type ScriptObjectKind = "w3u" | "w3t" | "w3a" | "w3b";

/** Reads one object file: `campaign` is war3campaign.<kind> of a chapter map's campaign, else war3map.<kind>; `skin` its
 *  Skin file. Null when there's none. */
export type ObjectFileReader = (kind: ScriptObjectKind, skin: boolean, campaign: boolean) => Promise<ObjectFile | null>;

/** A kind's object files in the order they apply, for teamColors, buildingTypes and the rest (a later file's entry
 *  changes what it sets): a chapter map's campaign's (war3campaign.<kind>, then its Skin file) first, then the map's own
 *  (war3map.<kind>, war3mapSkin.<kind>). So the map's data wins over the campaign's, as in the game and the World Editor.
 *  `inCampaign`: whether the map is a chapter of a campaign. A failed read fails it (a file that can't be read mustn't
 *  pass for one that sets nothing). */
export async function scriptObjectFiles(read: ObjectFileReader, inCampaign: boolean): Promise<Record<ScriptObjectKind, (ObjectFile | null)[]>> {
  const kinds: ScriptObjectKind[] = ["w3u", "w3t", "w3a", "w3b"];
  const lists = await Promise.all(kinds.map((kind) => Promise.all([
    ...(inCampaign ? [read(kind, false, true), read(kind, true, true)] : []),
    read(kind, false, false), read(kind, true, false),
  ])));
  return { w3u: lists[0], w3t: lists[1], w3a: lists[2], w3b: lists[3] };
}

/** The custom object ids of a kind's files (scriptObjectFiles), but those only a Skin file lists: Skin files repeat the
 *  objects of their main file (the campaign's or the map's), and an id only there isn't an object of its own. */
export function customIdsOf(files: (ObjectFile | null)[]): Set<string> {
  const ids = new Set<string>();
  // Main files are at even places (main, Skin, main, Skin).
  files.forEach((f, i) => { if (i % 2 === 0) for (const o of f?.custom ?? []) if (o.id) ids.add(o.id); });
  return ids;
}

/** Team colours the game's unit types come with (the teamColor column of Units\unitUI.slk, parsed). */
export function gameTeamColors(rows: Record<string, string>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r.teamColor);
    if (r.teamColor !== undefined && r.teamColor !== "" && v >= 0) out.set(r.unitUIID, v);
  }
  return out;
}

/** Team colours of unit types: the game's, changed by the map (object data field utco). A custom
 *  unit without its own takes the one of its base. The World Editor writes them into the script
 *  as SetUnitColor. */
export function teamColors(files: (ObjectFile | null | undefined)[], game: Map<string, number> = new Map()): Map<string, number> {
  const out = new Map(game);
  /** The object's own value; -1 means no colour, undefined that it doesn't say. */
  const own = (o: ObjectEntry) => {
    const v = o.mods?.find((m) => m.field === "utco")?.value;
    return typeof v === "number" ? v : undefined;
  };
  const put = (id: string, v: number | undefined) => { if (v === undefined || v < 0) out.delete(id); else out.set(id, v); };
  for (const f of files) {
    for (const o of f?.original ?? []) {
      const v = own(o);
      if (v !== undefined) put(o.base, v);
    }
  }
  // An entry only changes what it sets: war3mapSkin.w3u lists custom types again without utco, and
  // that keeps war3map.w3u's (HumanX06Finale's N000, BlizzardTD's o01G).
  const custom = new Map<string, { base: string; colour?: number }>();
  for (const f of files) {
    for (const o of f?.custom ?? []) if (o.id) custom.set(o.id, { base: o.base, colour: own(o) ?? custom.get(o.id)?.colour });
  }
  for (const [id, c] of custom) put(id, c.colour ?? out.get(c.base));
  return out;
}

/** Whether a unit type is a building (its units go to the CreateBuildings… functions): the game's
 *  (`isbldg` of Units\UnitBalance.slk), changed by the map (object data field ubdg) for the game's
 *  types and its own. A custom type that doesn't say takes its base's. An entry only changes what it
 *  sets: war3mapSkin.w3u lists most custom types again without ubdg, and that keeps war3map.w3u's
 *  (UndeadX01's n003, a Goblin Merchant made a unit, is created as one by the World Editor). */
export function buildingTypes(files: (ObjectFile | null | undefined)[], game: ReadonlySet<string>): (id: string) => boolean {
  return flagOf(files, "ubdg", game);
}

/** Whether an ability is a hero ability: the game's (`hero` of Units\AbilityData.slk), changed by the map
 *  (object data field aher), as buildingTypes. A hero's unlearned hero ability (level 0) gets no autocast
 *  order in the script (UndeadX04's Sea Witch with Mana Shield at 0), its other abilities do (NightElf03's
 *  custom heroes with Inner Fire and Curse on). */
export function heroAbilities(files: (ObjectFile | null | undefined)[], game: ReadonlySet<string>): (id: string) => boolean {
  return flagOf(files, "aher", game);
}

/** Tint of a destructable type (object data fields bvcr, bvcg, bvcb, 0–255) as the map sets it, the rest
 *  255 (the game's types are all untinted, colorR/G/B of Units\DestructableSkin.txt). The World Editor
 *  writes it into SetDestructableVertexColor (HumanX03, HumanX06, UndeadX07a–c tint theirs). */
export function destructableTints(files: (ObjectFile | null | undefined)[]): (id: string) => [number, number, number] {
  const [r, g, b] = ["bvcr", "bvcg", "bvcb"].map((f) => mapNumbers(files, f));
  return (id) => [r.value(id) ?? 255, g.value(id) ?? 255, b.value(id) ?? 255];
}

/** A yes/no field of object data (1 is yes): the game's types in `game`, as the map sets it (mapNumbers). */
function flagOf(files: (ObjectFile | null | undefined)[], field: string, game: ReadonlySet<string>): (id: string) => boolean {
  const m = mapNumbers(files, field);
  return (id) => {
    const v = m.value(id);
    return v !== undefined ? v === 1 : game.has(m.base(id));
  };
}

/** A number field as the map sets it: a custom type's own value, else its base's as the map changes that;
 *  undefined when the map doesn't say. An entry only changes what it sets: war3mapSkin.* lists most types
 *  again without the field, and that keeps war3map.*'s. `base` is a custom type's base (the id itself else). */
function mapNumbers(files: (ObjectFile | null | undefined)[], field: string): { value: (id: string) => number | undefined; base: (id: string) => string } {
  const own = (o: ObjectEntry) => {
    const v = o.mods?.find((m) => m.field === field)?.value;
    return typeof v === "number" ? v : undefined;
  };
  const changed = new Map<string, number>();
  for (const f of files) {
    for (const o of f?.original ?? []) {
      const v = own(o);
      if (v !== undefined) changed.set(o.base, v);
    }
  }
  const custom = new Map<string, { base: string; value?: number }>();
  for (const f of files) {
    for (const o of f?.custom ?? []) {
      if (!o.id) continue;
      custom.set(o.id, { base: o.base, value: own(o) ?? custom.get(o.id)?.value });
    }
  }
  const base = (id: string) => custom.get(id)?.base ?? id;
  return { base, value: (id) => custom.get(id)?.value ?? changed.get(base(id)) };
}

/** Unit types the map makes gold mines (the Gold Mine ability in their list) and those based on the
 *  game's special types. */
export function specialUnits(files: (ObjectFile | null | undefined)[]): { goldMines: Set<string>; waygates: Set<string> } {
  const goldMines = new Set<string>(["ngol", "ugol", "egol"]), waygates = new Set<string>(["nwgt"]);
  const hasGold = (o: ObjectEntry) => {
    const v = o.mods?.find((m) => m.field === "uabi")?.value;
    return typeof v === "string" && v.split(",").includes("Agld");
  };
  for (const f of files) for (const o of f?.original ?? []) if (hasGold(o)) goldMines.add(o.base);
  for (const f of files) {
    for (const o of f?.custom ?? []) {
      if (!o.id) continue;
      if (hasGold(o) || goldMines.has(o.base)) goldMines.add(o.id);
      if (waygates.has(o.base)) waygates.add(o.id);
    }
  }
  return { goldMines, waygates };
}
