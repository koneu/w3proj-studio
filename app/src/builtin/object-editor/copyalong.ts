// Copy and paste of objects between maps, with the objects they refer to (lib/objects/copydeps.ts has the
// rules). This reads and writes what the rules need: every kind's object data of the open map (its Skin
// files too, where Reforged maps keep names and art), and the game's metadata that says which fields hold ids.

import type { W3Api } from "../../extensions/api";
import type { McpEditsService } from "../../extensions/services";
import { MCP_EDITS_SERVICE } from "../../extensions/services";
import { loadKind, nextFreeId, type KindData } from "../../lib/objects/metadata";
import { planPaste, referencedBy, type Copied, type CopyObject, type CopySet, type HoldsIds, type PasteWorld, type Plan, type Policy } from "../../lib/objects/copydeps";
import { StringTable } from "../../lib/formats/wts";
import { jsonPathOf } from "../../lib/formats/mapdoc";
import { entryIds } from "../../lib/terrain/entryids";
import { idsUsedBy } from "../../lib/objects/refs";
import { assertPlanFits, copyOf, describeUse, rawOnlySkin, kindsOf, withoutSkinEntries, writeInto, type EditFile, type EditObject } from "./objectedit";
import { OBJECT_CODE, OBJECT_LIST } from "./fields";
import { objectName } from "./objectinfo";
import { stripColors } from "./service";
import { mergeSkin } from "./w3o";

export const ALL_EXTS = ["w3u", "w3t", "w3a", "w3h", "w3b", "w3d", "w3q"];
const LABELS: Record<string, string> = { w3u: "Unit", w3t: "Item", w3a: "Ability", w3h: "Buff", w3b: "Destructable", w3d: "Doodad", w3q: "Upgrade" };

/** An open editor's objects of one kind, which may hold changes the file doesn't have yet, and its
 *  string table's texts the same way. */
export interface Live {
  ext: string;
  file: { version: number; custom: CopyObject[]; original: CopyObject[] };
  text?: (value: string) => string | null;
}

/** What the open map has, for the rules. */
export interface MapView {
  /** The project it was read from. */
  root: string;
  /** The custom objects by id, Skin fields merged in, with their texts as text (not references to the
   *  map's string table). */
  customs: Map<string, Copied>;
  holdsIds: HoldsIds;
  /** Ids that belong to the game's own objects, of every kind, or to the campaign's. */
  game: Set<string>;
  versions: Map<string, number>;
  data: Map<string, KindData | null>;
  /** The map's objects of each kind (custom and changed standard ones), Skin fields merged in. */
  merged: Map<string, EditFile>;
  /** Kind of every id the map's files have (custom objects, Skin-only ones included) or reserve (game, campaign). */
  idKinds: Map<string, string>;
  /** The name an object shows under, for lists. */
  name(c: Copied): string;
}

/** The campaign project around a chapter map project (…/maps/<file>), or undefined. */
const campaignRoot = (root: string) => /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/.exec(root)?.[1];

/** A file of the project at `root` as its JSON, null if there is none. One that is there and can't be read
 *  throws, naming it: it must never pass for "empty". Read by its full path, so a project opened meanwhile
 *  (a copy is gathered while the user moves on to another map) isn't mistaken for this one. */
async function readDoc<T>(w3: W3Api, root: string, rel: string): Promise<T | null> {
  const abs = `${root}\\${rel.replace(/\//g, "\\")}`;
  if (await w3.backend.invoke<boolean>("fs_exists", { path: abs })) {
    try { return JSON.parse(await w3.workspace.readText(abs)) as T; } catch { throw new Error(`${rel} is there but can't be read.`); }
  }
  // Kept raw in the project: the codec reads it.
  if (await w3.backend.invoke<boolean>("fs_exists", { path: abs.replace(/\.json$/, "") })) {
    try { return JSON.parse(await w3.backend.invoke<string>("codec_decode", { root, path: rel.replace(/\.json$/, "") })) as T; } catch { throw new Error(`${rel.replace(/\.json$/, "")} is there but can't be read.`); }
  }
  return null;
}

const emptyFile = (version = 3): EditFile => ({ format: "w3proj.objects/1", version, original: [], custom: [] });

/** Reads the map as the rules need it. A kind's data the game can't give, or an object file that is there
 *  but can't be read, stops it with a message: either would pass for "nothing there" and paste over things. */
export async function viewMap(w3: W3Api, live?: Live, root = w3.workspace.project()?.root ?? ""): Promise<MapView> {
  // Missing means no string table; there but unreadable stops it: TRIGSTR references would cross unresolved.
  const wtsPath = `${root}\\map\\war3map.wts`;
  let wts: string | null = null;
  if (await w3.backend.invoke<boolean>("fs_exists", { path: wtsPath })) {
    try { wts = await w3.workspace.readText(wtsPath); } catch { throw new Error("map/war3map.wts is there but can't be read."); }
  }
  const table = wts === null ? null : new StringTable(wts);
  const text = live?.text ?? ((v: string) => {
    const n = table ? StringTable.ref(v) : null;
    return n !== null && table!.has(n) ? table!.get(n)! : null;
  });
  const customs = new Map<string, Copied>(), versions = new Map<string, number>(), data = new Map<string, KindData | null>();
  const merged = new Map<string, EditFile>(), idKinds = new Map<string, string>();
  const game = new Set<string>();
  const campaign = campaignRoot(root);
  for (const ext of ALL_EXTS) {
    try { data.set(ext, await loadKind(w3, ext)); } catch (e) {
      throw new Error(`The game's ${LABELS[ext].toLowerCase()} data couldn't be read (${(e as Error).message ?? e}), so it can't be told which fields hold object ids.`);
    }
  }
  for (const ext of ALL_EXTS) {
    for (const id of data.get(ext)!.baseIds) { game.add(id); idKinds.set(id, ext); }
    const main = live?.ext === ext ? (live.file as EditFile) : await readDoc<EditFile>(w3, root, `map/war3map.${ext}.json`);
    const skin = await readDoc<EditFile>(w3, root, `map/war3mapSkin.${ext}.json`);
    for (const f of [main, skin]) if (f && !Array.isArray(f.custom)) throw new Error(`The ${LABELS[ext].toLowerCase()} data of this map isn't in the shape the editor writes, so it can't be pasted into.`);
    const both = mergeSkin(main ?? emptyFile(skin?.version), skin, { addSkinOnly: true });
    versions.set(ext, main?.version ?? skin?.version ?? 3);
    merged.set(ext, both);
    for (const o of both.custom) {
      if (typeof o?.id !== "string") continue;
      idKinds.set(o.id, ext);
      if (!customs.has(o.id)) customs.set(o.id, { ext, object: copyOf(o, text) });
    }
    if (campaign) {
      const path = `${campaign}\\map\\war3campaign.${ext}.json`;
      if (await w3.backend.invoke<boolean>("fs_exists", { path }).catch(() => false)) {
        let c: EditFile;
        try { c = JSON.parse(await w3.workspace.readText(path)) as EditFile; } catch { throw new Error(`${path} is there but can't be read.`); }
        for (const o of Array.isArray(c.custom) ? c.custom : []) if (typeof o?.id === "string") { game.add(o.id); idKinds.set(o.id, ext); }
      }
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
  return { root, customs, holdsIds, game, versions, data, merged, idKinds, name };
}

/** The custom objects of the open map that `chosen` refers to, with their texts as text. Throws, saying
 *  why, when that can't be told. */
export async function gatherAlong(w3: W3Api, chosen: Copied[], live?: Live, root?: string): Promise<Copied[]> {
  const view = await viewMap(w3, live, root);
  return referencedBy(chosen, view.customs, view.holdsIds);
}

/** What a copy holds: the objects with the fields their Skin file has for them (names, art and models are
 *  there in Reforged maps), and what they refer to. Throws, saying why, when the map can't be read. */
export async function prepareCopy(w3: W3Api, ext: string, objects: CopyObject[], live: Live, root = w3.workspace.project()?.root ?? ""): Promise<{ objects: CopyObject[]; along: Copied[] }> {
  const skin = await readDoc<EditFile>(w3, root, `map/war3mapSkin.${ext}.json`);
  const withSkin = objects.map((o) => {
    const one = { ...emptyFile(live.file.version), ...(o.id ? { custom: [o as EditObject] } : { original: [o as EditObject] }) };
    const m = mergeSkin(one, skin, { addSkinOnly: false });
    return (o.id ? m.custom[0] : m.original[0]) as CopyObject;
  });
  const along = await gatherAlong(w3, withSkin.map((object) => ({ ext, object })), live, root);
  return { objects: withSkin, along };
}

/** The open map as the rules need to know it for a paste. */
function worldOf(view: MapView): PasteWorld {
  return {
    existing: (id) => view.customs.get(id),
    game: (id) => view.game.has(id),
    taken: new Set(view.idKinds.keys()),
    allocate: (ext, base, taken) => nextFreeId(ext, base, taken),
    holdsIds: view.holdsIds,
  };
}

const OBJECT_FILE = /^map\/war3map(Skin)?\.w3[utbdahq]\.json$/i;

/** Object data with unsaved changes in an editor other than `own` can't be seen by the plan, and the write
 *  would meet it later: asks for it to be saved first. False if the user declines. */
export async function settleEditors(w3: W3Api, own?: string): Promise<boolean> {
  const open = w3.editors.unsavedPaths().filter((p) => OBJECT_FILE.test(p) && p.toLowerCase() !== own?.toLowerCase());
  if (!open.length) return true;
  if (!(await w3.window.confirm(`Pasting looks at all the object data, so the unsaved changes in ${open.join(", ")} must be saved first.`, "Save and paste", 20_000))) return false;
  await w3.editors.saveAll();
  return true;
}

const MOST = 6;
/** "Frost Armor (A001), Frost (B001) and 3 more". */
function listOf(view: MapView, items: { ext: string; object: CopyObject }[]): string {
  const shown = items.slice(0, MOST).map((c) => `${view.name(c)} (${c.object.id})`);
  return shown.join(", ") + (items.length > MOST ? ` and ${items.length - MOST} more` : "");
}

/** How many objects of the map and placed objects use each of `ids`. */
export async function usageOf(w3: W3Api, view: MapView, ids: string[]): Promise<Map<string, { objects: number; placed: number | null }>> {
  const want = new Set(ids);
  const users = new Map<string, number>();
  for (const f of view.merged.values()) for (const o of [...f.custom, ...f.original]) for (const id of idsUsedBy(o, want)) users.set(id, (users.get(id) ?? 0) + 1);
  const placed = new Map<string, number>();
  let unknown = false;
  for (const [path, key] of [["map/war3mapUnits.doo.json", "units"], ["map/war3map.doo.json", "doodads"]] as const) {
    const doc = await readDoc<Record<string, unknown>>(w3, view.root, path).catch(() => { unknown = true; return null; });
    for (const e of Array.isArray(doc?.[key]) ? (doc![key] as Record<string, unknown>[]) : []) {
      for (const id of entryIds(e)) if (want.has(id)) placed.set(id, (placed.get(id) ?? 0) + 1);
    }
  }
  return new Map(ids.map((id) => [id, { objects: users.get(id) ?? 0, placed: unknown ? null : placed.get(id) ?? 0 }]));
}

export interface Settled { plan: Plan; policy: Policy | "alone" }

/** Works out a paste into the open map and asks what the user wants when that's needed. Null when
 *  cancelled. `chosenAreNew`: see planPaste. `stillHere` tells whether the editor the paste started in is
 *  still there: after the questions, a paste into another project or a closed editor is refused. */
export async function settle(w3: W3Api, set: CopySet, label: string, live?: Live, chosenAreNew = true, stillHere: () => boolean = () => true): Promise<Settled | null> {
  const root = w3.workspace.project()?.root;
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
    const use = await usageOf(w3, view, plan.conflicts);
    const used = plan.conflicts.map((id) => describeUse(id, use.get(id)!)).join("; ");
    const rawSkin = [...new Set(plan.conflicts.map((id) => view.customs.get(id)!.ext))].filter((ext) => rawOnlySkin(w3.workspace.files().map((f) => f.path), ext));
    items.push(
      { label: "Keep this map's versions", description: `${plan.conflicts.length} differ`, detail: `${differ}${rest}${note}`, value: "keep" },
      ...(rawSkin.length ? [] : [{ label: "Overwrite them with the copied versions", detail: `${differ}. Used by (this map's objects, placed objects) ${used}. Fields they have only in this map's Skin files are dropped.${rest}${note}`, value: "overwrite" as const }]),
      { label: "Paste them under new ids", detail: `${differ}. Everything pasted that refers to them follows.${rest}${note}`, value: "new" },
    );
  } else {
    items.push({ label: `Paste with ${brought.length} object${brought.length === 1 ? "" : "s"} it refers to`, detail: `Comes along: ${listing(brought)}${note}`, value: "keep" });
  }
  items.push({ label: "Paste without the objects it refers to", detail: "Its fields keep naming objects this map may not have.", value: "alone" });
  const pick = await w3.window.quickPick(items, { placeholder: plan.conflicts.length ? `${label} refers to objects this map has with other content` : `${label} refers to objects this map lacks` });
  if (!pick?.value) return null;
  if (w3.workspace.project()?.root !== root || !stillHere()) throw new Error("Nothing was pasted: the project or the editor changed while the paste was being asked.");
  if (pick.value === "alone") return { plan: planPaste({ chosen: set.chosen, along: [] }, world, "keep", chosenAreNew), policy: "alone" };
  return { plan: planPaste(set, world, pick.value, chosenAreNew), policy: pick.value };
}

/** Writes a plan into the files of the map as one edit (one undo), whichever kinds it touches. The plan is
 *  held against the files as they are when the edit reads them: an id taken since stops it, nothing written.
 *  Skin entries of overwritten objects go: their fields are in the object written, and a stale one would win. */
export async function applyPlan(w3: W3Api, plan: Plan, title: string, emptyObjects: () => Promise<EditFile>, stillHere: () => boolean = () => true): Promise<boolean> {
  const root = w3.workspace.project()?.root;
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) {
    if (!(await w3.window.confirm(`Pasting this changes several object files, so unsaved changes in ${unsaved.length === 1 ? unsaved[0] : `${unsaved.length} files`} must be saved first.`, "Save and paste", 20_000))) return false;
    await w3.editors.saveAll();
  }
  if (w3.workspace.project()?.root !== root || !stillHere()) throw new Error("Nothing was pasted: the project or the editor changed while the paste was being asked.");
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
  return edits.edit(title, async (read) => {
    const ids = new Map<string, string>();
    const kd = await Promise.all(ALL_EXTS.map((ext) => loadKind(w3, ext)));
    kd.forEach((k, i) => k.baseIds.forEach((id) => ids.set(id, ALL_EXTS[i])));
    const files = new Map<string, EditFile | null>(), skins = new Map<string, EditFile | null>();
    for (const ext of ALL_EXTS) {
      for (const [map, name] of [[files, `war3map.${ext}`], [skins, `war3mapSkin.${ext}`]] as const) {
        const text = await read(`map/${name}.json`);
        const f = text === null ? null : (JSON.parse(text) as EditFile);
        map.set(ext, f);
        for (const o of f?.custom ?? []) if (typeof o.id === "string") ids.set(o.id, ext);
      }
    }
    assertPlanFits(plan, ids);
    const out: { path: string; text: string }[] = [];
    for (const ext of kindsOf(plan)) {
      const path = jsonPathOf(w3, `war3map.${ext}`);
      const file: EditFile = files.get(ext) ?? await emptyObjects();
      writeInto(file, ext, plan);
      const tidy = { ...file, original: file.original.filter((o) => (o.sets ?? [{ mods: o.mods ?? [] }]).some((s) => s.mods.length)) };
      // Encodes it too: what can't be packed doesn't get written.
      out.push({ path, text: await w3.backend.invoke<string>("objects_canonicalize", { name: path, text: JSON.stringify(tidy) }) });
      const gone = new Set(plan.writes.filter((x) => x.ext === ext && x.overwrites).map((x) => x.overwrites));
      // A Skin file kept raw can't be changed here, and leaving its entry would put old values back: refused.
      if (gone.size) jsonPathOf(w3, `war3mapSkin.${ext}`);
      const skin = skins.get(ext);
      const rest = skin && gone.size ? withoutSkinEntries(skin, gone) : null;
      if (rest) {
        const skinPath = `map/war3mapSkin.${ext}.json`;
        out.push({ path: skinPath, text: await w3.backend.invoke<string>("objects_canonicalize", { name: skinPath, text: JSON.stringify(rest) }) });
      }
    }
    return out;
  });
}
