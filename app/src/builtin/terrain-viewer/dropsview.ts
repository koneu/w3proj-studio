// What the Item Drops tab and the Selection panel's Drops block show and do with drops, without the page: names of
// what drops (random items in words, never their code), each set's shares, the placed objects grouped into camps
// (creeps standing together, as the melee check finds them) or by owner or type, where each map item table is used,
// and the edits that go over several objects at once (the same drops for all, a set added to each, drops copied).
// The changes themselves are unitprops.ts's: checked first, all or none.

import { clusterNear } from "./clusters";
import { SAME_CAMP } from "./meleecheck";
import type { Placed } from "./objects";
import { dropsOf, randomItemLabel, setTotal, type DropItem, type Drops } from "./unitprops";

/** Neutral Hostile (players counted from 0): the creeps. */
export const NEUTRAL_HOSTILE = 24;

/** An id the files write for an empty slot: it drops nothing. */
export const isEmptyItem = (id: string) => !id || /^0x0{8}$/i.test(id);

/** What an item id drops, in words: a random item's class and level, the item's name when known, else its id. */
export function itemLabel(id: string, name?: string): string {
  if (isEmptyItem(id)) return "Nothing";
  return randomItemLabel(id) ?? name ?? id;
}

/** One set as shown: each item's chance and its share of the bar (of 100, or of the total when that is above 100: the
 *  game then picks by the chances' shares), what is left to drop nothing, and whether the chances go past 100. */
export interface SetShares {
  items: { id: string; chance: number; share: number }[];
  total: number;
  /** Percent that drops nothing (100 minus the total, not below 0). */
  nothing: number;
  over: boolean;
}

export function setShares(set: readonly DropItem[]): SetShares {
  const total = setTotal(set), whole = Math.max(100, total);
  return {
    items: set.map((it) => ({ id: it.id, chance: it.chance, share: whole > 0 ? it.chance / whole : 0 })),
    total, nothing: Math.max(0, 100 - total), over: total > 100,
  };
}

/** A set's head line: "Set 1 · drops one of these · 100%", "Set 2 · drops one of these · 60% (40% nothing)",
 *  "Set 3 · empty: drops nothing". */
export function setHeading(set: readonly DropItem[], k: number): string {
  if (!set.length) return `Set ${k + 1} · empty: drops nothing`;
  const s = setShares(set);
  const what = set.length === 1 ? "drops this" : "drops one of these";
  return `Set ${k + 1} · ${what} · ${s.total}%${s.nothing ? ` (${s.nothing}% nothing)` : ""}${s.over ? " (over 100%)" : ""}`;
}

/** Drops in a line: "Drops nothing", "Item table Smoke Loot", "Random item, charged, level 2 (100%)", "2 sets · 5 items". */
export function dropsText(d: Drops, names: { table(n: number): string | undefined; item(id: string): string | undefined }): string {
  if (d.mode === "none") return "Drops nothing";
  if (d.mode === "table") {
    const name = names.table(d.table);
    return name === undefined ? `Item table #${d.table} (not in the map)` : `Item table ${name}`;
  }
  const items = d.sets.flat().filter((it) => !isEmptyItem(it.id));
  if (!items.length) return d.sets.length ? "Own sets, all empty: drops nothing" : "Drops nothing";
  if (d.sets.length === 1 && d.sets[0].length === 1) return `${itemLabel(items[0].id, names.item(items[0].id))} (${items[0].chance}%)`;
  return `${d.sets.length} set${d.sets.length === 1 ? "" : "s"} · ${items.length} item${items.length === 1 ? "" : "s"}`;
}

/** Whether an object drops anything: a map item table, or an own set with an item in it. */
export function dropsAnything(d: Drops): boolean {
  return d.mode === "table" || (d.mode === "custom" && d.sets.some((s) => s.some((it) => !isEmptyItem(it.id))));
}

const key = (d: Drops) => JSON.stringify(d);

/** The different drops among objects, most common first (then in the objects' order): one entry when they all drop
 *  the same. */
export function dropsVariants(entries: readonly Placed[]): { drops: Drops; entries: Placed[] }[] {
  const out = new Map<string, { drops: Drops; entries: Placed[] }>();
  for (const e of entries) {
    const d = dropsOf(e), k = key(d);
    const v = out.get(k) ?? { drops: d, entries: [] };
    v.entries.push(e);
    out.set(k, v);
  }
  return [...out.values()].sort((a, b) => b.entries.length - a.entries.length);
}

// ---- grouping ----------------------------------------------------------------------------------

/** A placed object that can drop items, as the overview lists it. */
export interface DropperRow {
  entry: Placed;
  /** w3u (a unit or building), w3b (a destructable), w3d (a doodad that drops anyway). */
  kind: string;
  /** A unit's level as a camp counts it (creepLevel); absent when unknown or not a unit. */
  level?: number;
}

// ---- creep levels ------------------------------------------------------------------------------

/** The game draws a creep camp on the minimap by its creeps' levels added up: weak (green) below
 *  MinimapMiddleCampThreshold, middle (orange, bigger) from it, tough (red) from MinimapToughCampThreshold (UI\MiscData.txt:
 *  10 and 20); the World Editor's minimap has the same camp icons, small and large. */
export const MIDDLE_CAMP = 10, TOUGH_CAMP = 20;
export type CampStrength = "weak" | "middle" | "tough";

/** A camp's level: its creeps' levels added up, the strongest creep's, and how many creeps' levels aren't known (not
 *  counted). */
export interface CampLevel { total: number; strongest: number; strength: CampStrength; unknown: number }

/** A placed unit's level: a random creep's chosen level, a hero's own level, else its type's (`facts.level`, the
 *  map's change first); undefined when that isn't known. */
export function creepLevel(entry: Placed, facts: { hero: boolean; level?: number } | undefined): number | undefined {
  const e = entry as Placed & { randomLevel?: string; level?: number };
  // A random unit (Y…): its level is the first byte of the random data the file keeps.
  if (/^Y/.test(entry.id) && typeof e.randomLevel === "string") {
    const n = parseInt(e.randomLevel.slice(0, 2), 16);
    return Number.isInteger(n) && n < 0xff ? n : undefined;
  }
  if (facts?.hero && typeof e.level === "number" && e.level >= 1) return e.level;
  return facts?.level;
}

/** A camp's level from its creeps' levels (undefined: unknown, left out). */
export function campLevel(levels: readonly (number | undefined)[]): CampLevel {
  const known = levels.filter((l): l is number => l !== undefined);
  const total = known.reduce((a, b) => a + b, 0);
  return {
    total, strongest: known.length ? Math.max(...known) : 0, unknown: levels.length - known.length,
    strength: total >= TOUGH_CAMP ? "tough" : total >= MIDDLE_CAMP ? "middle" : "weak",
  };
}

/** "Level 12 (middle)", and the creeps left out when some aren't known. */
export function campLevelText(c: CampLevel): string {
  return `Level ${c.total} (${c.strength})${c.unknown ? ` + ${c.unknown} unknown` : ""}`;
}

export type GroupBy = "camp" | "owner" | "type";

export interface DropGroup {
  key: string;
  title: string;
  /** What it holds: "4 creeps · 3 drop". */
  detail: string;
  rows: DropperRow[];
  /** The middle of its objects. */
  centre: [number, number];
  /** A camp with creeps: their levels added up (the rows' `level`). */
  level?: CampLevel;
}

const playerOf = (e: Placed) => (e as Placed & { player?: number }).player;
const centreOf = (rows: readonly DropperRow[]): [number, number] => [
  rows.reduce((s, r) => s + r.entry.position[0], 0) / Math.max(1, rows.length),
  rows.reduce((s, r) => s + r.entry.position[1], 0) / Math.max(1, rows.length),
];
const counted = (rows: readonly DropperRow[], one: string, many: string) => {
  const drop = rows.filter((r) => dropsAnything(dropsOf(r.entry))).length;
  return `${rows.length} ${rows.length === 1 ? one : many} · ${drop === rows.length ? (drop === 1 ? "drops" : "all drop") : drop ? `${drop} drop` : "none drop"}`;
};

/** The rows in groups. "camp": Neutral Hostile units and destructables standing together (each within the melee
 *  check's camp distance of another), numbered from the north-west, the way the map reads; other owners' units after
 *  them, one group per owner. "owner": one group per owner, destructables last. "type": one group per object type,
 *  by name. `ownerName` names a player (from 0), `typeName` a type. */
export function groupDroppers(rows: readonly DropperRow[], by: GroupBy, names: { owner(player: number): string; type(id: string): string }): DropGroup[] {
  const byOwner = (list: readonly DropperRow[]) => {
    const groups = new Map<number, DropperRow[]>();
    for (const r of list) {
      const p = playerOf(r.entry) ?? -1;
      groups.set(p, [...(groups.get(p) ?? []), r]);
    }
    // Players in their order, the neutrals after them, destructables (no owner) last.
    return [...groups].sort(([a], [b]) => (a < 0 ? 1 : b < 0 ? -1 : a - b)).map(([p, list]): DropGroup => ({
      key: `owner:${p}`, title: p < 0 ? "Destructables" : names.owner(p), detail: counted(list, "object", "objects"), rows: list, centre: centreOf(list),
    }));
  };
  if (by === "owner") return byOwner(rows);
  if (by === "type") {
    const groups = new Map<string, DropperRow[]>();
    for (const r of rows) groups.set(r.entry.id, [...(groups.get(r.entry.id) ?? []), r]);
    return [...groups].map(([id, list]) => ({ key: `type:${id}`, title: names.type(id), detail: counted(list, "placed", "placed"), rows: list, centre: centreOf(list) }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  }
  const inCamps = rows.filter((r) => playerOf(r.entry) === undefined || playerOf(r.entry) === NEUTRAL_HOSTILE);
  const camps = clusterNear(inCamps, (r) => [r.entry.position[0], r.entry.position[1]], SAME_CAMP)
    .map((list) => ({ list, centre: centreOf(list) }))
    // North first (the top of the map), then west: rows of 1024 so a camp a little lower doesn't jump the queue.
    .sort((a, b) => Math.floor(b.centre[1] / 1024) - Math.floor(a.centre[1] / 1024) || a.centre[0] - b.centre[0]);
  const out = camps.map(({ list, centre }, i): DropGroup => {
    const creeps = list.filter((r) => playerOf(r.entry) !== undefined);
    const things = list.length === creeps.length ? counted(list, "creep", "creeps") : counted(list, "object", "objects");
    return {
      key: `camp:${i}:${list.map((r) => r.entry.position.join(",")).join(";")}`, title: `Camp ${i + 1}`, detail: `${things} · at ${Math.round(centre[0])}, ${Math.round(centre[1])}`, rows: list, centre,
      ...(creeps.length ? { level: campLevel(creeps.map((r) => r.level)) } : {}),
    };
  });
  return [...out, ...byOwner(rows.filter((r) => !inCamps.includes(r)))];
}

/** Which rows use each map item table, by its number; tables nothing uses are there with no rows. A number used
 *  that isn't one of the map's tables is under `missing`. */
export function tableUse(rows: readonly DropperRow[], tables: readonly { number: number }[]): { used: Map<number, DropperRow[]>; missing: Map<number, DropperRow[]> } {
  const used = new Map<number, DropperRow[]>(tables.map((t) => [t.number, []]));
  const missing = new Map<number, DropperRow[]>();
  for (const r of rows) {
    const d = dropsOf(r.entry);
    if (d.mode !== "table") continue;
    const into = used.has(d.table) ? used : missing;
    into.set(d.table, [...(into.get(d.table) ?? []), r]);
  }
  return { used, missing };
}

// ---- edits over several objects ----------------------------------------------------------------

/** What happens to several objects' drops in one step: the same for all, or a set added to each one's own sets. */
export type BulkDrops = { op: "same"; drops: Drops } | { op: "addSet"; set: DropItem[] };

/** Each object's drops after a bulk edit, in their order; or why it can't be done (nothing is changed then). Adding a
 *  set keeps what each one drops already: own sets get it after theirs, one that drops nothing gets it as its only
 *  set; one that drops from a map item table is refused rather than losing the table. */
export function bulkDrops(entries: readonly Placed[], edit: BulkDrops): { error: string } | { drops: Drops[] } {
  if (edit.op === "same") return { drops: entries.map(() => structuredClone(edit.drops)) };
  const tabled = entries.filter((e) => dropsOf(e).mode === "table");
  if (tabled.length) {
    return { error: `${tabled.length === entries.length ? (entries.length === 1 ? "It drops" : "They drop") : `${tabled.length} of them drop`} from a map item table: a set can only be added to own item sets.` };
  }
  return {
    drops: entries.map((e) => {
      const d = dropsOf(e);
      return { mode: "custom", sets: [...(d.mode === "custom" ? d.sets : []), structuredClone(edit.set)] };
    }),
  };
}
