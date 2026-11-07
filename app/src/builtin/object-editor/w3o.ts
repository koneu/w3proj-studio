// .w3o: all object data in one file. The binary layout is the backend's (w3proj::w3o); this is what
// goes into it and what comes out: the same shapes the per-kind exports use, merged the way the
// Object Editor's Import merges, but for every kind at once and all or nothing.

import { copyOf, mergeObjects, type EditFile, type EditObject } from "./objectedit";

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

/** The parts to write for Export All Object Data: kinds with something in them, in file order. */
export function exportParts(files: Record<string, EditFile | null>, text: (value: string) => string | null): { kind: string; file: EditFile }[] {
  const out: { kind: string; file: EditFile }[] = [];
  for (const kind of W3O_KINDS) {
    const f = files[kind];
    if (!f) continue;
    const own = withOwnTexts(exportable(f), text);
    if (count(own)) out.push({ kind, file: own });
  }
  return out;
}

export interface ImportPlan {
  /** The merged file of each kind the .w3o holds. */
  writes: { kind: string; file: EditFile; added: number; replaced: number }[];
}

/** Merges a .w3o's kinds into the map's files. Throws, writing nothing, when a kind can't be merged:
 *  object data of another version than the map's (version 3 objects carry level sets older ones
 *  can't hold) is not converted. */
export function planImport(existing: Record<string, EditFile | null>, incoming: { kind: string; file: EditFile }[]): ImportPlan {
  const writes: ImportPlan["writes"] = [];
  for (const { kind, file: add } of incoming) {
    const have = existing[kind];
    let base: EditFile;
    if (!have || count(have) === 0) base = { format: add.format, version: add.version, original: [], custom: [] };
    else if (have.version !== add.version) {
      throw new Error(`The map's ${KIND_NAMES[kind] ?? kind} are object data version ${have.version}, the file's version ${add.version}. They can't be mixed; nothing was imported.`);
    } else base = structuredClone(have);
    const { added, replaced } = mergeObjects(base, add);
    writes.push({ kind, file: base, added, replaced });
  }
  return { writes };
}

export function describeImport(plan: ImportPlan): string {
  if (!plan.writes.length) return "The file holds no object data.";
  return plan.writes.map((w) => `${w.added + w.replaced} ${KIND_NAMES[w.kind] ?? w.kind}${w.replaced ? ` (${w.replaced} replaced)` : ""}`).join(", ");
}
