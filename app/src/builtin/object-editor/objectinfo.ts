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

/** The object's Editor Suffix (the field is found by its label, "Name - Editor Suffix" on units: unsf, ansf, fnsf …), colour codes stripped: its own
 *  value when it has one (even an empty one), else the game's. Empty when the kind has no such field. */
export function editorSuffix(o: MapObject, kind: Pick<KindData, "fields" | "defaultValue">, resolve: Resolve): string {
  const f = kind.fields.find((x) => /(^|- )Editor Suffix$/i.test(x.label));
  if (!f) return "";
  const own = modsOf(o).find((m) => m.field === f.id && typeof m.value === "string" && (!f.repeat || (m.level ?? 1) <= 1));
  if (own) return plain(resolve(own.value as string)).trim();
  const def = kind.defaultValue(o.base, f, f.repeat ? 1 : 0);
  return def ? plain(resolve(def)).trim() : "";
}

/** The list label: the name, a space and the suffix, as the World Editor's object lists show it for units and
 *  abilities alike ("Circle of Power (medium)", "Repair (Human)": we-drive 2026-11-18); the name alone without one. */
export function labelWithSuffix(name: string, suffix: string): string {
  return suffix ? `${name} ${suffix}` : name;
}

/** Where a kind says which tilesets an object is made for. */
const TILESET_FIELDS = ["btil", "dtil"];

const MODEL_FIELDS = ["umdl", "ifil", "bfil", "dfil"];
const SCALE_FIELDS = [["bmis", "bmas"], ["dmis", "dmas"]];
const PATH_FIELDS = ["bptx", "dptx", "upat"];
const VARIATION_FIELDS = ["bvar", "dvar"];

/** A model path as the stored files are looked up by: without a storage prefix (a table can name a file with its pack,
 *  "war3.w3mod:_de.w3mod:doodads\…\corpse2.mdx", the item clom), without the extension the tables write (".mdl", or the
 *  odd ".ma" of the dummy units oimd and oie1: the game reads the .mdx), backslashes, lower case. */
function modelKey(path: string): string {
  return path.slice(path.lastIndexOf(":") + 1).replace(/\//g, "\\").replace(/\.[^.\\]{1,3}$/, "").toLowerCase();
}

/** Stored model → the graphics packs it's only in; empty when the base game has it. */
export function modelPacks(all: readonly string[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const full of all) {
    if (!/\.mdx$/i.test(full)) continue;
    const key = modelKey(full);
    const set = out.get(key) ?? new Set<string>();
    const pack = /^War3\.w3mod:_(HD|DE|Teen)\b/i.exec(full)?.[1].toUpperCase();
    set.add(pack ?? "");
    out.set(key, set);
  }
  return new Map([...out].map(([k, v]) => [k, v.has("") ? [] : [...v].sort()]));
}

/** The packs a variation's model is in: its numbered file, else the type's file without a number, as the terrain view
 *  reads them (objects.ts modelPath, plainModelPath: the classic City wall endcap YSw5 has only CityWallEndcap.mdx,
 *  the numbered files are Reforged's). In the base game when either is. */
function variationPacks(stored: ReadonlyMap<string, string[]>, key: string, i: number): string[] | undefined {
  const own = stored.get(`${key}${i}`), plain = stored.get(key);
  if (!own || !plain) return own ?? plain;
  return own.length && plain.length ? [...new Set([...own, ...plain])] : [];
}

/** What a model means for an object: nothing to report, or that it won't show everywhere. Types
 *  with variations have a file for each, and a placed one uses just its own, so each counts. */
function modelNote(path: string | undefined, variations: number, stored: ReadonlyMap<string, string[]>): { noModel?: boolean; modelOnlyIn?: string[]; variationsWithoutModel?: number[] } {
  const key = modelKey(path ?? "");
  if (!key || key === "_") return { noModel: true };
  const files = variations > 1 ? Array.from({ length: variations }, (_, i) => variationPacks(stored, key, i)) : [stored.get(key) ?? stored.get(`${key}0`)];
  if (files.every((f) => !f)) return { noModel: true };
  const missing = files.flatMap((f, i) => (f ? [] : [i]));
  const packs = [...new Set(files.flatMap((f) => f ?? []))].sort();
  return { ...(packs.length ? { modelOnlyIn: packs } : {}), ...(missing.length ? { variationsWithoutModel: missing } : {}) };
}

/** The game's objects of a kind, with what sets them apart. `tileset`: its letter; objects for
 *  all tilesets have "*". `stored`: from modelPacks, to check models. */
export function gameObjectList(kind: Pick<KindData, "baseIds" | "names" | "facets" | "fieldById" | "defaultValue"> & Partial<Pick<KindData, "fields" | "westring">>, clean: (s: string) => string, tileset?: string, category?: string, stored?: ReadonlyMap<string, string[]>, treesOnly = false) {
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
    const suffix = kind.fields ? editorSuffix({ base: id }, { fields: kind.fields, defaultValue: kind.defaultValue }, (v) => kind.westring?.(v) ?? v) : "";
    return {
      id, name: clean(kind.names.get(id) ?? id), ...(suffix ? { suffix } : {}), ...(facets.category ? { category: facets.category } : {}),
      ...(stored && model ? modelNote(value(id, model), Number(variation && value(id, variation)) || 1, stored) : {}),
      ...(low && high ? { sizeRange: [low, high] } : {}),
      // Not known isn't the same as none.
      ...(path ? { takesRoom: path !== "_" && path.toLowerCase() !== "none" } : {}),
      ...(isTree(id) ? { tree: true } : {}),
    };
  }).filter((o) => !wanted || o.category?.toLowerCase().includes(wanted));
}

/** One line per object the map adds or changes. */
export function mapObjectList(file: MapObjects, kind: Kind & Partial<Pick<KindData, "fields" | "defaultValue">>, resolve: Resolve) {
  // The Editor Suffix: a changed game object's falls back to the game's; a custom one's own only (its base's would mislead).
  const suffixOf = (o: MapObject, custom: boolean) => {
    if (!kind.fields || !kind.defaultValue) return "";
    return editorSuffix(o, { fields: kind.fields, defaultValue: custom ? () => undefined : kind.defaultValue }, resolve);
  };
  const line = (o: MapObject, custom: boolean) => {
    const suffix = suffixOf(o, custom);
    return {
      id: o.id ?? o.base, ...(custom ? { base: o.base } : {}), name: objectName(o, kind, resolve), ...(suffix ? { suffix } : {}), custom, changes: modsOf(o).length,
    };
  };
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
