// .w3o: all object data in one file. The binary layout is the backend's (w3proj::w3o); this is what
// goes into it and what comes out: the same shapes the per-kind exports use, merged the way the
// Object Editor's Import merges, but for every kind at once and all or nothing.

import { copyOf, mergeObjects, type EditFile, type EditMod, type EditObject } from "./objectedit";

/** The kinds in the order of the Object Editor's tabs (and of a .w3o). */
export const W3O_KINDS = ["w3u", "w3t", "w3b", "w3d", "w3a", "w3h", "w3q"] as const;
export const KIND_NAMES: Record<string, string> = {
  w3u: "units", w3t: "items", w3b: "destructables", w3d: "doodads", w3a: "abilities", w3h: "buffs", w3q: "upgrades",
};

const hasMods = (o: EditObject) => (o.sets ?? [{ mods: o.mods ?? [] }]).some((s) => s.mods.length > 0);

/** What a file holds that is worth exporting: its custom objects and the game objects it changes. */
export function exportable(file: EditFile): EditFile {
  return { ...file, custom: file.custom, original: file.original.filter(hasMods) };
}

/** A file's objects with their own texts (references to this map's string table mean nothing elsewhere). */
export function withOwnTexts(file: EditFile, text: (value: string) => string | null): EditFile {
  return { ...file, custom: file.custom.map((o) => copyOf(o, text)), original: file.original.map((o) => copyOf(o, text)) };
}

/** Of a file, only the given objects (custom ones by id, changed game objects by base id). */
export function onlyObjects(file: EditFile, objects: Iterable<EditObject>): EditFile {
  const chosen = new Set(objects);
  return { ...file, custom: file.custom.filter((o) => chosen.has(o)), original: file.original.filter((o) => chosen.has(o)) };
}

const count = (f: EditFile) => f.custom.length + f.original.length;

const modKey = (m: EditMod) => `${m.field}/${m.level ?? 0}/${m.data ?? 0}`;

/** A copy of `main` with the fields of the Skin file (war3mapSkin.w3?) put into the objects they belong
 *  to: Reforged maps keep names, models, art and tooltips there. Where both have a value for a field
 *  (same level and data), main's stays. `addSkinOnly`: objects only the Skin file has are added too.
 *  Where Reforged's editor itself puts these fields in a .w3o is not verified. */
export function mergeSkin(main: EditFile, skin: EditFile | null, opts: { addSkinOnly: boolean }): EditFile {
  const out = structuredClone(main);
  if (!skin) return out;
  const fold = (target: EditObject[], from: EditObject[], same: (a: EditObject, b: EditObject) => boolean) => {
    for (const s of from) {
      const sets = s.sets ?? [{ flag: 0, mods: s.mods ?? [] }];
      const t = target.find((x) => same(x, s));
      if (!t) {
        if (opts.addSkinOnly && sets.some((x) => x.mods.length)) target.push(structuredClone(s));
        continue;
      }
      // Several flagged sets in the Skin object stay sets, also where the main object has none yet.
      if (s.sets && s.sets.length > 1 && !t.sets?.length) { t.sets = [{ flag: 0, mods: t.mods ?? [] }]; delete t.mods; }
      for (const set of sets) {
        let dest = t.sets?.length ? t.sets.find((x) => x.flag === set.flag) ?? null : null;
        if (t.sets?.length && !dest) {
          if (s.sets) t.sets.push(dest = { flag: set.flag, mods: [] }); else dest = t.sets[0];
        }
        const list = dest ? dest.mods : (t.mods ??= []);
        const taken = new Set(list.map(modKey));
        for (const m of set.mods) {
          if (taken.has(modKey(m))) continue;
          const copy = structuredClone(m);
          // An object's own end token is the default of its mods; the Skin object's may differ.
          if (copy.end === undefined && s.end !== undefined && s.end !== t.end) copy.end = s.end;
          list.push(copy);
        }
      }
    }
  };
  fold(out.custom, skin.custom ?? [], (a, b) => a.id === b.id);
  fold(out.original, skin.original ?? [], (a, b) => a.base === b.base);
  return out;
}

/** The parts to write for Export All Object Data: kinds with something in them, in file order. `skins`:
 *  each kind's Skin file, whose fields are merged into the objects. */
export function exportParts(files: Record<string, EditFile | null>, text: (value: string) => string | null, skins: Record<string, EditFile | null> = {}): { kind: string; file: EditFile }[] {
  const out: { kind: string; file: EditFile }[] = [];
  for (const kind of W3O_KINDS) {
    const f = files[kind];
    if (!f && !skins[kind]) continue;
    const own = withOwnTexts(exportable(mergeSkin(f ?? { format: "w3proj.objects/1", version: skins[kind]!.version, original: [], custom: [] }, skins[kind] ?? null, { addSkinOnly: true })), text);
    if (count(own)) out.push({ kind, file: own });
  }
  return out;
}

export interface ImportPlan {
  /** The merged file of each kind the .w3o holds. */
  writes: { kind: string; file: EditFile; added: number; replaced: number }[];
  /** Imported objects that take the id of a different map object (another base): that one is replaced. */
  conflicts: { kind: string; id: string; had: string; has: string }[];
  /** Each kind's Skin file with the fields the import sets taken out of the objects it replaces or adds
   *  (else the old values stay and probably win), only for kinds where that changes something. */
  skins: { kind: string; file: EditFile; dropped: number }[];
  /** Kinds whose objects were converted to the map's object data version first. */
  conversions: ({ kind: string } & Conversion)[];
}

/** A Skin file without the fields `incoming` sets, for the objects it holds (custom by id, game objects
 *  by base). `dropped` counts the fields taken out. */
export function pruneSkin(skin: EditFile, incoming: Pick<EditFile, "original" | "custom">): { file: EditFile; dropped: number } {
  const file = structuredClone(skin);
  let dropped = 0;
  const prune = (list: EditObject[], from: EditObject[], same: (a: EditObject, b: EditObject) => boolean) => {
    for (const add of from) {
      const keys = new Set((add.sets ?? [{ flag: 0, mods: add.mods ?? [] }]).flatMap((x) => x.mods.map(modKey)));
      const old = list.find((x) => same(x, add));
      if (!old) continue;
      for (const set of old.sets ?? [{ flag: 0, mods: (old.mods ??= []) }]) {
        const keep = set.mods.filter((m) => !keys.has(modKey(m)));
        dropped += set.mods.length - keep.length;
        set.mods.splice(0, set.mods.length, ...keep);
      }
    }
  };
  prune(file.custom, incoming.custom ?? [], (a, b) => a.id === b.id);
  prune(file.original, incoming.original ?? [], (a, b) => a.base === b.base);
  return { file, dropped };
}

/** What converting object data to another version left out (see convertVersion). */
export interface Conversion { from: number; to: number; /** Fields of flagged sets dropped. */ dropped: number; /** Objects that lost some. */ objects: string[] }

/** Object data in another version of the codec's (1–3, crates/w3proj/src/objdata.rs). Versions 1 and 2 have the same
 *  layout; version 3 gives every object a list of flagged sets of fields, which the binary file writes even for one
 *  set of flag 0 (the JSON then keeps plain `mods`). Up to 3 nothing is lost. Down from 3 an object keeps the fields
 *  of its flag-0 set; those of other sets can't be held and are counted in `dropped`. Objects of a version-1 or -2
 *  file repeat their id as the end token after every field (the game's own files do), so one without is given it. */
export function convertVersion(file: EditFile, to: number): { file: EditFile; conversion: Conversion | null } {
  if (file.version === to) return { file, conversion: null };
  if (!Number.isInteger(to) || to < 1 || to > 3) throw new Error(`Object data version ${to} isn't one this app knows (1 to 3).`);
  if (!Number.isInteger(file.version) || file.version < 1 || file.version > 3) throw new Error(`Object data version ${file.version} isn't one this app knows (1 to 3).`);
  const out = structuredClone(file);
  out.version = to;
  const conversion: Conversion = { from: file.version, to, dropped: 0, objects: [] };
  if (to < 3) {
    for (const o of [...out.custom, ...out.original]) {
      if (o.sets) {
        const kept = o.sets.find((s) => s.flag === 0);
        const lost = o.sets.reduce((n, s) => n + (s === kept ? 0 : s.mods.length), 0);
        if (lost) { conversion.dropped += lost; conversion.objects.push(o.id ?? o.base); }
        o.mods = kept ? kept.mods : [];
        delete o.sets;
      }
      o.end ??= o.id ?? o.base;
    }
  }
  return { file: out, conversion };
}

/** What the question says about a conversion: the versions, and the fields that couldn't be carried. */
export function describeConversion(kind: string, c: Conversion): string {
  const what = KIND_NAMES[kind] ?? kind;
  const lost = c.dropped
    ? ` ${c.dropped} field${c.dropped === 1 ? "" : "s"} of flagged sets (Reforged's) can't be held in version ${c.to} and ${c.dropped === 1 ? "is" : "are"} left out: ${c.objects.slice(0, 6).join(", ")}${c.objects.length > 6 ? ` and ${c.objects.length - 6} more` : ""}.`
    : "";
  return ` The file's ${what} are object data version ${c.from}, converted to the map's version ${c.to}.${lost}`;
}

/** Merges a .w3o's kinds into the map's files. Object data of another version than the map's is converted to the
 *  map's first (convertVersion), what can't be carried listed in `conversions`. */
export function planImport(existing: Record<string, EditFile | null>, incoming: { kind: string; file: EditFile }[], skins: Record<string, EditFile | null> = {}): ImportPlan {
  const writes: ImportPlan["writes"] = [];
  const conflicts: ImportPlan["conflicts"] = [];
  const skinWrites: ImportPlan["skins"] = [];
  const conversions: ImportPlan["conversions"] = [];
  for (const { kind, file: given } of incoming) {
    const have = existing[kind];
    let base: EditFile, add = given;
    if (!have || count(have) === 0) base = { format: add.format, version: add.version, original: [], custom: [] };
    else {
      const converted = convertVersion(given, have.version);
      add = converted.file;
      if (converted.conversion) conversions.push({ kind, ...converted.conversion });
      base = structuredClone(have);
    }
    for (const o of add.custom ?? []) {
      const old = base.custom.find((x) => x.id === o.id);
      if (old && old.base !== o.base) conflicts.push({ kind, id: o.id ?? "", had: old.base, has: o.base });
    }
    const { added, replaced } = mergeObjects(base, add);
    writes.push({ kind, file: base, added, replaced });
    const skin = skins[kind];
    if (skin) {
      const pruned = pruneSkin(skin, add);
      if (pruned.dropped) skinWrites.push({ kind, ...pruned });
    }
  }
  return { writes, conflicts, skins: skinWrites, conversions };
}

export function describeImport(plan: ImportPlan): string {
  if (!plan.writes.length) return "The file holds no object data.";
  return plan.writes.map((w) => `${w.added + w.replaced} ${KIND_NAMES[w.kind] ?? w.kind}${w.replaced ? ` (${w.replaced} replaced)` : ""}`).join(", ");
}

/** What the question says about objects that take another object's id. */
export function describeConflicts(plan: ImportPlan): string {
  if (!plan.conflicts.length) return "";
  const shown = plan.conflicts.slice(0, 6).map((c) => `${c.id} (${c.had} becomes ${c.has})`).join(", ");
  return ` These ids are already used by objects of another base and are replaced by unrelated ones: ${shown}${plan.conflicts.length > 6 ? ` and ${plan.conflicts.length - 6} more` : ""}.`;
}

/** What the question says about Skin fields that are taken out. */
export function describeSkin(plan: ImportPlan): string {
  if (!plan.skins.length) return "";
  return ` ${plan.skins.map((k) => `${k.dropped} field${k.dropped === 1 ? "" : "s"} of war3mapSkin.${k.kind}`).join(", ")} that the import sets are dropped from the Skin file, so the old values don't override the new ones.`;
}
