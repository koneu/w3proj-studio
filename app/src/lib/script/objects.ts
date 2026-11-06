// What the script needs to know about objects beyond the placement files. Both come from data the
// generator doesn't read itself: the game's ability tables and the map's object data.

export interface AbilityOrders {
  /** The order that switches the ability on when placed that way. */
  on: string;
  /** The order for off; toggles like Defend have none (they start off anyway). */
  off?: string;
}

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

interface ObjectMod { field: string; value: unknown }
interface ObjectEntry { id?: string; base: string; mods?: ObjectMod[] }
export interface ObjectFile { original?: ObjectEntry[]; custom?: ObjectEntry[] }

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
  for (const f of files) {
    for (const o of f?.custom ?? []) if (o.id) put(o.id, own(o) ?? out.get(o.base));
  }
  return out;
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
