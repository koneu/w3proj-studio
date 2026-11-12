// The Skin object files (war3mapSkin.w3u and the like, war3campaignSkin.* in a campaign): Reforged keeps an object's
// names, art, models, sounds and tooltips there, the rest in the main file (war3map.w3u).
//
// The World Editor's rules (we-drive on copies of "Firebrand Exarchate Race", 2026-11-12):
// - Which file a field belongs in is its metadata's `netsafe` column (UnitMetaData.slk and the other *MetaData.slk;
//   the editor logs "Referencing unknown database field: 'netsafe'" for the tables without one): 1 → Skin file, 0 →
//   main file. DoodadMetaData has no such column: a doodad's fields all stay in the main file (the campaigns'
//   war3campaignSkin.w3d hold no fields).
// - It reads both, and where both set a field the Skin file's value is the one: a unit with "MainKeeper" in
//   war3map.w3u and TRIGSTR_050 ("Infernal Keeper") in war3mapSkin.w3u shows "Infernal Keeper", and its save keeps
//   that. That holds for a field of the wrong file too (hit points in both: the Skin file's went into the save).
// - Its save puts every field in the file it belongs in: a name only war3map.w3u had went to war3mapSkin.w3u, hit
//   points only the Skin file had went to war3map.w3u; a version-1 war3map.w3u without a Skin file came out as
//   version 3 with its names and art in a new war3mapSkin.w3u.
//
// Studio reads them the same way (w3o.ts mergeSkin). A save leaves what wasn't changed where it is, so a map saved
// without changes keeps its bytes, and puts a changed or new field where the World Editor does. One exception: an
// old-format main file (version below 3) without a Skin file keeps its changed fields itself, as Studio doesn't
// upgrade object files (see unitprops.ts ownSetsOnly) and older games don't read Skin files.

import type { FieldMeta } from "../../lib/objects/metadata";
import type { EditFile, EditMod, EditObject } from "./objectedit";
import { pairing } from "./w3o";

/** The Skin file of a main object file (war3map.w3u.json → war3mapSkin.w3u.json; war3campaign too); the path
 *  itself when it isn't one. */
export const skinPathOf = (path: string) => path.replace(/(war3map|war3campaign)(\.w3[utabdhq](\.json)?)$/i, "$1Skin$2");

/** Whether a field belongs in the Skin file (its metadata's netsafe column is set); undefined when the field isn't
 *  known (no game data): such a field stays in the file it is in. */
export function isSkinField(f: FieldMeta | undefined): boolean | undefined {
  if (!f) return undefined;
  const v = String(f.use?.netsafe ?? "").trim();
  return v !== "" && v !== "0";
}

/** Whether changed fields that belong in the Skin file may go there: a Skin file that is there as text, or none yet
 *  next to a main file of version 3 (Reforged's). A Skin file kept raw can't be written; an old-format main file
 *  without one keeps them (see the top). */
export function skinWritable(mainVersion: number, skin: "json" | "raw" | "none"): boolean {
  return skin === "json" || (skin === "none" && mainVersion >= 3);
}

const keyOf = (flag: number, m: EditMod) => `${flag}/${m.field}/${m.level ?? 0}/${m.data ?? 0}`;
const sameValue = (a: EditMod, b: EditMod) => a.value === b.value && a.type === b.type;
/** An object's mods with the flag of their set (plain mods count as flag 0). */
const flagged = (o: EditObject | undefined): { flag: number; m: EditMod }[] =>
  !o ? [] : o.sets ? o.sets.flatMap((s) => s.mods.map((m) => ({ flag: s.flag, m }))) : (o.mods ?? []).map((m) => ({ flag: 0, m }));

/** An object of `like`'s shape (plain mods or flagged sets) holding `mods`: sets when `like` has them or a mod
 *  needs a flag other than 0. `flags`: the sets to keep even when empty, in order. */
function shaped(like: EditObject, mods: { flag: number; m: EditMod }[], flags: number[]): EditObject {
  let body: Pick<EditObject, "sets" | "mods">;
  if (like.sets || mods.some((x) => x.flag !== 0)) {
    const order = [...flags];
    for (const x of mods) if (!order.includes(x.flag)) order.push(x.flag);
    body = { sets: order.map((flag) => ({ flag, mods: mods.filter((x) => x.flag === flag).map((x) => x.m) })) };
  } else {
    body = { mods: mods.map((x) => x.m) };
  }
  // The object's keys in their order, the mods where they were: an unchanged object comes out the same.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(like)) {
    if (k === "sets" || k === "mods") Object.assign(out, body);
    else out[k] = v;
  }
  return Object.assign(out, body) as unknown as EditObject;
}

export interface SplitOptions {
  /** Whether a field belongs in the Skin file (isSkinField); undefined: not known. */
  toSkin(field: string): boolean | undefined;
  /** skinWritable: false keeps changed fields out of the Skin file. */
  skinWritable: boolean;
}

/** Splits object data merged from a main file and its Skin file (mergeSkin, the Skin file's values winning) back into
 *  the two, against the files as they were read (`main`, `skin`; null: not there). A field whose value didn't change
 *  stays where it was, in its place, together with a value of the other file that it hides; a changed or new one
 *  goes to the file it belongs in and leaves the other; a field that is gone leaves both. Objects keep the order of
 *  their file; new ones come after. The Skin file comes back null when there was none and nothing goes into it. */
export function splitSkin(merged: EditFile, main: EditFile | null, skin: EditFile | null, opts: SplitOptions): { main: EditFile; skin: EditFile | null } {
  const mainOut: EditFile = { ...(main ?? {}), format: merged.format, version: merged.version, original: [], custom: [] };
  const skinOut: EditFile = { ...(skin ?? { format: merged.format, version: merged.version }), original: [], custom: [] };
  let skinUsed = !!skin;
  const side = (list: "custom" | "original") => {
    const same = list === "custom" ? (a: EditObject, b: EditObject) => a.id === b.id : (a: EditObject, b: EditObject) => a.base === b.base;
    const mainList = main?.[list] ?? [], skinList = skin?.[list] ?? [];
    // Two objects of one id go with the files' first and second of it, as mergeSkin paired them.
    const mainOf = pairing(mainList, same), skinOf = pairing(skinList, same);
    const skinParts = new Map<EditObject, EditObject>(), skinNew: EditObject[] = [];
    for (const o of merged[list]) {
      const lm = mainOf(o), ls = skinOf(o);
      const was = new Map<string, { m?: EditMod; s?: EditMod }>();
      for (const x of flagged(lm)) { const k = keyOf(x.flag, x.m); if (!was.get(k)?.m) was.set(k, { ...was.get(k), m: x.m }); }
      for (const x of flagged(ls)) { const k = keyOf(x.flag, x.m); if (!was.get(k)?.s) was.set(k, { ...was.get(k), s: x.m }); }
      const now = new Map<string, { flag: number; m: EditMod }>();
      for (const x of flagged(o)) if (!now.has(keyOf(x.flag, x.m))) now.set(keyOf(x.flag, x.m), x);
      // Where each field goes: "keep" (unchanged: both files as they were), or the file a changed one goes to.
      const fate = new Map<string, "keep" | "main" | "skin">();
      for (const [k, x] of now) {
        const w = was.get(k);
        if (w?.s ? sameValue(w.s, x.m) : w?.m && sameValue(w.m, x.m)) { fate.set(k, "keep"); continue; }
        const wants = opts.toSkin(x.m.field);
        const to = wants === undefined ? (w?.s ? "skin" : "main") : wants && opts.skinWritable ? "skin" : "main";
        fate.set(k, to);
      }
      /** The new value of a field for a file: its old mod when kept, the merged one (without an end token that is
       *  the object's own) when it went there. */
      const take = (k: string, into: EditObject | undefined) => {
        const m = now.get(k)!.m;
        if (m.end !== undefined && into && m.end === into.end) { const { end: _e, ...rest } = m; return rest as EditMod; }
        return m;
      };
      const build = (file: "main" | "skin", old: EditObject | undefined) => {
        const out: { flag: number; m: EditMod }[] = [], placed = new Set<string>();
        for (const x of flagged(old)) {
          const k = keyOf(x.flag, x.m), f = fate.get(k);
          if (placed.has(k) || f === undefined) continue;
          placed.add(k);
          if (f === "keep") out.push(x);
          else if (f === file) out.push({ flag: x.flag, m: take(k, old) });
        }
        for (const [k, x] of now) if (!placed.has(k) && fate.get(k) === file) out.push({ flag: x.flag, m: take(k, old ?? o) });
        return out;
      };
      const mainMods = build("main", lm), skinMods = build("skin", ls);
      // In the main file: what it had, and every object of the editor's but those only the Skin file had that still
      // have nothing for it. Standard objects only with changes, as the editor writes them.
      const inMain = list === "custom" ? !!lm || !ls || mainMods.length > 0 : mainMods.length > 0;
      if (inMain) mainOut[list].push(shaped(lm ?? o, mainMods, (lm ?? o).sets?.map((s) => s.flag) ?? []));
      if (ls) skinParts.set(ls, shaped(ls, skinMods, ls.sets?.map((s) => s.flag) ?? []));
      else if (skinMods.length) {
        const { sets: _s, mods: _m, ...head } = o;
        skinNew.push(shaped({ ...head, ...(o.sets && skinMods.some((x) => x.flag !== 0) ? { sets: [] } : {}) }, skinMods, []));
      }
    }
    // The Skin file's objects in its order, then the new ones. Those the editor doesn't have are gone, but for entries
    // without fields of objects only the Skin file has: mergeSkin leaves those out, and they stay as they were.
    const keyIn = (x: EditObject) => (list === "custom" ? x.id : x.base);
    const inMainFile = new Set(mainList.map(keyIn));
    for (const ls of skinList) {
      const p = skinParts.get(ls) ?? (flagged(ls).length === 0 && !inMainFile.has(keyIn(ls)) ? ls : undefined);
      if (p) skinOut[list].push(p);
    }
    skinOut[list].push(...skinNew);
    if (skinNew.length) skinUsed = true;
  };
  side("custom");
  side("original");
  return { main: mainOut, skin: skinUsed ? skinOut : null };
}

/** A project path as the project lists it (a file's name may differ in case on disk), else `wanted` itself. */
export const listedPath = (paths: readonly string[], wanted: string) => paths.find((p) => p.toLowerCase() === wanted.toLowerCase()) ?? wanted;

/** An object file with both lists (a file may leave out an empty one). */
export const withLists = (f: EditFile): EditFile => ({ ...f, original: f.original ?? [], custom: f.custom ?? [] });

/** Whether a split changed the Skin file: what is written only then, so an unchanged one keeps its bytes. */
export function skinChanged(before: EditFile | null, after: EditFile | null): boolean {
  return JSON.stringify(before ? withLists(before) : null) !== JSON.stringify(after);
}
