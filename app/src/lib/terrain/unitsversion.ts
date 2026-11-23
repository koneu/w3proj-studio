// war3mapUnits.doo in the version the World Editor's save writes: 13. Measured with we-drive 2026-11-23 (branch
// feat/units-v13-upgrade; tests/we-compare/units-v13.json and all-starts.json): World Editor 7003 saves a version-8
// file, with skin ids (Reforged, editorVersion 6089 and later) or without, as version 13, every entry with the 3.0
// fields: `skinId` its own (the type's id where the file had none), `preFlags` 0xFFFFFFFF and `trailer` [0, 0] and no
// `extras`, the values of every new map's units. The subversion stays (9 or 11: whether it becomes 11 is
// tftflag.ts tftUnitsLayout's rule).

/** The units file's version the World Editor writes. */
export const EDITOR_UNITS_VERSION = 13;

/** A v13 entry's `preFlags` where nothing set one: unset. */
const UNSET = 0xffffffff;

/**
 * Upgrades a war3mapUnits.doo document of version 8 to 13 as the World Editor's save does, and gives an entry of a
 * version-13 document the 3.0 fields it lacks (one put back by an undo after an earlier save upgraded the file).
 * Changes `doc` in place; true when it changed anything. A document that isn't a list of entries, or of another
 * version (7, 12), is left as it is.
 */
export function editorUnitsVersion(doc: Record<string, unknown>): boolean {
  const version = Number(doc.version);
  if ((version !== 8 && version !== EDITOR_UNITS_VERSION) || !Array.isArray(doc.units)) return false;
  const units = doc.units as unknown[];
  if (!units.every((u) => !!u && typeof u === "object" && !Array.isArray(u) && typeof (u as { id?: unknown }).id === "string")) return false;
  let changed = false;
  if (version === 8) {
    doc.version = EDITOR_UNITS_VERSION;
    delete doc.skinIds;
    changed = true;
  }
  for (const u of units as Record<string, unknown>[]) {
    if (!("skinId" in u)) { u.skinId = u.id; changed = true; }
    if (!("preFlags" in u)) { u.preFlags = UNSET; changed = true; }
    if (!("trailer" in u)) { u.trailer = [0, 0]; changed = true; }
    if (!("extras" in u)) { u.extras = []; changed = true; }
  }
  return changed;
}
