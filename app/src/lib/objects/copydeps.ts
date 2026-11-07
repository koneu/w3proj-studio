// Copying objects between maps: what a copy refers to, and what pasting does with it.
//
// A custom unit trains another custom unit, has custom abilities, and those use custom buffs. Pasted into
// another map without them, its fields would name objects that map doesn't have. So a copy takes along the
// map's own objects that the copied ones refer to, however far (standard objects exist in every map and
// stay out). Pasting finds what the target has under the same ids: the same content is reused; other
// content is a conflict that the user settles for all of them at once.
//
// Which fields hold ids is the object data's metadata (unitCode, abilityList, …): `holdsIds` tells it.
// Plain functions on plain data; the editor reads and writes the files.

import { idsUsedBy, modsOf, replaceIds } from "./refs";

export interface CopyMod { field: string; type?: string; level?: number; data?: number; value: number | string; end?: string }
export interface CopyObject { base: string; id?: string; end?: string; sets?: { flag: number; mods: CopyMod[] }[]; mods?: CopyMod[] }
/** An object with its kind ("w3u", "w3a", …). */
export interface Copied { ext: string; object: CopyObject }
/** What is copied: `chosen` is what the user picked, `along` what it refers to (custom objects of the
 *  source map, transitively). */
export interface CopySet { chosen: Copied[]; along: Copied[] }

/** Whether a field (of a kind) holds object ids. */
export type HoldsIds = (ext: string, field: string) => boolean;

const usedIds = (c: Copied, ids: ReadonlySet<string>, holdsIds: HoldsIds) => idsUsedBy(c.object, ids, (f) => holdsIds(c.ext, f));

/** The custom objects of the source map (`customs`, by id) that `from` refers to, directly or through
 *  each other, without `from` itself. In the order they were found. */
export function referencedBy(from: readonly Copied[], customs: ReadonlyMap<string, Copied>, holdsIds: HoldsIds): Copied[] {
  const ids = new Set(customs.keys());
  const seen = new Set(from.flatMap((c) => (c.object.id ? [c.object.id] : [])));
  const out: Copied[] = [];
  const queue = [...from];
  for (let i = 0; i < queue.length; i++) {
    for (const id of usedIds(queue[i], ids, holdsIds)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const c = customs.get(id)!;
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/** The mods of a list, in an order that doesn't depend on how the file had them. */
function canonical(mods: readonly CopyMod[]): string {
  return JSON.stringify(mods.map((m) => [m.field, m.level ?? 0, m.data ?? 0, m.type ?? "", m.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/** The changes of an object as sets: older files keep them in `mods` (one set). */
const setsOf = (o: CopyObject) => (o.sets ?? (o.mods?.length ? [{ flag: 0, mods: o.mods }] : [])).filter((s) => s.mods.length).map((s) => `${s.flag}:${canonical(s.mods)}`).sort().join("|");

/** Whether two objects are the same thing: same base and the same fields with the same values. Their
 *  ids, and the `end` marker older files carry, don't count. */
export function sameContent(a: CopyObject, b: CopyObject): boolean {
  return a.base === b.base && setsOf(a) === setsOf(b);
}

/** A copy of the object with ids in its id fields replaced. */
export function withIdsReplaced(c: Copied, to: ReadonlyMap<string, string>, holdsIds: HoldsIds): CopyObject {
  const o = structuredClone(c.object);
  if (!to.size) return o;
  for (const m of modsOf(o)) if (typeof m.value === "string" && holdsIds(c.ext, m.field)) m.value = replaceIds(m.value, to);
  return o;
}

export type Policy = "keep" | "overwrite" | "new";
/** What happens to an object that comes along:
 *  - add: the target has nothing under its id;
 *  - same: the target has the same, which is used;
 *  - kept: the target has something else under the id, and keeps it;
 *  - overwritten: the target's is replaced;
 *  - renamed: it comes under a new id (because the user said so, or the id is taken by a game object
 *    or by another kind, or an object it refers to got a new id so it isn't the same any more). */
export type Fate = "add" | "same" | "kept" | "overwritten" | "renamed";

export interface PlanItem {
  ext: string;
  object: CopyObject;
  /** The id in the source map; none for a standard object's changes. */
  from?: string;
  /** The id in the target, when the object is written there. */
  to?: string;
  /** "chosen": what the user picked, which always comes as a new object. */
  fate: Fate | "chosen";
  /** Why a rename was forced, for the list shown to the user. */
  reason?: string;
}

export interface PasteWorld {
  /** The target's custom object of an id (any kind). */
  existing(id: string): Copied | undefined;
  /** Whether the id belongs to a standard object of any kind in the target. */
  game(id: string): boolean;
  /** Every id the target uses, to pick new ones from. */
  taken: ReadonlySet<string>;
  /** The next free id for an object of a kind and base; `taken` also holds those handed out so far. */
  allocate(ext: string, base: string, taken: Set<string>): string;
  holdsIds: HoldsIds;
}

export interface Plan {
  items: PlanItem[];
  /** Ids (in the source) of objects the target has with other content: what the user has to decide. */
  conflicts: string[];
  /** Source id → id in the target, for everything that gets another one. */
  renames: Map<string, string>;
  /** Objects to write; `overwrites` is set where the target's object of that id is replaced. */
  writes: { ext: string; object: CopyObject; overwrites?: string }[];
}

/** What pasting does. `chosenAreNew`: what was picked comes as new objects under new ids (an object
 *  copy); otherwise it is treated like what comes along (a map piece that needs its objects' types). */
export function planPaste(set: CopySet, world: PasteWorld, policy: Policy, chosenAreNew = true): Plan {
  const all: Copied[] = chosenAreNew ? [...set.along] : [...set.chosen, ...set.along];
  const sourceIds = new Set([...set.chosen, ...set.along].flatMap((c) => (c.object.id ? [c.object.id] : [])));
  const fate = new Map<string, Fate>();
  const reason = new Map<string, string>();
  const conflicts: string[] = [];
  for (const c of all) {
    const id = c.object.id!;
    const there = world.existing(id);
    if (world.game(id)) { fate.set(id, "renamed"); reason.set(id, "a game or campaign object has the id"); }
    else if (!there) fate.set(id, "add");
    else if (there.ext !== c.ext) { fate.set(id, "renamed"); reason.set(id, "another kind of object has the id"); }
    else if (sameContent(there.object, c.object)) fate.set(id, "same");
    else {
      conflicts.push(id);
      fate.set(id, policy === "keep" ? "kept" : policy === "overwrite" ? "overwritten" : "renamed");
    }
  }
  // Whatever gets a new id changes what refers to it: a reused object that does isn't the same any more.
  const renamed = new Set<string>(chosenAreNew ? set.chosen.flatMap((c) => (c.object.id ? [c.object.id] : [])) : []);
  for (const [id, f] of fate) if (f === "renamed") renamed.add(id);
  for (let again = true; again;) {
    again = false;
    for (const c of all) {
      const id = c.object.id!;
      if (fate.get(id) !== "same") continue;
      if (usedIds(c, sourceIds, world.holdsIds).some((u) => renamed.has(u))) {
        fate.set(id, "renamed");
        reason.set(id, "it refers to an object that gets a new id");
        renamed.add(id);
        again = true;
      }
    }
  }
  // New ids, not those of objects that keep theirs.
  const taken = new Set(world.taken);
  for (const c of all) if (["add", "overwritten", "kept", "same"].includes(fate.get(c.object.id!)!)) taken.add(c.object.id!);
  const renames = new Map<string, string>();
  const order = chosenAreNew ? [...set.chosen, ...all] : all;
  const fresh = new Map<Copied, string>();
  for (const c of order) {
    const id = c.object.id;
    const isChosen = chosenAreNew && set.chosen.includes(c);
    if (!isChosen && (!id || fate.get(id) !== "renamed")) continue;
    const to = world.allocate(c.ext, c.object.base, taken);
    taken.add(to);
    fresh.set(c, to);
    if (id) renames.set(id, to);
  }
  const items: PlanItem[] = [], writes: Plan["writes"] = [];
  const write = (c: Copied, to: string, overwrites?: string) => writes.push({ ext: c.ext, object: { ...withIdsReplaced(c, renames, world.holdsIds), id: to }, overwrites });
  for (const c of order) {
    const id = c.object.id;
    if (chosenAreNew && set.chosen.includes(c)) {
      items.push({ ext: c.ext, object: c.object, from: id, to: fresh.get(c), fate: "chosen" });
      write(c, fresh.get(c)!);
      continue;
    }
    const f = fate.get(id!)!;
    items.push({ ext: c.ext, object: c.object, from: id, to: f === "kept" || f === "same" ? id : f === "renamed" ? fresh.get(c) : id, fate: f, reason: reason.get(id!) });
    if (f === "add") write(c, id!);
    else if (f === "overwritten") write(c, id!, id);
    else if (f === "renamed") write(c, fresh.get(c)!);
  }
  return { items, conflicts, renames, writes };
}
