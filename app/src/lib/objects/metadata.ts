// Object editor knowledge from the game's own data: which fields exist for
// which objects, their labels and types, base objects, their names and the
// default (inherited) value of every field.

import type { W3Api } from "../../extensions/api";
import { listItem, parseIni, parseIniRaw, parseSlk, unquote, westring } from "../formats/text";

export type ValueType = "int" | "real" | "unreal" | "string";

/** "forceDisplayHP" → "Force Display HP". */
function humanize(name: string): string {
  return name
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/** The World Editor label, or — for newer fields whose WESTRING the game
 *  doesn't ship — the readable column name. */
function fieldLabel(we: Map<string, string>, r: Record<string, string>): string {
  const label = westring(we, r.displayName ?? r.field ?? r.ID);
  return label.startsWith("WESTRING_") ? humanize(r.field ?? r.ID) : label;
}

/** Enum/flag metadata types that the binary format stores as integers. */
const INT_TYPES = new Set(["int", "bool", "attackBits", "channelType", "deathType", "teamColor", "spellDetail", "detectionType", "defenseTypeInt"]);

export function valueTypeOf(metaType: string): ValueType {
  if (INT_TYPES.has(metaType) || metaType.endsWith("Flags")) return "int";
  return metaType === "real" ? "real" : metaType === "unreal" ? "unreal" : "string";
}

export interface FieldMeta {
  id: string;
  label: string;
  category: string;
  type: string;
  valueType: ValueType;
  /** Source table ("UnitBalance", "AbilityData", "Profile", …) and column/key. */
  slk: string;
  field: string;
  index: number;
  /** > 0: one value per level. */
  repeat: number;
  /** Ability "DataA…" column (1 = A) — also the mod's data pointer. */
  data: number;
  sort: string;
  use: Record<string, string>;
  useSpecific?: string[];
  notSpecific?: string[];
}

export interface FacetDef {
  id: string;
  label: string;
}

export interface KindData {
  kind: string;
  /** Attributes base objects can be filtered by (race, type, …). */
  facetDefs: FacetDef[];
  /** Facet id → display value for a base object. */
  facets(baseId: string): Record<string, string>;
  fields: FieldMeta[];
  fieldById: Map<string, FieldMeta>;
  /** Base object id → display name. */
  names: Map<string, string>;
  /** Lower-case English words for a base object from the game's tables, on any install: the shown
   *  names are in the install's language, so "footman" wouldn't find a German Fußsoldat. */
  searchText(baseId: string): string;
  /** Base object ids that exist in the game, in table order. */
  baseIds: string[];
  /** Level count of a base object (1 for kinds without levels). */
  levels(baseId: string): number;
  /** Fields that apply to a base object. */
  fieldsFor(baseId: string): FieldMeta[];
  /** Inherited value of a field (level is 1-based for repeating fields, else 0). */
  defaultValue(baseId: string, f: FieldMeta, level: number): string | undefined;
}

/** English words of table rows: their internal name and comment columns, which no locale changes.
 *  "HeroPaladin" gives "hero paladin" too. Strings to look up (WESTRING_…) aren't words. */
export function englishWords(rows: readonly Record<string, string>[]) {
  const words = new Set<string>();
  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) {
      if (!/^(name|comments?|comment\(s\))$/i.test(column) || !value || value.startsWith("WESTRING_")) continue;
      words.add(value.trim().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
    }
  }
  return [...words].join(" ");
}

/** Per object kind: metadata SLK and the data tables (SLK name → path, key column). */
const KINDS: Record<string, { meta: string; tables: Record<string, [string, string]>; main: string }> = {
  w3u: {
    meta: "Units\\UnitMetaData.slk",
    main: "UnitData",
    tables: {
      UnitData: ["Units\\UnitData.slk", "unitID"],
      UnitBalance: ["Units\\UnitBalance.slk", "unitBalanceID"],
      UnitUI: ["Units\\UnitUI.slk", "unitUIID"],
      UnitWeapons: ["Units\\UnitWeapons.slk", "unitWeaponID"],
      UnitAbilities: ["Units\\UnitAbilities.slk", "unitAbilID"],
    },
  },
  w3t: { meta: "Units\\UnitMetaData.slk", main: "ItemData", tables: { ItemData: ["Units\\ItemData.slk", "itemID"] } },
  w3a: { meta: "Units\\AbilityMetaData.slk", main: "AbilityData", tables: { AbilityData: ["Units\\AbilityData.slk", "alias"] } },
  w3h: { meta: "Units\\AbilityBuffMetaData.slk", main: "AbilityBuffData", tables: { AbilityBuffData: ["Units\\AbilityBuffData.slk", "alias"] } },
  w3b: { meta: "Units\\DestructableMetaData.slk", main: "DestructableData", tables: { DestructableData: ["Units\\DestructableData.slk", "DestructableID"] } },
  w3d: { meta: "Doodads\\DoodadMetaData.slk", main: "Doodads", tables: { Doodads: ["Doodads\\Doodads.slk", "doodID"] } },
  w3q: { meta: "Units\\UpgradeMetaData.slk", main: "UpgradeData", tables: { UpgradeData: ["Units\\UpgradeData.slk", "upgradeid"] } },
};

interface Shared {
  we: Map<string, string>;
  /** UI/WorldEditData.txt (category codes → labels). */
  editData: Map<string, Map<string, string>>;
  /** Merged INI "profile" data of every Units/Doodads *.txt, locale files last. */
  profile: Map<string, Map<string, string>>;
  names: Map<string, string>;
}

let shared: Promise<Shared> | null = null;
const cache = new Map<string, Promise<KindData>>();

function loadShared(w3: W3Api): Promise<Shared> {
  shared ??= (async () => {
    const we = new Map<string, string>();
    for (const file of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
      const ini = parseIni(await w3.game.readText(file).catch(() => ""));
      for (const section of ini.values()) for (const [k, v] of section) we.set(k.toUpperCase(), v);
    }
    // Base-layer and locale INI files under Units/ and Doodads/ hold the
    // "Profile" fields (names, tooltips, art, hotkeys, …).
    const files = (await w3.game.list()).filter((p) =>
      /^war3\.w3mod:(_locales\/[a-z]{4}\.w3mod:)?(units|doodads)\/[^/]*\.txt$/i.test(p));
    files.sort((a, b) => Number(a.includes("_Locales")) - Number(b.includes("_Locales")));
    const profile = new Map<string, Map<string, string>>();
    for (const f of files) {
      for (const [id, kv] of parseIniRaw(await w3.game.readText(f))) {
        const merged = profile.get(id) ?? new Map();
        for (const [k, v] of kv) merged.set(k, v);
        profile.set(id, merged);
      }
    }
    const editData = parseIni(await w3.game.readText("UI/WorldEditData.txt").catch(() => ""));
    const names = new Map<string, string>();
    for (const [id, kv] of profile) {
      const n = kv.get("name") ?? kv.get("bufftip") ?? kv.get("editorname");
      // Doodads and destructables name a string (Name=WESTRING_DOOD_APMS), which can be missing:
      // then the object's own table has something better than the key.
      const text = n ? westring(we, unquote(n)) : "";
      if (n && !text.startsWith("WESTRING_")) names.set(id, unquote(n).startsWith("WESTRING_") ? text : unquote(n));
    }
    return { we, editData, profile, names };
  })();
  shared.catch(() => { shared = null; });
  return shared;
}

export function loadKind(w3: W3Api, kind: string): Promise<KindData> {
  let p = cache.get(kind);
  if (!p) {
    p = buildKind(w3, kind);
    p.catch(() => cache.delete(kind));
    cache.set(kind, p);
  }
  return p;
}

async function buildKind(w3: W3Api, kind: string): Promise<KindData> {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`unknown object kind ${kind}`);
  const { we, editData, profile, names: sharedNames } = await loadShared(w3);

  const tables = new Map<string, Map<string, Record<string, string>>>();
  for (const [name, [path, key]] of Object.entries(spec.tables)) {
    const rows = new Map<string, Record<string, string>>();
    for (const r of parseSlk(await w3.game.readText(path))) if (r[key]) rows.set(r[key], r);
    tables.set(name, rows);
  }
  const main = tables.get(spec.main)!;

  const fields: FieldMeta[] = [];
  for (const r of parseSlk(await w3.game.readText(spec.meta))) {
    if (!r.ID) continue;
    if (kind === "w3t" && r.useItem !== "1") continue;
    if (kind === "w3u" && r.useUnit !== "1" && r.useHero !== "1" && r.useBuilding !== "1") continue;
    fields.push({
      id: r.ID,
      label: fieldLabel(we, r),
      category: westring(we, `WESTRING_OE_CAT_${(r.category ?? "").toUpperCase()}`).replace(/^WESTRING_OE_CAT_/, ""),
      type: r.type ?? "string",
      valueType: valueTypeOf(r.type ?? "string"),
      slk: r.slk ?? "",
      field: r.field ?? "",
      index: Number(r.index ?? -1),
      repeat: Number(r.repeat ?? 0),
      data: Number(r.data ?? 0),
      sort: r.sort ?? "",
      use: r,
      useSpecific: r.useSpecific ? r.useSpecific.split(",") : undefined,
      notSpecific: r.notSpecific ? r.notSpecific.split(",") : undefined,
    });
  }
  fields.sort((a, b) => a.sort.localeCompare(b.sort));
  const fieldById = new Map(fields.map((f) => [f.id, f]));

  const names = new Map(sharedNames);
  for (const [id, r] of main) {
    const n = r.Name ?? r.name;
    const text = n?.startsWith("WESTRING_") ? westring(we, n) : "";
    if (text && !text.startsWith("WESTRING_")) names.set(id, text);
    else if (!names.has(id) && (r.comment || n)) names.set(id, r.comment || n);
  }

  const isHero = (id: string) => kind === "w3u" && /^[A-Z]/.test(id);
  const isBuilding = (id: string) => tables.get("UnitBalance")?.get(id)?.isbldg === "1";

  const row = (table: string, id: string) => tables.get(table)?.get(id) ?? {};
  /** "D" → "Destructibles" via a [Section] of WorldEditData.txt (value: label,icon). */
  const category = (section: string, code: string | undefined) =>
    code ? westring(we, (editData.get(section)?.get(code.toLowerCase()) ?? code).split(",")[0]) : "—";
  const facetFns: Record<string, [FacetDef, (id: string) => string][]> = {
    w3u: [
      [{ id: "race", label: "Race" }, (id) => raceLabel(row("UnitData", id).race)],
      [{ id: "type", label: "Type" }, (id) => (isHero(id) ? "Hero" : isBuilding(id) ? "Building" : "Unit")],
      [{ id: "source", label: "Source" }, (id) => (row("UnitUI", id).campaign === "1" ? "Campaign" : "Melee")],
    ],
    w3t: [
      [{ id: "class", label: "Class" }, (id) => row("ItemData", id).class ?? "—"],
      [{ id: "level", label: "Level" }, (id) => `Level ${row("ItemData", id).Level ?? "?"}`],
    ],
    w3a: [
      [{ id: "race", label: "Race" }, (id) => raceLabel(row("AbilityData", id).race)],
      [{ id: "use", label: "Used by" }, (id) => (row("AbilityData", id).hero === "1" ? "Hero" : row("AbilityData", id).item === "1" ? "Item" : "Unit")],
    ],
    w3h: [
      [{ id: "race", label: "Race" }, (id) => raceLabel(row("AbilityBuffData", id).race)],
      [{ id: "kind", label: "Kind" }, (id) => (row("AbilityBuffData", id).isEffect === "1" ? "Effect" : "Buff")],
    ],
    w3b: [
      [{ id: "category", label: "Category" }, (id) => category("DestructibleCategories", row("DestructableData", id).category)],
      [{ id: "target", label: "Targeted as" }, (id) => row("DestructableData", id).targType ?? "—"],
    ],
    w3d: [[{ id: "category", label: "Category" }, (id) => category("DoodadCategories", row("Doodads", id).category)]],
    w3q: [[{ id: "race", label: "Race" }, (id) => raceLabel(row("UpgradeData", id).race)]],
  };
  const fns = facetFns[kind] ?? [];

  return {
    kind,
    facetDefs: fns.map(([d]) => d),
    facets: (id) => Object.fromEntries(fns.map(([d, fn]) => [d.id, fn(id)])),
    fields,
    fieldById,
    names,
    searchText: (id) => englishWords([...tables.values()].flatMap((t) => { const r = t.get(id); return r ? [r] : []; })),
    baseIds: [...main.keys()],
    levels(baseId) {
      if (kind === "w3a") return Math.max(1, Number(main.get(baseId)?.levels ?? 1));
      if (kind === "w3q") return Math.max(1, Number(main.get(baseId)?.maxlevel ?? 1));
      return 1;
    },
    fieldsFor(baseId) {
      return fields.filter((f) => {
        if (f.useSpecific && !f.useSpecific.includes(baseId)) return false;
        if (f.notSpecific?.includes(baseId)) return false;
        if (kind === "w3u") {
          const use = isHero(baseId) ? f.use.useHero : isBuilding(baseId) ? f.use.useBuilding : f.use.useUnit;
          return use === "1";
        }
        return true;
      });
    },
    defaultValue(baseId, f, level) {
      if (f.slk === "Profile") {
        // Reforged skin files split some fields per art set ("Art:sd", "Art:hd").
        const kv = profile.get(baseId), key = f.field.toLowerCase();
        const mode = w3.settings.get<string>("game.graphicsMode") ?? "hd";
        const raw = kv?.get(`${key}:${mode}`) ?? kv?.get(key) ?? kv?.get(`${key}:sd`);
        if (raw === undefined) return undefined;
        if (f.repeat > 0) return listItem(raw, Math.max(0, level - 1)) ?? undefined;
        return f.index > 0 ? listItem(raw, f.index) : unquote(raw);
      }
      const row = tables.get(f.slk)?.get(baseId);
      if (!row) return undefined;
      let col = f.field;
      if (f.data > 0) col += String.fromCharCode(64 + f.data);
      if (f.repeat > 0) col += String(level);
      const v = row[col];
      return v === undefined || v === "-" || v === "_" ? undefined : v;
    },
  };
}

const RACES: Record<string, string> = {
  human: "Human", orc: "Orc", undead: "Undead", nightelf: "Night Elf", naga: "Naga", demon: "Demon",
  creeps: "Creeps", critters: "Critters", commoner: "Commoner", other: "Neutral / Other", unknown: "Neutral / Other",
};
function raceLabel(race: string | undefined): string {
  return race ? (RACES[race.toLowerCase()] ?? race) : "Neutral / Other";
}

const ID_PREFIX: Record<string, string> = { w3t: "I", w3a: "A", w3h: "B", w3b: "B", w3d: "D", w3q: "R" };
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The World Editor's id scheme: unit ids keep the base's first letter
 *  ("hfoo" → "h000"), other kinds use a fixed prefix; then 000, 001 … ZZZ. */
export function nextFreeId(kind: string, baseId: string, taken: Set<string>): string {
  const prefix = kind === "w3u" ? baseId[0] : (ID_PREFIX[kind] ?? "X");
  for (let n = 0; n < 36 ** 3; n++) {
    const id = prefix + DIGITS[Math.floor(n / 1296)] + DIGITS[Math.floor(n / 36) % 36] + DIGITS[n % 36];
    if (!taken.has(id)) return id;
  }
  throw new Error("no free object ids left");
}
