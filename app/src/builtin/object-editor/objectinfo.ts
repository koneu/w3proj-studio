// Objects as the MCP tools tell about them: names and labels in place of four-letter codes.

import type { KindData } from "../../lib/objects/metadata";

export const OBJECT_KINDS: Record<string, string> = {
  units: "w3u", items: "w3t", abilities: "w3a", buffs: "w3h", destructables: "w3b", doodads: "w3d", upgrades: "w3q",
};

interface Mod { field: string; level?: number; value: number | string }
export interface MapObject { base: string; id?: string; mods?: Mod[]; sets?: { mods: Mod[] }[] }
export interface MapObjects { original?: MapObject[]; custom?: MapObject[] }

type Kind = Pick<KindData, "names" | "fieldById">;
type Resolve = (value: string) => string;

const plain = (s: string) => s.replace(/\|c[0-9a-f]{8}|\|r/gi, "");
const modsOf = (o: MapObject) => [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)];
const shown = (value: number | string, resolve: Resolve) => (typeof value === "string" ? plain(resolve(value)) : value);

/** The name the map gives an object, else its base's. */
export function objectName(o: MapObject, kind: Kind, resolve: Resolve): string {
  const own = modsOf(o).find((m) => /nam$/.test(m.field) && typeof m.value === "string" && m.value);
  return plain(own ? resolve(own.value as string) : kind.names.get(o.base) ?? o.base);
}

/** Where a kind says which tilesets an object is made for. */
const TILESET_FIELDS = ["btil", "dtil"];

const MODEL_FIELDS = ["umdl", "ifil", "bfil", "dfil"];
const SCALE_FIELDS = [["bmis", "bmas"], ["dmis", "dmas"]];
const PATH_FIELDS = ["bptx", "dptx", "upat"];
const VARIATION_FIELDS = ["bvar", "dvar"];

/** Stored model → the graphics packs it's only in; empty when the base game has it. */
export function modelPacks(all: readonly string[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const full of all) {
    if (!/\.mdx$/i.test(full)) continue;
    const key = full.slice(full.lastIndexOf(":") + 1).replace(/\.mdx$/i, "").replace(/\//g, "\\").toLowerCase();
    const set = out.get(key) ?? new Set<string>();
    const pack = /^War3\.w3mod:_(HD|DE|Teen)\b/i.exec(full)?.[1].toUpperCase();
    set.add(pack ?? "");
    out.set(key, set);
  }
  return new Map([...out].map(([k, v]) => [k, v.has("") ? [] : [...v].sort()]));
}

/** What a model means for an object: nothing to report, or that it won't show everywhere. Types
 *  with variations have a file for each, and a placed one uses just its own, so each counts. */
function modelNote(path: string | undefined, variations: number, stored: ReadonlyMap<string, string[]>): { noModel?: boolean; modelOnlyIn?: string[]; variationsWithoutModel?: number[] } {
  const key = (path ?? "").replace(/\.md[lx]$/i, "").replace(/\//g, "\\").toLowerCase();
  if (!key || key === "_") return { noModel: true };
  const files = variations > 1 ? Array.from({ length: variations }, (_, i) => stored.get(`${key}${i}`)) : [stored.get(key) ?? stored.get(`${key}0`)];
  if (files.every((f) => !f)) return { noModel: true };
  const missing = files.flatMap((f, i) => (f ? [] : [i]));
  const packs = [...new Set(files.flatMap((f) => f ?? []))].sort();
  return { ...(packs.length ? { modelOnlyIn: packs } : {}), ...(missing.length ? { variationsWithoutModel: missing } : {}) };
}

/** The game's objects of a kind, with what sets them apart. `tileset`: its letter; objects for
 *  all tilesets have "*". `stored`: from modelPacks, to check models. */
export function gameObjectList(kind: Pick<KindData, "baseIds" | "names" | "facets" | "fieldById" | "defaultValue">, clean: (s: string) => string, tileset?: string, category?: string, stored?: ReadonlyMap<string, string[]>, treesOnly = false) {
  const field = TILESET_FIELDS.map((f) => kind.fieldById.get(f)).find(Boolean);
  const fits = (id: string) => {
    if (!tileset || !field) return true;
    const list = (kind.defaultValue(id, field, 0) ?? "*").toUpperCase();
    return list.includes("*") || list.includes(tileset.toUpperCase());
  };
  const wanted = category?.toLowerCase();
  const value = (id: string, fieldId: string) => { const f = kind.fieldById.get(fieldId); return f ? kind.defaultValue(id, f, 0) : undefined; };
  const model = MODEL_FIELDS.find((f) => kind.fieldById.has(f));
  const scale = SCALE_FIELDS.find(([low]) => kind.fieldById.has(low));
  const room = PATH_FIELDS.find((f) => kind.fieldById.has(f));
  const variation = VARIATION_FIELDS.find((f) => kind.fieldById.has(f));
  const isTree = (id: string) => /\btree\b/.test(kind.facets(id).target ?? "");
  return kind.baseIds.filter((id) => fits(id) && (!treesOnly || isTree(id))).map((id) => {
    const facets = kind.facets(id);
    const low = scale && Number(value(id, scale[0])), high = scale && Number(value(id, scale[1]));
    const path = room && value(id, room);
    return {
      id, name: clean(kind.names.get(id) ?? id), ...(facets.category ? { category: facets.category } : {}),
      ...(stored && model ? modelNote(value(id, model), Number(variation && value(id, variation)) || 1, stored) : {}),
      ...(low && high ? { sizeRange: [low, high] } : {}),
      // Not known isn't the same as none.
      ...(path ? { takesRoom: path !== "_" && path.toLowerCase() !== "none" } : {}),
      ...(isTree(id) ? { tree: true } : {}),
    };
  }).filter((o) => !wanted || o.category?.toLowerCase().includes(wanted));
}

/** One line per object the map adds or changes. */
export function mapObjectList(file: MapObjects, kind: Kind, resolve: Resolve) {
  const line = (o: MapObject, custom: boolean) => ({
    id: o.id ?? o.base, ...(custom ? { base: o.base } : {}), name: objectName(o, kind, resolve), custom, changes: modsOf(o).length,
  });
  return [...(file.custom ?? []).map((o) => line(o, true)), ...(file.original ?? []).map((o) => line(o, false))];
}

/** The fields a map object sets, labelled. */
export function changedFields(o: MapObject, kind: Kind, resolve: Resolve) {
  return modsOf(o).map((m) => ({
    field: m.field, label: kind.fieldById.get(m.field)?.label ?? m.field, ...(m.level ? { level: m.level } : {}), value: shown(m.value, resolve),
  }));
}

/** Every field of an object as the game defines it (its base's values), one level of each. */
export function gameFields(baseId: string, kind: Pick<KindData, "fieldsFor" | "defaultValue">) {
  return kind.fieldsFor(baseId).flatMap((f) => {
    const value = kind.defaultValue(baseId, f, f.repeat > 0 ? 1 : 0);
    return value === undefined || value === "" ? [] : [{ field: f.id, label: f.label, value }];
  });
}
