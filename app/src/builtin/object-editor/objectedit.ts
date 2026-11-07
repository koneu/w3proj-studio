// Changing object data for the MCP tools, the way the Object Editor changes it.

import type { FieldMeta } from "../../lib/objects/metadata";
import type { CopyObject, Plan } from "../../lib/objects/copydeps";

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

export interface AutoFill { from: number; to: number; base: number; previous: number; level: number; constant: number }

/** The World Editor's Auto Fill Levels: level `from` gets the base value, and each after it the one before
 *  times `previous`, plus its level times `level`, plus `constant`. */
export function autoFill(o: AutoFill): { level: number; value: number }[] {
  const out = [{ level: o.from, value: o.base }];
  for (let n = o.from + 1; n <= o.to; n++) out.push({ level: n, value: out[out.length - 1].value * o.previous + n * o.level + o.constant });
  return out;
}

/** The same for text: `mark` in the base text stands for the level. */
export function autoFillText(text: string, mark: string, from: number, to: number): { level: number; value: string }[] {
  const out: { level: number; value: string }[] = [];
  for (let n = from; n <= to; n++) out.push({ level: n, value: mark ? text.split(mark).join(String(n)) : text });
  return out;
}

/** Takes in objects from a file: what's there under the same id, or base for game objects, is replaced. */
export function mergeObjects(file: EditFile, imported: Pick<EditFile, "original" | "custom">) {
  let added = 0, replaced = 0;
  const take = (list: EditObject[], items: EditObject[], same: (a: EditObject, b: EditObject) => boolean) => {
    for (const o of items) {
      const at = list.findIndex((x) => same(x, o));
      if (at >= 0) { list[at] = structuredClone(o); replaced++; } else { list.push(structuredClone(o)); added++; }
    }
  };
  take(file.custom, imported.custom ?? [], (a, b) => a.id === b.id);
  take(file.original, imported.original ?? [], (a, b) => a.base === b.base);
  return { added, replaced };
}

/** The kinds a plan writes to. */
export const kindsOf = (plan: Plan) => [...new Set(plan.writes.map((w) => w.ext))];

/** Puts a plan's objects into a file: new ones at the end, overwritten ones in place. */
export function writeInto(file: EditFile, ext: string, plan: Plan): CopyObject[] {
  const made: CopyObject[] = [];
  for (const w of plan.writes.filter((x) => x.ext === ext)) {
    const o = pastedObject(w.object as EditObject, w.object.id!, file.version) as CopyObject;
    const at = w.overwrites ? file.custom.findIndex((x) => x.id === w.overwrites) : -1;
    if (at >= 0) file.custom[at] = o as EditObject; else file.custom.push(o as EditObject);
    made.push(o);
  }
  return made;
}

/** One line telling what pasting a map piece did: its objects all come as the types the placed objects use. */
export function summaryTypes(plan: Plan): string {
  const added = plan.items.filter((i) => i.fate === "add" || i.fate === "overwritten" || i.fate === "renamed").length;
  const used = plan.items.filter((i) => i.fate === "same" || i.fate === "kept").length;
  return `Added ${added} object${added === 1 ? "" : "s"} to the map for the pasted ones${used ? `; ${used} ${used === 1 ? "was" : "were"} there already` : ""}.`;
}

/** One line telling what a paste did. */
export function summary(plan: Plan): string {
  const count = (fates: string[]) => plan.items.filter((i) => fates.includes(i.fate)).length;
  const chosen = count(["chosen"]), along = count(["add", "overwritten", "renamed"]), used = count(["same", "kept"]);
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
  return `Pasted ${n(chosen, "object")}${along ? ` and ${n(along, "object")} they refer to` : ""}${used ? `; ${n(used, "object")} they refer to ${used === 1 ? "was" : "were"} in the map already` : ""}.`;
}
