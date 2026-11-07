// Which object ids an object's fields hold: "Y01q,Y01w" in an ability list, one unit code, … It serves the
// Object Manager (what is used) and copying objects between maps (what a copy refers to).

export interface RefMod { field?: string; value: unknown }
export interface RefObject { id?: string; base: string; mods?: RefMod[]; sets?: { mods: RefMod[] }[] }

/** Every modification of an object, whichever way its file groups them. */
export function modsOf<M extends RefMod>(o: { mods?: M[]; sets?: { mods: M[] }[] }): M[] {
  return [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)];
}

/** The separators of a list of ids. */
const SEPARATORS = /[,;\s]+/;

/** The words of a field's text: one id, or a comma list of them. */
export function tokensOf(value: string): string[] {
  return value.split(SEPARATORS);
}

/** The ids among `ids` that the object's fields hold, once each in the order found, not its own.
 *  `holdsIds` narrows it to fields that are meant to hold ids (by their metadata type); without it
 *  every text field counts. */
export function idsUsedBy(o: RefObject, ids: ReadonlySet<string>, holdsIds?: (field: string) => boolean): string[] {
  const self = o.id ?? o.base;
  const out = new Set<string>();
  for (const m of modsOf(o)) {
    if (typeof m.value !== "string" || (holdsIds && !holdsIds(m.field ?? ""))) continue;
    for (const token of tokensOf(m.value)) if (token !== self && ids.has(token)) out.add(token);
  }
  return [...out];
}

/** A field's text with ids replaced (separators stay as they are). */
export function replaceIds(value: string, to: ReadonlyMap<string, string>): string {
  return value.split(/([,;\s]+)/).map((t, i) => (i % 2 === 0 ? to.get(t) ?? t : t)).join("");
}
