// Editable placement files: war3map.doo (doodads, destructables) and
// war3mapUnits.doo (units, items), held as the format engine's JSON. They are
// saved back as JSON when the project unpacked them that way, else encoded to
// the raw file by the backend (`codec_write`).

import type { W3Api } from "../../extensions/api";
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
  return { name, key, doc, list, json, dirty: false };
}

export async function savePlacedFile(w3: W3Api, f: PlacedFile): Promise<void> {
  const root = w3.workspace.project()!.root, path = `map/${f.name}`;
  const text = JSON.stringify(f.doc);
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

/** A new entry of type `id` at a position, modelled on an existing entry (same id if there is
 *  one), or a blank one, so every field the file version needs is present; per-object data is
 *  reset. */
export function newEntry(f: PlacedFile, id: string, position: [number, number, number], player?: number): Placed {
  const list = f.list as Entry[];
  const simple = (e: Entry) => e.randomType === undefined || e.randomType === 0;
  const template = list.find((e) => e.id === id && simple(e)) ?? list.find((e) => e.id !== "sloc" && simple(e)) ?? list.find(simple) ?? blankEntry(f);
  const e = structuredClone(template) as Entry;
  const nextOf = (get: (x: Entry) => unknown) => 1 + Math.max(-1, ...list.map((x) => Number(get(x)) || 0).filter((n) => n < UNSET));
  Object.assign(e, { id, variation: 0, position, angle: (270 * Math.PI) / 180, scale: [1, 1, 1] });
  if ("skinId" in e) e.skinId = id;
  if ("editorId" in e && e.editorId !== UNSET) e.editorId = nextOf((x) => x.editorId);
  if ("itemTable" in e) e.itemTable = -1;
  if ("itemSets" in e) e.itemSets = [];
  if (f.key === "doodads") {
    if ("life" in e) e.life = 100;
    if ("flags" in e) e.flags = 2;
    // v13: the first trailer dword is a sequential placement id.
    if (Array.isArray(e.trailer) && Number(f.doc.version) >= 13) {
      e.trailer = [nextOf((x) => (x.trailer as number[] | undefined)?.[0]), ...(e.trailer as number[]).slice(1)];
    }
  } else {
    Object.assign(e, { hp: -1, mana: -1, color: -1, waygate: -1, inventory: [], abilities: [] });
    // Copied from a start location it would be 0, from a camp's creep the camp setting.
    if ("targetAcquisition" in e) e.targetAcquisition = id === "sloc" ? 0 : -1;
    if (player !== undefined) e.player = player;
    if (id !== template.id) {
      if ("level" in e) e.level = 1;
      for (const k of ["strength", "agility", "intelligence"]) if (k in e) e[k] = 0;
      if ("gold" in e) e.gold = id === "ngol" ? 12500 : 0;
    }
  }
  return e;
}
