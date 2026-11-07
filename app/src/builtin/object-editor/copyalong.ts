// Copy and paste of objects between maps, with the objects they refer to (lib/objects/copydeps.ts has the
// rules). This reads and writes what the rules need: every kind's object data of the open map, and the
// game's metadata that says which fields hold ids.

import type { W3Api } from "../../extensions/api";
import type { McpEditsService } from "../../extensions/services";
import { MCP_EDITS_SERVICE } from "../../extensions/services";
import { loadKind, nextFreeId, type KindData } from "../../lib/objects/metadata";
import { planPaste, referencedBy, type Copied, type CopyObject, type CopySet, type HoldsIds, type PasteWorld, type Plan, type Policy } from "../../lib/objects/copydeps";
import { StringTable } from "../../lib/formats/wts";
import { jsonPathOf } from "../../lib/formats/mapdoc";
import { copyOf, kindsOf, writeInto, type EditFile, type EditObject } from "./objectedit";
import { OBJECT_CODE, OBJECT_LIST } from "./fields";
import { objectName } from "./objectinfo";
import { stripColors } from "./service";

export const ALL_EXTS = ["w3u", "w3t", "w3a", "w3h", "w3b", "w3d", "w3q"];

/** An open editor's objects of one kind, which may hold changes the file doesn't have yet. */
export interface Live { ext: string; file: { version: number; custom: CopyObject[] } }

/** What the open map has, for the rules. */
export interface MapView {
  /** The custom objects by id, with their texts as text (not references to the map's string table). */
  customs: Map<string, Copied>;
  holdsIds: HoldsIds;
  /** Ids of the game's own objects, of every kind. */
  game: Set<string>;
  versions: Map<string, number>;
  data: Map<string, KindData | null>;
  /** The name an object shows under, for lists. */
  name(c: Copied): string;
}

export async function viewMap(w3: W3Api, live?: Live): Promise<MapView> {
  const wts = await w3.workspace.readText("map/war3map.wts").catch(() => null);
  const table = wts === null ? null : new StringTable(wts);
  const text = (v: string) => {
    const n = table ? StringTable.ref(v) : null;
    return n !== null && table!.has(n) ? table!.get(n)! : null;
  };
  const customs = new Map<string, Copied>(), versions = new Map<string, number>(), data = new Map<string, KindData | null>();
  const game = new Set<string>();
  await Promise.all(ALL_EXTS.map(async (ext) => {
    data.set(ext, await loadKind(w3, ext).catch(() => null));
  }));
  for (const ext of ALL_EXTS) {
    for (const id of data.get(ext)?.baseIds ?? []) game.add(id);
    let file: { version?: number; custom?: CopyObject[] } | null = null;
    if (live?.ext === ext) file = live.file;
    else {
      const path = `map/war3map.${ext}.json`;
      const found = w3.workspace.files().some((f) => f.path.toLowerCase() === path);
      const read = found ? await w3.workspace.readText(path).catch(() => null) : null;
      try { file = read === null ? null : JSON.parse(read); } catch { file = null; }
    }
    versions.set(ext, file?.version ?? 3);
    for (const o of Array.isArray(file?.custom) ? file!.custom! : []) {
      if (typeof o?.id === "string" && !customs.has(o.id)) customs.set(o.id, { ext, object: copyOf(o as EditObject, text) });
    }
  }
  const holdsIds: HoldsIds = (ext, field) => {
    const type = data.get(ext)?.fieldById.get(field)?.type;
    return type !== undefined && (type in OBJECT_CODE || type in OBJECT_LIST);
  };
  const name = (c: Copied) => {
    const kd = data.get(c.ext);
    return kd ? stripColors(objectName(c.object, kd, (v) => text(v) ?? v)) : c.object.id ?? c.object.base;
  };
  return { customs, holdsIds, game, versions, data, name };
}

/** The custom objects of the open map that `chosen` refers to, with their texts as text. */
export async function gatherAlong(w3: W3Api, chosen: Copied[], live?: Live): Promise<Copied[]> {
  const view = await viewMap(w3, live);
  return referencedBy(chosen, view.customs, view.holdsIds);
}

/** The open map as the rules need to know it for a paste. */
function worldOf(view: MapView): PasteWorld {
  return {
    existing: (id) => view.customs.get(id),
    game: (id) => view.game.has(id),
    taken: new Set([...view.customs.keys(), ...view.game]),
    allocate: (ext, base, taken) => nextFreeId(ext, base, taken),
    holdsIds: view.holdsIds,
  };
}

const MOST = 6;
/** "Frost Armor (A001), Frost (B001) and 3 more". */
function listOf(view: MapView, items: { ext: string; object: CopyObject }[]): string {
  const shown = items.slice(0, MOST).map((c) => `${view.name(c)} (${c.object.id})`);
  return shown.join(", ") + (items.length > MOST ? ` and ${items.length - MOST} more` : "");
}

export interface Settled { plan: Plan; policy: Policy | "alone" }

/** Works out a paste into the open map and asks what the user wants when that's needed. Null when
 *  cancelled. `chosenAreNew`: see planPaste. */
export async function settle(w3: W3Api, set: CopySet, label: string, live?: Live, chosenAreNew = true): Promise<Settled | null> {
  const view = await viewMap(w3, live);
  const world = worldOf(view);
  const plan = planPaste(set, world, "keep", chosenAreNew);
  const brought = plan.items.filter((i) => i.fate === "add" || i.fate === "overwritten" || i.fate === "renamed");
  const reused = plan.items.filter((i) => i.fate === "same");
  if (!brought.length && !plan.conflicts.length) return { plan, policy: "keep" };
  const listing = (list: typeof brought) => listOf(view, list.map((i) => ({ ext: i.ext, object: i.object })));
  const note = reused.length ? ` · Already in this map, used as they are: ${listing(reused)}` : "";
  const items: { label: string; description?: string; detail: string; value: Policy | "alone" }[] = [];
  if (plan.conflicts.length) {
    const differ = `Different in this map: ${listOf(view, plan.conflicts.map((id) => view.customs.get(id)!))}`;
    const added = brought.filter((i) => i.fate === "add");
    const rest = added.length ? ` · Added as they are: ${listing(added)}` : "";
    items.push(
      { label: "Keep this map's versions", description: `${plan.conflicts.length} differ`, detail: `${differ}${rest}${note}`, value: "keep" },
      { label: "Overwrite them with the copied versions", detail: `${differ}${rest}${note}`, value: "overwrite" },
      { label: "Paste them under new ids", detail: `${differ}. Everything pasted that refers to them follows.${rest}${note}`, value: "new" },
    );
  } else {
    items.push({ label: `Paste with ${brought.length} object${brought.length === 1 ? "" : "s"} it refers to`, detail: `Comes along: ${listing(brought)}${note}`, value: "keep" });
  }
  items.push({ label: "Paste without the objects it refers to", detail: "Its fields keep naming objects this map may not have.", value: "alone" });
  const pick = await w3.window.quickPick(items, { placeholder: plan.conflicts.length ? `${label} refers to objects this map has with other content` : `${label} refers to objects this map lacks` });
  if (!pick?.value) return null;
  if (pick.value === "alone") return { plan: planPaste({ chosen: set.chosen, along: [] }, world, "keep", chosenAreNew), policy: "alone" };
  return { plan: planPaste(set, world, pick.value, chosenAreNew), policy: pick.value };
}

/** Writes a plan into the files of the map as one edit (one undo), whichever kinds it touches. */
export async function applyPlan(w3: W3Api, plan: Plan, title: string, emptyFile: () => Promise<EditFile>): Promise<boolean> {
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) {
    if (!(await w3.window.confirm(`Pasting this changes several object files, so unsaved changes in ${unsaved.length === 1 ? unsaved[0] : `${unsaved.length} files`} must be saved first.`, "Save and paste", 20_000))) return false;
    await w3.editors.saveAll();
  }
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
  return edits.edit(title, async (read) => {
    const out: { path: string; text: string }[] = [];
    for (const ext of kindsOf(plan)) {
      const path = jsonPathOf(w3, `war3map.${ext}`);
      const text = await read(path);
      const file: EditFile = text === null ? await emptyFile() : JSON.parse(text);
      writeInto(file, ext, plan);
      const tidy = { ...file, original: file.original.filter((o) => (o.sets ?? [{ mods: o.mods ?? [] }]).some((s) => s.mods.length)) };
      // Encodes it too: what can't be packed doesn't get written.
      out.push({ path, text: await w3.backend.invoke<string>("objects_canonicalize", { name: path, text: JSON.stringify(tidy) }) });
    }
    return out;
  });
}
