// Delete Invalid Objects: placed units, items, doodads and destructables whose type neither the
// game nor the map's object data has. The decision is pure (`splitInvalid`) and takes the set of
// known types, so what stays is what a check of the placement files would not report.

import type { W3Api } from "../../extensions/api";
import { loadKind } from "../../lib/objects/metadata";
import { readMapDocStrict } from "../../lib/formats/mapdoc";
import { checkpointIfOn } from "../../lib/checkpoint";

/** How a kind's game data is loaded (a parameter so tests can stand in for the game). */
export type KindLoader = (w3: W3Api, kind: string) => Promise<{ baseIds: string[] }>;

interface Obj { id?: string }
interface PlacedEntry { id: string; position: number[] }

/** The placement files: where each kind of object lives. */
export const PLACEMENT_FILES = [["map/war3mapUnits.doo.json", "units"], ["map/war3map.doo.json", "doodads"]] as const;

/** Random units/items/buildings ("uDNR", "iDNR", "bDNR") and random items by level ("YiI1"): no type
 *  of their own, the game makes the choice. */
export const isRandomId = (id: string) => /^[uib]DNR$/.test(id) || /^Y.I\d$/.test(id);

/** Every type id placed objects may have, and which placement file each belongs in. `gameOk` is
 *  false when the game's object data could not be read: then "unknown" only means "not loaded". */
export interface KnownTypes { known: Set<string>; inUnits: Set<string>; inDoodads: Set<string>; gameOk: boolean }

/** Where a campaign project would be, going by the folder layout (<campaign>/maps/<chapter>), else
 *  undefined. Forward slashes, which Windows takes too. `findCampaign` also checks that there is one. */
export function campaignOf(root: string | undefined): string | undefined {
  const m = root ? /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/i.exec(root)?.[1] : undefined;
  return m?.replace(/\\/g, "/");
}

/** The campaign project a chapter map's project sits in: the folder two up, if it holds war3campaign.w3f
 *  (in its project or raw form), as the Campaign Editor decides. Else undefined. Throws, saying why,
 *  when that can't be found out: an unknown answer must not count as "no campaign", or the
 *  campaign's objects and files would all look missing. */
export async function findCampaign(w3: W3Api): Promise<string | undefined> {
  const campaign = campaignOf(w3.workspace.project()?.root);
  if (!campaign) return undefined;
  for (const name of ["war3campaign.w3f.json", "war3campaign.w3f"]) {
    const path = `${campaign}/map/${name}`;
    let there: boolean;
    try { there = await w3.backend.invoke<boolean>("fs_exists", { path }); } catch (e) {
      throw new Error(`Whether ${campaign} is this chapter map's campaign couldn't be checked: ${path} (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (there) return campaign;
  }
  return undefined;
}

/** `read`: how an object file is read (readMapDocStrict, or the Problems run's shared copy of it). */
export async function knownPlacedTypes(w3: W3Api, load: KindLoader = loadKind, read: (path: string) => Promise<unknown> = (path) => readMapDocStrict(w3, path)): Promise<KnownTypes> {
  // "sloc" is a start location: never unknown, never removed.
  const known = new Set<string>(["sloc"]);
  const inUnits = new Set<string>(["sloc"]), inDoodads = new Set<string>();
  let gameOk = true;
  const note = (kind: string, id: string) => { known.add(id); (kind === "w3u" || kind === "w3t" ? inUnits : inDoodads).add(id); };
  const readJson = <T>(path: string) => read(path) as Promise<T | null>;
  // A chapter map also has its campaign's custom objects (the campaign project is two folders up).
  const campaign = await findCampaign(w3);
  const kinds = ["w3u", "w3t", "w3b", "w3d"];
  const filesOf = (kind: string) => {
    const files = [`map/war3map.${kind}.json`, `map/war3mapSkin.${kind}.json`, `map/war3campaign.${kind}.json`, `map/war3campaignSkin.${kind}.json`];
    if (campaign) files.push(`${campaign}/map/war3campaign.${kind}.json`, `${campaign}/map/war3campaignSkin.${kind}.json`);
    return files;
  };
  // Everything is read at once, and then gone through in order: the game's data and the files of each
  // kind, so a failure is the first one in that order, as when they were read one after another.
  const [loaded, docs] = await Promise.all([
    Promise.all(kinds.map((kind) => load(w3, kind).catch(() => null))),
    Promise.all(kinds.map((kind) => Promise.allSettled(filesOf(kind).map((file) => readJson<{ custom?: Obj[] }>(file))))),
  ]);
  for (const [i, kind] of kinds.entries()) {
    const k = loaded[i];
    if (!k || !k.baseIds.length) gameOk = false;
    for (const id of k?.baseIds ?? []) note(kind, id);
    // An object file that is there but unreadable throws: its objects would all look unknown.
    for (const doc of docs[i]) {
      if (doc.status === "rejected") throw doc.reason;
      for (const o of doc.value?.custom ?? []) if (o.id) note(kind, o.id);
    }
  }
  return { known, inUnits, inDoodads, gameOk };
}

/** Splits a placement list: `keep` is everything but the objects of an unknown type. Start locations
 *  and random objects are always kept, so are entries without an id string (not understood, not touched). */
export function splitInvalid<T extends { id?: unknown }>(list: T[], known: Set<string>): { keep: T[]; removed: T[] } {
  const keep: T[] = [], removed: T[] = [];
  for (const p of list) {
    const id = p.id;
    if (typeof id !== "string" || id === "sloc" || isRandomId(id) || known.has(id)) keep.push(p);
    else removed.push(p);
  }
  return { keep, removed };
}

export interface InvalidPlan {
  /** Per placement file: its key, and the ids removed (with counts). */
  files: { file: string; key: string; count: number }[];
  /** Unknown type id → how many are placed. */
  types: Map<string, number>;
  total: number;
}

/** What Delete Invalid Objects would remove; throws when the game's data isn't there to judge by. */
export async function planInvalid(w3: W3Api, load: KindLoader = loadKind): Promise<InvalidPlan> {
  const t = await knownPlacedTypes(w3, load);
  if (!t.gameOk) throw new Error("The game's object data isn't available, so unknown types can't be told from types that just failed to load. Nothing was changed.");
  const plan: InvalidPlan = { files: [], types: new Map(), total: 0 };
  for (const [file, key] of PLACEMENT_FILES) {
    const doc = await readMapDocStrict<Record<string, { id?: unknown }[]>>(w3, file);
    const list = doc?.[key];
    if (!Array.isArray(list)) continue;
    const { removed } = splitInvalid(list, t.known);
    if (!removed.length) continue;
    for (const p of removed) plan.types.set(p.id as string, (plan.types.get(p.id as string) ?? 0) + 1);
    plan.files.push({ file, key, count: removed.length });
    plan.total += removed.length;
  }
  return plan;
}

/** Changes one placement document and writes it back in the form the project keeps it in. */
export async function editPlacedFile(w3: W3Api, file: string, change: (doc: Record<string, PlacedEntry[]>) => void) {
  const root = w3.workspace.project()!.root;
  const raw = file.replace(/\.json$/, "");
  const json = await w3.workspace.readText(file).catch(() => null);
  const text = json ?? await w3.backend.invoke<string>("codec_decode", { root, path: raw });
  const doc = JSON.parse(text) as Record<string, PlacedEntry[]>;
  change(doc);
  if (json !== null) await w3.workspace.writeText(file, await w3.backend.invoke<string>("codec_canonicalize", { root, path: file, text: JSON.stringify(doc) }));
  else await w3.backend.invoke("codec_write", { root, path: raw, text: JSON.stringify(doc) });
}

/** The question's text: what goes, in short. */
export function describePlan(plan: InvalidPlan): string {
  const ids = [...plan.types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ids.slice(0, 6).map(([id, n]) => `${id} ×${n}`).join(", ");
  const more = ids.length > 6 ? ` and ${ids.length - 6} more type${ids.length - 6 === 1 ? "" : "s"}` : "";
  return `Delete ${plan.total} placed object${plan.total === 1 ? "" : "s"} of ${ids.length} unknown type${ids.length === 1 ? "" : "s"} (${shown}${more})? Start locations stay. A checkpoint is made first, to come back to, where they're enabled.`;
}

/** Removes the objects of unknown types; returns how many went. A checkpoint comes first (the way
 *  back), and unsaved edits stop it: the files on disk are changed, and an open editor would
 *  save its own copy over the result. */
export async function deleteInvalid(w3: W3Api, load: KindLoader = loadKind): Promise<number> {
  if (!w3.workspace.project()) throw new Error("Open or import a project first.");
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) throw new Error(`Save or discard the changes of ${unsaved.join(", ")} first: Delete Invalid Objects works on the saved files.`);
  const plan = await planInvalid(w3, load);
  if (!plan.total) { void w3.window.showInfo("No invalid objects: every placed object has a known type."); return 0; }
  if (!(await w3.window.confirm(describePlan(plan), "Delete", 60_000))) return 0;
  // Planned again after the question: the files could have changed meanwhile.
  const t = await knownPlacedTypes(w3, load);
  if (!t.gameOk) throw new Error("The game's object data isn't available any more. Nothing was changed.");
  const checkpointed = await checkpointIfOn(w3, "Delete Invalid Objects");
  let removed = 0;
  for (const { file, key } of plan.files) {
    await editPlacedFile(w3, file, (doc) => {
      const { keep, removed: gone } = splitInvalid(doc[key] ?? [], t.known);
      removed += gone.length;
      doc[key] = keep;
    });
  }
  void w3.window.showInfo(`Deleted ${removed} invalid placed object${removed === 1 ? "" : "s"}.${checkpointed ? " The checkpoint made before is in Restore Checkpoint." : ""}`);
  return removed;
}
