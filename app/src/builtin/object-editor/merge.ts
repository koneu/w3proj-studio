// Object data changed by another program (a Git pull) while the Object Editor has unsaved edits
// (docs/object-folders-spec.md section 6): a three-way merge of the file as the editor last read or saved it
// (`base`), the editor's (`mine`) and the one on disk now (`theirs`). An object the editor didn't change is
// theirs; one only the editor changed is mine. One changed on both sides is merged field by field (a field both
// changed differently keeps the editor's value) and reported, so it can be flagged.

import type { EditFile, EditMod, EditObject } from "./objectedit";

/** An object changed on both sides. */
export interface ObjectConflict {
  /** "c:<id>" for a custom object, "o:<base>" for a changed game object. */
  key: string;
  /** The fields both sides changed differently (the editor's values were kept). */
  fields: string[];
  /** Their object, to take instead; null when they removed it. */
  theirs: EditObject | null;
  /** The editor had removed it: it stays removed. */
  removedHere: boolean;
}

type ListName = "original" | "custom";
interface Flagged { flag: number; m: EditMod }

const flagged = (o: EditObject): Flagged[] =>
  o.sets ? o.sets.flatMap((s) => s.mods.map((m) => ({ flag: s.flag, m }))) : (o.mods ?? []).map((m) => ({ flag: 0, m }));
const modKey = (x: Flagged) => `${x.flag}/${x.m.field}/${x.m.level ?? 0}/${x.m.data ?? 0}`;
const modValue = (m: EditMod | undefined) => (m ? JSON.stringify([m.type, m.value, m.end ?? null]) : "");
/** A map's mods by their key; a key held twice (a damaged or odd file) keeps both, numbered. */
function byKey(o: EditObject | undefined): Map<string, Flagged> {
  const out = new Map<string, Flagged>();
  for (const x of o ? flagged(o) : []) {
    let key = modKey(x);
    for (let n = 2; out.has(key); n++) key = `${modKey(x)}#${n}`;
    out.set(key, x);
  }
  return out;
}

/** What an object holds, whatever the order of its fields. */
const content = (o: EditObject | undefined) =>
  o ? JSON.stringify([o.base, o.id ?? null, [...byKey(o)].map(([k, x]) => `${k}=${modValue(x.m)}`).sort()]) : "";

/** The objects of one list by key. A changed game object without fields counts as not there (the editor leaves such
 *  out of the file). Two objects of one key (a damaged map) are numbered in their order. */
function keyed(file: EditFile, list: ListName): Map<string, EditObject> {
  const out = new Map<string, EditObject>();
  for (const o of file[list]) {
    if (list === "original" && !flagged(o).length) continue;
    const plain = list === "custom" ? `c:${o.id}` : `o:${o.base}`;
    let key = plain;
    for (let n = 2; out.has(key); n++) key = `${plain}#${n}`;
    out.set(key, o);
  }
  return out;
}

/** Whether two files hold the same objects with the same values. */
export function sameObjects(a: EditFile, b: EditFile): boolean {
  return (["original", "custom"] as const).every((list) => {
    const x = keyed(a, list), y = keyed(b, list);
    return x.size === y.size && [...x].every(([k, o]) => content(o) === content(y.get(k)));
  });
}

/** Puts `value` (null: takes it away) at `key` into `o`, whose fields are plain or in flagged sets. */
function setMod(o: EditObject, key: string, flag: number, value: EditMod | null) {
  if (flag !== 0 && !o.sets) { o.sets = [{ flag: 0, mods: o.mods ?? [] }]; delete o.mods; }
  const at = byKey(o).get(key);
  if (at) {
    const list = o.sets ? o.sets.find((s) => s.mods.includes(at.m))!.mods : o.mods!;
    if (value) list[list.indexOf(at.m)] = structuredClone(value);
    else list.splice(list.indexOf(at.m), 1);
    return;
  }
  if (!value) return;
  let list: EditMod[];
  if (o.sets) {
    let set = o.sets.find((s) => s.flag === flag);
    if (!set) o.sets.push((set = { flag, mods: [] }));
    list = set.mods;
  } else list = (o.mods ??= []);
  list.push(structuredClone(value));
}

/** Their object with the editor's field changes on it, and the fields both changed differently. */
function mergeFields(base: EditObject | undefined, mine: EditObject, theirs: EditObject): { object: EditObject; fields: string[] } {
  const b = byKey(base), m = byKey(mine), t = byKey(theirs);
  const object = structuredClone(theirs);
  const fields = new Set<string>();
  for (const key of new Set([...b.keys(), ...m.keys()])) {
    const was = modValue(b.get(key)?.m), here = modValue(m.get(key)?.m), there = modValue(t.get(key)?.m);
    if (here === was) continue;
    if (there !== was && there !== here) fields.add((m.get(key) ?? b.get(key))!.m.field);
    setMod(object, key, (m.get(key) ?? b.get(key))!.flag, m.get(key)?.m ?? null);
  }
  return { object, fields: [...fields] };
}

/** The merged file (their header and order; objects only the editor has come after theirs) and the objects changed on
 *  both sides. None of the inputs is changed. */
export function mergeChanged(base: EditFile, mine: EditFile, theirs: EditFile): { file: EditFile; conflicts: ObjectConflict[] } {
  const conflicts: ObjectConflict[] = [];
  const lists = { original: [] as EditObject[], custom: [] as EditObject[] };
  for (const list of ["original", "custom"] as const) {
    const b = keyed(base, list), m = keyed(mine, list), t = keyed(theirs, list);
    for (const key of new Set([...t.keys(), ...m.keys()])) {
      const was = b.get(key), here = m.get(key), there = t.get(key);
      const x = content(was), y = content(here), z = content(there);
      let result: EditObject | undefined;
      if (y === x) result = there;
      else if (z === x) result = here;
      else if (y === z) result = there;
      else {
        const conflict: ObjectConflict = { key, fields: [], theirs: there ? structuredClone(there) : null, removedHere: !here };
        conflicts.push(conflict);
        // Removed on one side, or two different objects given one id: the editor's stands whole.
        if (!here || !there || here.base !== there.base) result = here;
        else {
          const merged = mergeFields(was, here, there);
          result = merged.object;
          conflict.fields = merged.fields;
        }
      }
      if (result) lists[list].push(structuredClone(result));
    }
  }
  return { file: { ...structuredClone(theirs), ...lists }, conflicts };
}
