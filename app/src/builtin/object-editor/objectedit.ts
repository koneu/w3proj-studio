// Changing object data for the MCP tools, the way the Object Editor changes it.

import type { FieldMeta } from "../../lib/objects/metadata";

export interface EditMod { field: string; type: string; level?: number; data?: number; value: number | string; end?: string }
export interface EditObject { base: string; id?: string; end?: string; sets?: { flag: number; mods: EditMod[] }[]; mods?: EditMod[] }
export interface EditFile { format: string; version: number; original: EditObject[]; custom: EditObject[] }

/** These kinds store a level and a data number with every value. */
const OPT_INTS = new Set(["w3a", "w3d", "w3q"]);

const lists = (o: EditObject): EditMod[][] => (o.sets ? o.sets.map((s) => s.mods) : [(o.mods ??= [])]);

/** What's typed as a value of a field; throws if it can't be one. */
export function fieldValue(f: Pick<FieldMeta, "id" | "label" | "valueType">, value: unknown): number | string {
  if (f.valueType === "string") return String(value);
  const n = Number(value);
  if (value === "" || value === null || typeof value === "boolean" || !Number.isFinite(n)) throw new Error(`${f.label} (${f.id}) takes a number.`);
  if (f.valueType === "int" && !Number.isInteger(n)) throw new Error(`${f.label} (${f.id}) takes a whole number.`);
  if (f.valueType === "unreal" && n < 0) throw new Error(`${f.label} (${f.id}) can't be negative.`);
  return n;
}

/** The level a call means: repeating fields have 1 and up, others none. */
export function fieldLevel(f: Pick<FieldMeta, "id" | "label" | "repeat">, level: unknown): number {
  if (f.repeat <= 0) {
    if (level !== undefined && level !== 0) throw new Error(`${f.label} (${f.id}) has no levels.`);
    return 0;
  }
  const n = level === undefined ? 1 : Number(level);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${f.label} (${f.id}) needs a level from 1.`);
  return n;
}

/** `value` null takes the field back to the game's value. */
export function setObjectField(o: EditObject, kind: string, f: FieldMeta, level: number, value: number | string | null, gameValue: string | undefined) {
  const all = lists(o);
  const where = all.find((mods) => mods.some((m) => m.field === f.id && (m.level ?? 0) === level));
  const found = where?.find((m) => m.field === f.id && (m.level ?? 0) === level);
  if (value === null) {
    if (where && found) where.splice(where.indexOf(found), 1);
    return;
  }
  if (found) { found.value = value; return; }
  if (String(value) === String(gameValue ?? "")) return;
  const mod: EditMod = { field: f.id, type: f.valueType, value };
  if (OPT_INTS.has(kind)) { mod.level = level; mod.data = f.data; } else if (level) mod.level = level;
  all[0].push(mod);
}

/** Adds a game object to the file's changed ones if it isn't there, and gives the object to change. */
export function objectToEdit(file: EditFile, id: string, exists: boolean): EditObject {
  const known = file.custom.find((o) => o.id === id) ?? file.original.find((o) => o.base === id);
  if (known) return known;
  if (!exists) throw new Error(`There's no object "${id}" in this map or the game.`);
  const o: EditObject = file.version >= 3 ? { base: id, mods: [] } : { base: id, end: id, mods: [] };
  file.original.push(o);
  return o;
}

export function addCustomObject(file: EditFile, base: string, id: string): EditObject {
  const o: EditObject = file.version >= 3 ? { base, id, mods: [] } : { base, id, end: id, mods: [] };
  file.custom.push(o);
  return o;
}

/** What a copied object holds: its own texts, not references to this map's string table. Those would
 *  mean nothing in another map, and here renaming the copy would rename the original. */
export function copyOf(o: EditObject, text: (value: string) => string | null): EditObject {
  const copy = structuredClone(o);
  for (const mods of lists(copy)) {
    for (const m of mods) {
      const own = typeof m.value === "string" ? text(m.value) : null;
      if (own !== null) m.value = own;
    }
  }
  return copy;
}

/** A new custom object from a copy, standard or custom, under its own id. */
export function pastedObject(copied: EditObject, id: string, version: number): EditObject {
  const o = structuredClone(copied);
  o.id = id;
  if (version >= 3) delete o.end; else o.end = id;
  return o;
}

/** Removes a custom object, or a game object's changes. False if the map has neither. */
export function removeObject(file: EditFile, id: string): boolean {
  for (const [list, match] of [[file.custom, (o: EditObject) => o.id === id], [file.original, (o: EditObject) => o.base === id]] as const) {
    const at = list.findIndex(match);
    if (at >= 0) { list.splice(at, 1); return true; }
  }
  return false;
}
