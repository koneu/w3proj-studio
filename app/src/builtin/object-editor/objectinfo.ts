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

/** The game's objects of a kind, with what sets them apart. `tileset`: its letter; objects for
 *  all tilesets have "*". */
export function gameObjectList(kind: Pick<KindData, "baseIds" | "names" | "facets" | "fieldById" | "defaultValue">, clean: (s: string) => string, tileset?: string, category?: string) {
  const field = TILESET_FIELDS.map((f) => kind.fieldById.get(f)).find(Boolean);
  const fits = (id: string) => {
    if (!tileset || !field) return true;
    const list = (kind.defaultValue(id, field, 0) ?? "*").toUpperCase();
    return list.includes("*") || list.includes(tileset.toUpperCase());
  };
  const wanted = category?.toLowerCase();
  return kind.baseIds.filter(fits).map((id) => {
    const facets = kind.facets(id);
    return { id, name: clean(kind.names.get(id) ?? id), ...(facets.category ? { category: facets.category } : {}) };
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
