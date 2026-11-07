// The object ids a placed unit, item, destructable or doodad holds: its own type, the skin it shows,
// what it carries and what it can do, what it drops, and what a random placement picks from. Moving
// placements to another map needs these types there, and a type given another id there needs them changed.

type Entry = Record<string, unknown>;

const idOf = (v: unknown): string | null => (typeof v === "string" && v.length === 4 ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Every id the entry holds, once each. */
export function entryIds(entry: Entry): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { const id = idOf(v); if (id) out.add(id); };
  add(entry.id);
  add(entry.skinId);
  add(entry.randomId);
  for (const k of ["inventory", "abilities", "randomUnits"]) for (const x of list(entry[k])) add((x as Entry | null)?.id);
  for (const set of list(entry.itemSets)) for (const x of list(set)) add((x as Entry | null)?.id);
  return [...out];
}

/** A copy of the entry with ids replaced (`to`: old to new). Ids not in `to` stay. */
export function renamedEntry<T extends Entry>(entry: T, to: ReadonlyMap<string, string>): T {
  const out = structuredClone(entry) as Entry;
  const swap = (v: unknown) => (typeof v === "string" && to.has(v) ? to.get(v)! : v);
  for (const k of ["id", "skinId", "randomId"]) if (k in out) out[k] = swap(out[k]);
  const inItems = (x: unknown) => { if (x && typeof x === "object" && "id" in x) (x as Entry).id = swap((x as Entry).id); };
  for (const k of ["inventory", "abilities", "randomUnits"]) for (const x of list(out[k])) inItems(x);
  for (const set of list(out.itemSets)) for (const x of list(set)) inItems(x);
  return out as T;
}
