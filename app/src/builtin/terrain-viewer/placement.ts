// Editable placement files: war3map.doo (doodads, destructables) and
// war3mapUnits.doo (units, items), held as the format engine's JSON. They are
// saved back as JSON when the project unpacked them that way, else encoded to
// the raw file by the backend (`codec_write`).

import type { W3Api } from "../../extensions/api";
import { NEUTRAL_PASSIVE } from "../../lib/terrain/owner";
import { placedText, splitOwners } from "../../lib/terrain/owner";
import type { Placed } from "./objects";

export interface PlacedFile {
  /** Archive name: war3map.doo or war3mapUnits.doo. */
  name: string;
  key: "doodads" | "units";
  /** The whole decoded document; `list` is its `key` array. */
  doc: Record<string, unknown>;
  list: Placed[];
  /** Kept as `map/<name>.json` in the project (else the raw file). */
  json: boolean;
  dirty: boolean;
}

export async function loadPlacedFile(w3: W3Api, name: string, key: "doodads" | "units"): Promise<PlacedFile | null> {
  const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  const path = `map/${name}`;
  let text: string, json: boolean;
  if (files.has(`${path}.json`.toLowerCase())) { text = await w3.workspace.readText(`${path}.json`); json = true; }
  else if (files.has(path.toLowerCase())) { text = await w3.backend.invoke<string>("codec_decode", { root: w3.workspace.project()!.root, path }); json = false; }
  else return null;
  const doc = JSON.parse(text) as Record<string, unknown>;
  const list = (doc[key] ?? []) as Placed[];
  doc[key] = list;
  splitOwners(list);
  return { name, key, doc, list, json, dirty: false };
}

/** `text` is the file as taken earlier; without it the file is serialized now. */
export async function savePlacedFile(w3: W3Api, f: PlacedFile, text: string = placedText(f.doc)): Promise<void> {
  const root = w3.workspace.project()!.root, path = `map/${f.name}`;
  if (f.json) {
    // Canonical formatting keeps diffs minimal (and validates by encoding).
    const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root, path: `${path}.json`, text });
    await w3.workspace.writeText(`${path}.json`, canonical);
  } else {
    await w3.backend.invoke("codec_write", { root, path, text });
  }
  f.dirty = false;
}

type Entry = Placed & Record<string, unknown>;

// 0xFFFFFFFF marks an unset number (every v13 doodad's editorId; the number is the trailer's).
const UNSET = 0xffffffff;

/** An entry with the fields the file's version has (formats/doodads.json, units.json), for a file
 *  with nothing to copy: a new map has no doodads yet. */
function blankEntry(f: PlacedFile): Entry {
  const version = Number(f.doc.version), subversion = Number(f.doc.subversion);
  const skin = version >= 12 || (version === 8 && f.doc.skinIds === true);
  const base = { id: "", variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1] } as Entry;
  if (skin) base.skinId = "";
  if (version >= 12) base.preFlags = UNSET;
  base.flags = 2;
  const end = (trailer: number) => (version >= 12 ? { trailer: new Array<number>(trailer).fill(0), extras: [] } : {});
  if (f.key === "doodads") {
    Object.assign(base, { life: 100 }, version >= 8 ? { itemTable: -1, itemSets: [] } : {});
    return Object.assign(base, { editorId: version >= 13 ? UNSET : 0 }, end(version >= 13 ? 3 : 2));
  }
  const hero = subversion >= 11;
  Object.assign(base, { player: 0, unknown1: 0, unknown2: 0, hp: -1, mana: -1 }, hero ? { itemTable: -1 } : {});
  Object.assign(base, { itemSets: [], gold: 0, targetAcquisition: -1, level: 1 }, hero ? { strength: 0, agility: 0, intelligence: 0 } : {});
  Object.assign(base, { inventory: [], abilities: [], randomType: 0, randomLevel: "010000", randomClass: 0, color: -1, waygate: -1, editorId: 0 });
  return Object.assign(base, end(2));
}

/** The gold mine ability's (Agld) gold at level 1 (DataA1, field Gld1) in the game's AbilityData.slk. */
export const DEFAULT_START_GOLD = 12500;

interface GoldMod { field: string; level?: number; value: unknown }
/** An object file (as JSON) as far as startGoldOf reads it. */
export interface GoldObjectFile { original?: { id?: string; base: string; mods?: GoldMod[] }[] }

/** The gold the World Editor gives every new placed unit (a gold mine's amount, and the same number on every other
 *  unit): the gold mine ability's (Agld) Gld1 at level 1 as the object data sets it, else the game's 12500. `files`:
 *  war3campaign.w3a, war3campaignSkin.w3a, war3map.w3a, war3mapSkin.w3a, as far as there are: a later one wins.
 *  Real maps: 12500 on the placed units of every melee map in smoketest_maps; a Tides of Darkness chapter map's units
 *  carry 99000, its campaign's Agld Gld1 (others 35000, which it was before). */
export function startGoldOf(files: readonly (GoldObjectFile | null | undefined)[]): number {
  let gold = DEFAULT_START_GOLD;
  for (const f of files) {
    for (const o of f?.original ?? []) {
      if ((o.id ?? o.base) !== "Agld") continue;
      const v = (o.mods ?? []).find((m) => m.field === "Gld1" && (m.level === undefined || m.level === 1))?.value;
      if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 0x7fffffff) gold = v;
    }
  }
  return gold;
}

/** A new entry of type `id` at a position, modelled on an existing entry (same id if there is
 *  one), or a blank one, so every field the file version needs is present; per-object data is
 *  reset. `kind` is the type's object kind: as in the World Editor's files, a plain doodad has life
 *  255 where a destructable has its 100 percent, and items belong to Neutral Passive. `startGold`: what a new
 *  unit's gold is (startGoldOf); a start location and an item have 0. */
export function newEntry(f: PlacedFile, id: string, position: [number, number, number], player?: number, kind?: string, startGold = DEFAULT_START_GOLD): Placed {
  const list = f.list as Entry[];
  const simple = (e: Entry) => e.randomType === undefined || e.randomType === 0;
  const template = list.find((e) => e.id === id && simple(e)) ?? list.find((e) => e.id !== "sloc" && simple(e)) ?? list.find(simple) ?? blankEntry(f);
  const e = structuredClone(template) as Entry;
  // A new unit isn't placed uprooted because the one it's copied from was.
  delete e.playerFlags;
  const nextOf = (get: (x: Entry) => unknown) => 1 + Math.max(-1, ...list.map((x) => Number(get(x)) || 0).filter((n) => n < UNSET));
  Object.assign(e, { id, variation: 0, position, angle: (270 * Math.PI) / 180, scale: [1, 1, 1] });
  if ("skinId" in e) e.skinId = id;
  if ("editorId" in e && e.editorId !== UNSET) e.editorId = nextOf((x) => x.editorId);
  if ("itemTable" in e) e.itemTable = -1;
  if ("itemSets" in e) e.itemSets = [];
  if (f.key === "doodads") {
    if ("life" in e) e.life = kind === "w3d" ? 255 : 100;
    if ("flags" in e) e.flags = 2;
    // v13: the first trailer dword is a sequential placement id.
    if (Array.isArray(e.trailer) && Number(f.doc.version) >= 13) {
      e.trailer = [nextOf((x) => (x.trailer as number[] | undefined)?.[0]), ...(e.trailer as number[]).slice(1)];
    }
  } else {
    Object.assign(e, { hp: -1, mana: -1, color: -1, waygate: -1, inventory: [], abilities: [] });
    // Copied from a start location it would be 0, from a camp's creep the camp setting.
    if ("targetAcquisition" in e) e.targetAcquisition = id === "sloc" ? 0 : -1;
    if (kind === "w3t") e.player = NEUTRAL_PASSIVE;
    else if (player !== undefined) e.player = player;
    if (id !== template.id) {
      if ("level" in e) e.level = 1;
      for (const k of ["strength", "agility", "intelligence"]) if (k in e) e[k] = 0;
    }
    // Every placed unit in a World Editor map has the start gold, a gold mine copied from one with its own amount too.
    if ("gold" in e) e.gold = id === "sloc" ? 0 : startGold;
    // The World Editor's items have level 0 and target acquisition 0 (all 78 placed items on the
    // campaign maps and builds in smoketest_maps), not a unit's 1 and -1 (Normal).
    if (kind === "w3t") {
      if ("level" in e) e.level = 0;
      if ("targetAcquisition" in e) e.targetAcquisition = 0;
      if ("gold" in e) e.gold = 0;
    }
  }
  return e;
}

/** A new object in `f` from a copied one. It's numbered as a new one, and takes only the fields this
 *  file's version has: the copy may come from another map. */
export function pastedEntry(f: PlacedFile, copied: { entry: Record<string, unknown>; angle: number }, position: [number, number, number]): Placed {
  const made = newEntry(f, String(copied.entry.id), position, copied.entry.player as number | undefined) as Placed & Record<string, unknown>;
  for (const [key, value] of Object.entries(copied.entry)) {
    if (key in made && key !== "editorId" && key !== "trailer") made[key] = structuredClone(value);
  }
  made.angle = copied.angle;
  return made;
}

/** The grid a copied group moves on when pasted, so every object keeps the parity of its own grid. */
const PASTE_GRID = 64;
/** On the paste grid, half-way values up (Math.round: -15.5 cells is -15), never -0. */
const onPasteGrid = (v: number) => Math.round(v / PASTE_GRID) * PASTE_GRID + 0;

/** The centre of a copied group of objects, as the World Editor's: the mean of their positions (not the middle of
 *  their extent) on the 64 grid. we-drive 2026-11-12, nine pastes (placement.test.ts). */
export function copyCentre(positions: readonly (readonly number[])[]): [number, number] {
  const mean = (i: number) => positions.reduce((sum, p) => sum + p[i], 0) / positions.length;
  return [onPasteGrid(mean(0)), onPasteGrid(mean(1))];
}

/** Where the World Editor puts a copied group's centre for the pointer at (x, y): on the 64 grid. */
export function pasteCentreAt(x: number, y: number): [number, number] {
  return [onPasteGrid(x), onPasteGrid(y)];
}

/** The building grid: a building's edges lie on the 64 grid, so a 6×6 one stands at 32 past it and an
 *  8×8 one on it. All 251 buildings on 14 real maps do. `cells` is its pathing texture's side. */
export const onBuildingGrid = (v: number, cells: number) => {
  const half = cells * 16;
  return Math.round((v - half) / 64) * 64 + half;
};
