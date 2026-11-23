// war3map.doo in the version the World Editor's save writes: 13. Measured with we-drive 2026-11-23 (branch
// feat/doo-v13-upgrade; tests/we-compare/doo-v13.json, inputs make-doo-v13.mjs and make-units-v13.mjs): World Editor
// 7003 saves a doodads file of version 8 (with skin ids or without), 7 and 12 as version 13, the subversion (11), the
// order of the doodads and the special doodads as they were. Every doodad gets the 3.0 fields: `skinId` its own (the
// type's id where the file had none), `preFlags` 0xFFFFFFFF, its creation number moved from `editorId` (now 0xFFFFFFFF,
// unset) to `trailer[0]` with Roll and Pitch 0 after it, and `extras` []; a version-7 doodad `itemTable` -1 and no
// item sets.
//
// Lights (we-drive 2026-11-23, branch fix/doo-light-extras; tests/we-compare/doo-lights.json, input make-doo-lights.mjs,
// and doo-v13.json): the save gives every doodad or destructable whose `extras` are empty the lights of its model, the
// model of its variation in the art the editor runs in (SD or HD: the HD lamp post's light is orange, intensity 0; some
// HD models have none where the SD one has one), on a version-13 file as on an upgraded one. One block per light of the
// model, in the model's order (a model with two lights gets two): [its index, 0 (Casts Shadows off), the colour
// 0xFFrrggbb, then as floats the intensity, shadow casting start and end, quadratic and linear falloff, damping]. The
// values are the light's fixed ones (an animated intensity's too: the lamp post YOlp's KLAI over a fixed 0 gives 0);
// the attenuation, the ambient colour and the shadow intensity aren't used. The colour's three bytes are the light's
// three values times 255, cut down to a whole number (0.623529 gives 0x9E), in a binary model's stored order and a text
// model's reversed (mdx.ts ModelLight.fixed); a light before version 1600 has no casting range or falloffs and gets 0,
// 0, 0.0005, 0, 0.00001. A doodad with lights of its own keeps them, one without a light in its model keeps []. Studio:
// the terrain view's save looks the models up (index.ts doodadLights) and hands them to editorDooVersion; a doodad whose
// type or model can't be read keeps [] (the next save tries again).

import type { LightFixed, ModelLight } from "../model/mdx";

/** The doodads file's version the World Editor writes. */
export const EDITOR_DOO_VERSION = 13;

/** A float's bits as the u32 the doodads codec keeps for a light block's float fields. */
function f32Bits(f: number): number {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, f, true);
  return v.getUint32(0, true);
}

/** One colour value as the editor's colour byte: times 255, cut down to a whole number, within 0..255. */
const colorByte = (c: number) => (Number.isFinite(c) ? Math.min(255, Math.max(0, Math.floor(c * 255))) : 0);

/** The light block the World Editor's save gives a doodad for light `index` of its model (see the top). */
export function lightBlock(index: number, l: LightFixed): number[] {
  const color = (0xff000000 | (colorByte(l.color[0]) << 16) | (colorByte(l.color[1]) << 8) | colorByte(l.color[2])) >>> 0;
  return [index, 0, color, ...[l.intensity, l.shadowStart, l.shadowEnd, l.quadratic, l.linear, l.damping].map(f32Bits)];
}

/** The light blocks of a model's lights (none for a model without lights; null when a light lacks its fixed values,
 *  which a reader of this checkout always gives). */
export function lightBlocks(lights: readonly ModelLight[] | undefined): number[][] | null {
  if (!lights?.length) return [];
  if (!lights.every((l) => l.fixed)) return null;
  return lights.map((l, i) => lightBlock(i, l.fixed as LightFixed));
}

/** A doodad's light blocks from its model (lightBlocks), or null where they aren't known (its type or model unread). */
export type DoodadLights = (d: Readonly<Record<string, unknown>>) => number[][] | null | undefined;

/** An unset number: a v13 doodad's `editorId`, its `preFlags` where nothing set them. */
const UNSET = 0xffffffff;

/** Versions the World Editor's save writes as version 13. */
export const UPGRADED_DOO_VERSIONS: readonly number[] = [7, 8, 12];

type Entry = Record<string, unknown>;

/** Whether `v` is a v13 doodad's trailer: the creation number, Roll, Pitch. */
const isV13Trailer = (v: unknown) => Array.isArray(v) && v.length === 3;

/** The 3.0 fields a doodad lacks, given in place; true when it changed anything. A doodad of an older layout (no
 *  trailer: versions 7 and 8; one of two values: version 12) moves its creation number into the trailer. One without
 *  lights of its own gets its model's (`lightsOf`), where they are known. */
function upgradeEntry(d: Entry, lightsOf?: DoodadLights): boolean {
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
  if (Array.isArray(d.extras) && d.extras.length === 0) {
    const lights = lightsOf?.(d);
    if (lights?.length) { d.extras = lights.map((b) => [...b]); changed = true; }
  }
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
 * version-13 document the 3.0 fields it lacks (one put back by an undo after an earlier save upgraded the file), and
 * every doodad without lights of its own its model's (`lightsOf`; see the top). Changes `doc` in place; true when it
 * changed anything. A document that isn't a list of doodads, or of another version, is left as it is.
 */
export function editorDooVersion(doc: Record<string, unknown>, lightsOf?: DoodadLights): boolean {
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
  for (const d of doodads as Entry[]) if (upgradeEntry(d, lightsOf)) changed = true;
  return changed;
}

/** A doodad's creation number in a file of any version: a v13 one's `trailer[0]`, else its `editorId` (also one an
 *  undo put back into an upgraded file before the next save gives it the 3.0 fields). */
export function doodadNumber(d: Readonly<Record<string, unknown>>): unknown {
  return isV13Trailer(d.trailer) ? (d.trailer as unknown[])[0] : d.editorId;
}
