// war3map.doo in the version the World Editor's save writes: 13. Measured with we-drive 2026-11-23 (branch
// feat/doo-v13-upgrade; tests/we-compare/doo-v13.json, inputs make-doo-v13.mjs and make-units-v13.mjs): World Editor
// 7003 saves a doodads file of version 8 (with skin ids or without), 7 and 12 as version 13, the subversion (11), the
// order of the doodads and the special doodads as they were. Every doodad gets the 3.0 fields: `skinId` its own (the
// type's id where the file had none), `preFlags` 0xFFFFFFFF, its creation number moved from `editorId` (now 0xFFFFFFFF,
// unset) to `trailer[0]` with Roll and Pitch 0 after it, and `extras` []; a version-7 doodad `itemTable` -1 and no
// item sets. Not done here: the editor's save also gives a doodad whose model has a light (LOlp, YOlp, LOtz, …) that
// light in `extras` (on a version-13 file too, not only on an upgrade; an open point of its own).

/** The doodads file's version the World Editor writes. */
export const EDITOR_DOO_VERSION = 13;

/** An unset number: a v13 doodad's `editorId`, its `preFlags` where nothing set them. */
const UNSET = 0xffffffff;

/** Versions the World Editor's save writes as version 13. */
export const UPGRADED_DOO_VERSIONS: readonly number[] = [7, 8, 12];

type Entry = Record<string, unknown>;

/** Whether `v` is a v13 doodad's trailer: the creation number, Roll, Pitch. */
const isV13Trailer = (v: unknown) => Array.isArray(v) && v.length === 3;

/** The 3.0 fields a doodad lacks, given in place; true when it changed anything. A doodad of an older layout (no
 *  trailer: versions 7 and 8; one of two values: version 12) moves its creation number into the trailer. */
function upgradeEntry(d: Entry): boolean {
  let changed = false;
  if (!("skinId" in d)) { d.skinId = d.id; changed = true; }
  if (!("preFlags" in d)) { d.preFlags = UNSET; changed = true; }
  if (!("itemTable" in d)) { d.itemTable = -1; changed = true; }
  if (!("itemSets" in d)) { d.itemSets = []; changed = true; }
  if (!isV13Trailer(d.trailer)) {
    // Version 12's two values (0 in every map seen) stay after the number as Roll and Pitch.
    const old = Array.isArray(d.trailer) && d.trailer.length === 2 ? d.trailer : [0, 0];
    d.trailer = [typeof d.editorId === "number" ? d.editorId : 0, ...old];
    d.editorId = UNSET;
    changed = true;
  }
  if (!("extras" in d)) { d.extras = []; changed = true; }
  return changed;
}

/** Whether `d` is a doodad as far as the upgrade reads it: an object with a type id, its editorId (where it has one) a
 *  number and its trailer (where it has one) a list. */
function upgradable(d: unknown): d is Entry {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const e = d as Entry;
  if (typeof e.id !== "string") return false;
  if ("editorId" in e && typeof e.editorId !== "number") return false;
  if ("trailer" in e && !Array.isArray(e.trailer)) return false;
  return true;
}

/**
 * Upgrades a war3map.doo document of version 7, 8 or 12 to 13 as the World Editor's save does, and gives a doodad of a
 * version-13 document the 3.0 fields it lacks (one put back by an undo after an earlier save upgraded the file).
 * Changes `doc` in place; true when it changed anything. A document that isn't a list of doodads, or of another
 * version, is left as it is.
 */
export function editorDooVersion(doc: Record<string, unknown>): boolean {
  const version = Number(doc.version);
  if ((!UPGRADED_DOO_VERSIONS.includes(version) && version !== EDITOR_DOO_VERSION) || !Array.isArray(doc.doodads)) return false;
  const doodads = doc.doodads as unknown[];
  if (!doodads.every(upgradable)) return false;
  let changed = false;
  if (version !== EDITOR_DOO_VERSION) {
    doc.version = EDITOR_DOO_VERSION;
    delete doc.skinIds;
    changed = true;
  }
  for (const d of doodads as Entry[]) if (upgradeEntry(d)) changed = true;
  return changed;
}

/** A doodad's creation number in a file of any version: a v13 one's `trailer[0]`, else its `editorId` (also one an
 *  undo put back into an upgraded file before the next save gives it the 3.0 fields). */
export function doodadNumber(d: Readonly<Record<string, unknown>>): unknown {
  return isV13Trailer(d.trailer) ? (d.trailer as unknown[])[0] : d.editorId;
}
