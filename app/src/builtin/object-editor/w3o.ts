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
      for (const set of sets) {
        const dest = t.sets?.length ? t.sets.find((x) => x.flag === set.flag) ?? t.sets[0] : null;
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
}

/** Merges a .w3o's kinds into the map's files. Throws, writing nothing, when a kind can't be merged:
 *  object data of another version than the map's (version 3 objects carry level sets older ones
 *  can't hold) is not converted. */
export function planImport(existing: Record<string, EditFile | null>, incoming: { kind: string; file: EditFile }[]): ImportPlan {
  const writes: ImportPlan["writes"] = [];
  const conflicts: ImportPlan["conflicts"] = [];
  for (const { kind, file: add } of incoming) {
    const have = existing[kind];
    let base: EditFile;
    if (!have || count(have) === 0) base = { format: add.format, version: add.version, original: [], custom: [] };
    else if (have.version !== add.version) {
      throw new Error(`The map's ${KIND_NAMES[kind] ?? kind} are object data version ${have.version}, the file's version ${add.version}. They can't be mixed; nothing was imported.`);
    } else base = structuredClone(have);
    for (const o of add.custom ?? []) {
      const old = base.custom.find((x) => x.id === o.id);
      if (old && old.base !== o.base) conflicts.push({ kind, id: o.id ?? "", had: old.base, has: o.base });
    }
    const { added, replaced } = mergeObjects(base, add);
    writes.push({ kind, file: base, added, replaced });
  }
  return { writes, conflicts };
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
