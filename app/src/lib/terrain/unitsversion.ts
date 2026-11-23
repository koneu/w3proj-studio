// war3mapUnits.doo in the version the World Editor's save writes: 13. Measured with we-drive 2026-11-23 (branch
// feat/units-v13-upgrade; tests/we-compare/units-v13.json, inputs make-units-v13.mjs, and all-starts.json): World Editor
// 7003 saves a file of version 8, with skin ids (Reforged, editorVersion 6089 and later) or without, and one of version 7
// as version 13, every entry with the 3.0 fields: `skinId` its own (the type's id where the file had none), `preFlags`
// 0xFFFFFFFF, `trailer` [0, 0] and no `extras`, the values of every new map's units. The subversion stays (9 or 11:
// whether 9 becomes 11 is tftflag.ts tftUnitsLayout's rule; the editor writing 11 back as 9 Studio doesn't follow).

/** The units file's version the World Editor writes. */
export const EDITOR_UNITS_VERSION = 13;

/** A v13 entry's `preFlags` where nothing set one: unset. */
const UNSET = 0xffffffff;

/** Versions the World Editor's save writes as version 13 (version 12 isn't measured: left as it is). */
export const UPGRADED_UNITS_VERSIONS: readonly number[] = [7, 8];

/**
 * Upgrades a war3mapUnits.doo document of version 7 or 8 to 13 as the World Editor's save does, and gives an entry of a
 * version-13 document the 3.0 fields it lacks (one put back by an undo after an earlier save upgraded the file).
 * Changes `doc` in place; true when it changed anything. A document that isn't a list of entries, or of version 12, is
 * left as it is.
 */
export function editorUnitsVersion(doc: Record<string, unknown>): boolean {
  const version = Number(doc.version);
  if ((!UPGRADED_UNITS_VERSIONS.includes(version) && version !== EDITOR_UNITS_VERSION) || !Array.isArray(doc.units)) return false;
  const units = doc.units as unknown[];
  if (!units.every((u) => !!u && typeof u === "object" && !Array.isArray(u) && typeof (u as { id?: unknown }).id === "string")) return false;
  let changed = false;
  if (version !== EDITOR_UNITS_VERSION) {
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
