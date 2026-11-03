// Object data (war3map.w3u.json, …) compared per object: which objects were added, removed or
// changed, and per changed object which fields (with level, data column and set) and how.

interface Mod { field: string; type?: string; level?: number; data?: number; value: unknown }
interface Obj { base: string; id?: string; end?: string; sets?: { flag: number; mods: Mod[] }[]; mods?: Mod[] }
export interface ObjectFileJson { original?: Obj[]; custom?: Obj[] }

export interface FieldChange {
  field: string;
  level?: number;
  data?: number;
  /** Only for files with sets (v3) when the set's flag isn't 0. */
  set?: number;
  before?: unknown;
  after?: unknown;
}
export interface ObjectChange {
  section: "original" | "custom";
  /** The object's id (custom objects) or the game object it modifies. */
  id: string;
  base: string;
  what: "added" | "removed" | "changed";
  fields: FieldChange[];
}

/** Mods by field/level/data/set. */
function mods(o: Obj): Map<string, FieldChange & { value: unknown }> {
  const out = new Map<string, FieldChange & { value: unknown }>();
  const add = (m: Mod, set: number) => out.set(`${set}|${m.field}|${m.level ?? 0}|${m.data ?? 0}`,
    { field: m.field, level: m.level || undefined, data: m.data || undefined, set: set || undefined, value: m.value });
  for (const m of o.mods ?? []) add(m, 0);
  for (const s of o.sets ?? []) for (const m of s.mods) add(m, s.flag);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Changes from `before` to `after` (either may be null: file added or removed), in file order. */
export function diffObjects(before: ObjectFileJson | null, after: ObjectFileJson | null): ObjectChange[] {
  const out: ObjectChange[] = [];
  for (const section of ["original", "custom"] as const) {
    const key = (o: Obj) => (section === "custom" ? o.id ?? o.base : o.base);
    const a = new Map((before?.[section] ?? []).map((o) => [key(o), o]));
    const b = new Map((after?.[section] ?? []).map((o) => [key(o), o]));
    const ids = [...new Set([...b.keys(), ...a.keys()])];
    for (const id of ids) {
      const x = a.get(id), y = b.get(id);
      if (x && y && same(x, y)) continue;
      const mx = x ? mods(x) : new Map(), my = y ? mods(y) : new Map();
      const fields: FieldChange[] = [];
      for (const k of new Set([...my.keys(), ...mx.keys()])) {
        const p = mx.get(k), q = my.get(k);
        if (p && q && same(p.value, q.value)) continue;
        const { value: _, ...where } = (q ?? p)!;
        fields.push({ ...where, ...(p ? { before: p.value } : {}), ...(q ? { after: q.value } : {}) });
      }
      // Objects whose only difference isn't in their mods (e.g. a changed base) still count.
      out.push({ section, id, base: (y ?? x)!.base, what: !x ? "added" : !y ? "removed" : "changed", fields });
    }
  }
  return out;
}
