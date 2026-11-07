// What the "Graphics modes" fixes write, worked out before anything is written: object data edits,
// the import list, the folder a converted model goes to, and the queue that keeps two fixes from
// reading and writing the same file at once. Pure, so tests can stand in for the app.

type Mod = { field: string; type: string; level?: number; data?: number; value: number | string };
type O = { base: string; id?: string; end?: string; mods?: Mod[] };
export interface ObjDoc { format?: string; version: number; original: O[]; custom: O[] }

/** Model and variation count fields of a kind's object data. */
export interface ModelFields { model: string; variations?: string }

/** The value to write into a type's model field. The game's own data names item models with
 *  ".mdl" (Objects\InventoryItems\x\x.mdl) and units, doodads and destructables without an extension. */
export const modelFieldValue = (kind: string, stem: string): string => {
  const bare = stem.replace(/\.(mdl|mdx)$/i, "");
  return kind === "w3t" ? `${bare}.mdl` : bare;
};

const parseDoc = (text: string, what: string): ObjDoc => {
  try {
    const doc = JSON.parse(text) as ObjDoc;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.original) || !Array.isArray(doc.custom)) throw new Error("not object data");
    return doc;
  } catch (e) {
    throw new Error(`${what} can't be read (${(e as Error).message}), so the model was not changed.`);
  }
};

const entryOf = (doc: ObjDoc, base: string, id: string): O | undefined =>
  id !== base ? doc.custom.find((x) => x.id === id) : doc.original.find((x) => x.base === id);

/** The edit of a type's model: `main` is the text of war3map.<kind>.json (null: there is none), `skin`
 *  that of war3mapSkin.<kind>.json. Nothing but the one type changes. A standard type becomes a modified
 *  "original" entry, a custom type keeps its own entry; the skin file's entry for the type is changed
 *  only where it sets the model field itself (it would win over the main file). `mainRaw`: the project
 *  keeps the file as raw bytes, which can't be edited here. Throws before anything is written. */
export function planModelEdit(input: {
  kind: string; base: string; id: string; model: string; variations: number; fields: ModelFields;
  main: string | null; mainRaw: boolean; skin: string | null;
}): { main: ObjDoc; skin: ObjDoc | null } {
  const { kind, base, id, model, variations, fields } = input;
  if (input.main === null && input.mainRaw) throw new Error(`war3map.${kind} is kept raw in this project; set the model in the Object Editor.`);
  const doc = input.main === null ? { format: "w3proj.objects/1", version: 3, original: [], custom: [] } as ObjDoc : parseDoc(input.main, `map/war3map.${kind}.json`);
  const levels = ["w3d", "w3a", "w3q"].includes(kind);
  const set = (o: O, field: string, type: string, value: number | string) => {
    o.mods = (o.mods ?? []).filter((m) => m.field !== field);
    o.mods.push(levels ? { field, type, level: 0, data: 0, value } : { field, type, value });
  };
  let o = entryOf(doc, base, id);
  if (!o) {
    o = doc.version >= 3 ? { base: id, mods: [] } : { base: id, end: id, mods: [] };
    if (id !== base) throw new Error(`${id} is not in war3map.${kind}.json, so its model was not changed.`);
    doc.original.push(o);
  }
  set(o, fields.model, "string", model);
  if (fields.variations) set(o, fields.variations, "int", variations);

  let skin: ObjDoc | null = null;
  if (input.skin !== null) {
    const sdoc = parseDoc(input.skin, `map/war3mapSkin.${kind}.json`);
    const so = entryOf(sdoc, base, id);
    const setsModel = so?.mods?.some((m) => m.field === fields.model);
    const setsVariations = !!fields.variations && !!so?.mods?.some((m) => m.field === fields.variations);
    // Either field in the skin file would win over the main file's.
    if (so && (setsModel || setsVariations)) {
      if (setsModel) set(so, fields.model, "string", model);
      if (setsVariations) set(so, fields.variations!, "int", variations);
      skin = sdoc;
    }
  }
  return { main: doc, skin };
}

/** The import list with `names` added (flag 21 as the Import Manager writes new entries). `json`: the
 *  project's JSON form, else `raw` is the decoded raw file; with neither, a new list. */
export function planImports(json: string | null, raw: string | null, names: string[]) {
  type Imports = { format?: string; version: number; files: { flags: number; path: string }[] };
  let doc: Imports;
  try { doc = JSON.parse(json ?? raw ?? '{"format":"w3proj.imports/1","version":1,"files":[]}'); } catch (e) {
    throw new Error(`war3map.imp can't be read (${(e as Error).message}), so nothing was changed.`);
  }
  if (!Array.isArray(doc?.files)) throw new Error("war3map.imp can't be read (no file list), so nothing was changed.");
  const have = new Set(doc.files.map((f) => f.path.toLowerCase()));
  for (const n of names) if (!have.has(n.toLowerCase())) { doc.files.push({ flags: 21, path: n }); have.add(n.toLowerCase()); }
  return { doc, asRaw: json === null && raw !== null };
}

/** The folder a converted model goes to: war3mapImported\Classic\<name>, else <name>_2, <name>_3… so
 *  models with one file name (Doodads\A\Tree, Doodads\B\Tree) and a user's own imports are never
 *  overwritten. A folder is taken when none of the files it would get is in the map with other
 *  content (the same content: the same conversion again, which changes nothing). `build(dir)` makes
 *  the files (archive name → bytes); `existing(name)` reads the map's file of that name, or null. */
export async function chooseFolder(
  name: string, build: (dir: string) => Promise<Map<string, Uint8Array>>, existing: (archive: string) => Promise<Uint8Array | null>,
): Promise<{ dir: string; files: Map<string, Uint8Array> }> {
  for (let n = 1; n < 100; n++) {
    const dir = `war3mapImported\\Classic\\${name}${n > 1 ? `_${n}` : ""}`;
    const files = await build(dir);
    let clash = false;
    for (const [archive, bytes] of files) {
      const there = await existing(archive);
      if (there && !(there.length === bytes.length && there.every((b, i) => b === bytes[i]))) { clash = true; break; }
    }
    if (!clash) return { dir, files };
  }
  throw new Error(`no free folder for ${name} in war3mapImported\\Classic`);
}

/** Runs the tasks one after the other: two fixes reading and writing war3map.imp and the object data
 *  at the same time would lose each other's entries. A failing task doesn't stop the next one. */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

/** A field's value per object id over several object files (main, then skin, campaign…): later files
 *  win per field, as the game merges them. */
type Loose = { base: string; id?: string; mods?: { field: string; value: number | string }[] };
export function mergedValues(docs: ({ original?: Loose[]; custom?: Loose[] } | null)[], field: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of docs) {
    for (const o of [...(d?.original ?? []), ...(d?.custom ?? [])]) {
      const m = (o.mods ?? []).find((x) => x.field === field);
      if (m) out.set(o.id ?? o.base, String(m.value));
    }
  }
  return out;
}

/** Whether the model an object names exists. A type with several variations names its model without
 *  the number: the files are X0.mdx, X1.mdx… and every one of them has to be there. A model file
 *  named as written (X.mdx) counts too, as the game's own Classic models are. These are the files
 *  modelExists may look at, in its order (so they can be looked up together beforehand). */
export const modelNames = (path: string, variations: number): string[] => {
  if (variations <= 1) return [path];
  const stem = path.replace(/\.(mdl|mdx)$/i, "");
  return [path, ...Array.from({ length: variations }, (_, i) => `${stem}${i}.mdx`)];
};

/** Whether the model exists (see modelNames). */
export async function modelExists(path: string, variations: number, exists: (p: string) => Promise<boolean>): Promise<boolean> {
  if (await exists(path)) return true;
  if (variations <= 1) return false;
  const stem = path.replace(/\.(mdl|mdx)$/i, "");
  for (let i = 0; i < variations; i++) if (!(await exists(`${stem}${i}.mdx`))) return false;
  return true;
}

/** Whether a texture (the game paths it may have, lowercase) has to be imported with a Reforged model:
 *  not when the map has it itself (the user's own import counts as present), and only when some mode
 *  the fix is for (`lacking`: _hd / _de) has neither the Classic nor its own copy. */
export function textureLacking(
  candidates: string[], inMap: (p: string) => boolean, lacking: string[], stored: (layer: string | null, key: string) => boolean,
): boolean {
  if (candidates.some(inMap)) return false;
  return lacking.some((l) => !candidates.some((c) => stored(null, c.toLowerCase()) || stored(l, c.toLowerCase())));
}
