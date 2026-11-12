// Export All Object Data, Export Object and Import Object Data: .w3o files, in the app.

import type { W3Api } from "../../extensions/api";
import { jsonPathOf, mapStrings, readMapDocStrict } from "../../lib/formats/mapdoc";
import { checkpointIfOn } from "../../lib/checkpoint";
import type { EditFile, EditObject } from "./objectedit";
import { describeConflicts, describeConversion, describeImport, describeSkin, exportParts, mergeSkin, KIND_NAMES, onlyObjects, planImport, W3O_KINDS, withOwnTexts } from "./w3o";

const WE_FILTER = [{ name: "Object data (.w3o)", extensions: ["w3o"] }];
const withExt = (p: string) => (/\.w3o$/i.test(p) ? p : `${p}.w3o`);

/** Texts of this map's string table: the value if it refers to one, else null. */
async function ownTexts(w3: W3Api): Promise<(value: string) => string | null> {
  const resolve = await mapStrings(w3);
  return (value) => { const own = resolve(value); return own === value ? null : own; };
}

/** Of the object data files, those with unsaved changes in an editor. */
const unsavedObjectFiles = (w3: W3Api) => w3.editors.unsavedPaths().filter((p) => /^map\/war3map(Skin)?\.w3[utbdahq]\.json$/i.test(p));

/** Writes every kind of the map's object data into one .w3o; the file's path, null when cancelled. */
export async function exportAllObjectData(w3: W3Api): Promise<string | null> {
  const project = w3.workspace.project();
  if (!project) throw new Error("Open or import a project first.");
  const open = unsavedObjectFiles(w3);
  if (open.length) throw new Error(`Save ${open.join(", ")} first: the export holds what is saved.`);
  // An object file that is there but can't be read stops the export instead of being left out.
  const files: Record<string, EditFile | null> = {}, skins: Record<string, EditFile | null> = {};
  for (const kind of W3O_KINDS) {
    files[kind] = await readMapDocStrict<EditFile>(w3, `map/war3map.${kind}.json`);
    skins[kind] = await readMapDocStrict<EditFile>(w3, `map/war3mapSkin.${kind}.json`);
  }
  const parts = exportParts(files, await ownTexts(w3), skins);
  if (!parts.length) throw new Error("This map has no object data of its own to export.");
  const target = await w3.window.pickSaveFile({ title: "Export All Object Data", defaultPath: `${project.name}.w3o`, filters: WE_FILTER });
  if (!target) return null;
  const path = withExt(target);
  await w3.backend.invoke("w3o_export", { parts: parts.map((p) => ({ kind: p.kind, text: JSON.stringify(p.file) })), path });
  const total = parts.reduce((n, p) => n + p.file.custom.length + p.file.original.length, 0);
  void w3.window.showInfo(`Exported ${total} object${total === 1 ? "" : "s"} (${parts.map((p) => KIND_NAMES[p.kind]).join(", ")}) to ${path}`);
  return path;
}

/** The chosen objects of one kind, as a .w3o of their own. `file` is the editor's file, `text` its string lookup.
 *  `skinMerged`: the objects hold their Skin file's fields already (the Object Editor's do). */
export async function exportObjects(w3: W3Api, kind: string, file: EditFile, objects: EditObject[], text: (value: string) => string | null, opts: { skinMerged?: boolean } = {}): Promise<string | null> {
  if (!objects.length) throw new Error("Select an object first.");
  // Their fields in the Skin file (names, models, art) go along; objects only the Skin file has are not chosen.
  const skin = opts.skinMerged ? null : await readMapDocStrict<EditFile>(w3, `map/war3mapSkin.${kind}.json`);
  const chosen = withOwnTexts(mergeSkin(onlyObjects(file, objects), skin, { addSkinOnly: false }), text);
  const single = objects.length === 1 ? (objects[0].id ?? objects[0].base) : `${objects.length} ${KIND_NAMES[kind] ?? kind}`;
  const target = await w3.window.pickSaveFile({ title: objects.length === 1 ? "Export Object" : "Export Objects", defaultPath: `${single}.w3o`, filters: WE_FILTER });
  if (!target) return null;
  const path = withExt(target);
  await w3.backend.invoke("w3o_export", { parts: [{ kind, text: JSON.stringify(chosen) }], path });
  void w3.window.showInfo(`Exported ${objects.length} object${objects.length === 1 ? "" : "s"} to ${path}`);
  return path;
}

/** Takes in a .w3o: every kind in it is merged into the map's, objects with the same id replace
 *  the map's; another object data version is converted to the map's, the question naming what
 *  can't be carried. Asks first, makes a checkpoint, and changes nothing if any kind can't be merged. */
export async function importObjectData(w3: W3Api): Promise<number> {
  if (!w3.workspace.project()) throw new Error("Open or import a project first.");
  const open = unsavedObjectFiles(w3);
  if (open.length) throw new Error(`Save or discard the changes of ${open.join(", ")} first: Import works on the saved files.`);
  const source = await w3.window.pickFile({ title: "Import Object Data", filters: WE_FILTER });
  if (!source) return 0;
  const parts = await w3.backend.invoke<{ kind: string; text: string }[]>("w3o_import", { path: source });
  const existing: Record<string, EditFile | null> = {}, skins: Record<string, EditFile | null> = {};
  const paths: Record<string, string> = {};
  for (const { kind } of parts) {
    paths[kind] = jsonPathOf(w3, `war3map.${kind}`);
    existing[kind] = await readMapDocStrict<EditFile>(w3, paths[kind]);
    // The Skin file too: a corrupt one refuses the import before anything is written.
    skins[kind] = await readMapDocStrict<EditFile>(w3, `map/war3mapSkin.${kind}.json`);
  }
  const plan = planImport(existing, parts.map((p) => ({ kind: p.kind, file: JSON.parse(p.text) as EditFile })), skins);
  if (!plan.writes.length) { void w3.window.showInfo(describeImport(plan)); return 0; }
  // Encoded before anything is written: what can't be packed isn't kept.
  const texts: { path: string; text: string }[] = [];
  for (const wr of plan.writes) {
    const path = paths[wr.kind];
    texts.push({ path, text: await w3.backend.invoke<string>("objects_canonicalize", { name: path, text: JSON.stringify(wr.file) }) });
  }
  for (const sk of plan.skins) {
    const path = jsonPathOf(w3, `war3mapSkin.${sk.kind}`);
    texts.push({ path, text: await w3.backend.invoke<string>("objects_canonicalize", { name: path, text: JSON.stringify(sk.file) }) });
  }
  const converted = plan.conversions.map((c) => describeConversion(c.kind, c)).join("");
  if (!(await w3.window.confirm(`Import ${describeImport(plan)}? Objects with the same id replace the map's.${converted}${describeConflicts(plan)}${describeSkin(plan)} A checkpoint is made first, to come back to, where they're enabled.`, "Import", 60_000))) return 0;
  await checkpointIfOn(w3, "Import Object Data");
  for (const t of texts) await w3.workspace.writeText(t.path, t.text);
  await w3.workspace.refresh();
  const total = plan.writes.reduce((n, w) => n + w.added + w.replaced, 0);
  void w3.window.showInfo(`Imported ${describeImport(plan)}.`);
  return total;
}
