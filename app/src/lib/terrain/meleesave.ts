// The Melee flag (war3map.w3i) as a save leaves it. Every path that writes placed units, the map's info, its gameplay
// constants or its ground comes through here: the terrain editor's save, the MCP object tools, and the map script's
// run after a save (also with script.generateOnSave off, and on vJASS maps). The rules are owner.ts meleeBlockers;
// this gathers what they need beyond war3map.w3i and the placed units.

import { meleeBlockers, MELEE_MAP, hasCustomConstants, type MeleeInfo } from "./owner";
import { parseW3e, waterSurfaceAt, type Terrain } from "./w3e";
import { readTerrainBytes, terrainPath } from "./w3etext";

interface PlacedLike { id: string; player?: number; position?: readonly number[] }

/** The map's gameplay constants. */
export const MISC_TXT = "map/war3mapMisc.txt";

/** Whether a start location stands under water: one of the World Editor's "start locations in invalid positions"
 *  (World Editor 7003's new maps on shallow or deep water, we-drive 2026-11-11). Its other invalid positions (trees
 *  about 200 away, a tavern at 250) Studio can't tell (see meleeBlockers). */
export function startsUnderWater(t: Terrain, placed: readonly PlacedLike[]): boolean {
  return placed.some((p) => p.id === "sloc" && Array.isArray(p.position) && p.position.length >= 2
    && Number.isFinite(p.position[0]) && Number.isFinite(p.position[1]) && waterSurfaceAt(t, p.position[0], p.position[1]) !== null);
}

/** What of a project the melee rules read. */
export interface MeleeFiles {
  files(): readonly { path: string }[];
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
}

/** What the rules need besides war3map.w3i and the placed units. */
export interface MeleeFacts {
  /** war3mapMisc.txt sets a gameplay constant. */
  customConstants: boolean;
  /** The ground the start locations stand on; null when unknown. */
  terrain: Terrain | null;
}

/**
 * Reads the facts from the project. `terrain`: the ground being saved (else the project's saved one is read).
 * Missing files set nothing. A file that is there but can't be read or parsed sets nothing either, and that is safe
 * only because Melee only ever goes off here (meleeFlagsAfter): not knowing keeps the flag as it is, it never reads as
 * "constants set" or "a start under water".
 */
export async function readMeleeFacts(ws: MeleeFiles, terrain?: Terrain | null): Promise<MeleeFacts> {
  const files = ws.files().map((f) => f.path);
  const miscPath = files.find((p) => p.toLowerCase() === MISC_TXT.toLowerCase());
  const misc = miscPath ? await ws.readText(miscPath).catch(() => null) : null;
  let ground = terrain ?? null;
  if (terrain === undefined) {
    const path = terrainPath(files);
    const bytes = path ? await readTerrainBytes(path, { readText: () => ws.readText(path), readBytes: () => ws.readBytes(path) }).catch(() => null) : null;
    try { ground = bytes ? parseW3e(bytes) : null; } catch { ground = null; }
  }
  return { customConstants: misc !== null && hasCustomConstants(misc), terrain: ground };
}

/** The map's flags after a save, and why Melee went off (empty when it didn't). Melee only ever goes off, as
 *  owner.ts meleeFlagsAfter: Studio can't tell all of the editor's reasons, so it never puts the flag back. */
export function meleeAfterSave(info: MeleeInfo, placed: readonly PlacedLike[], facts: MeleeFacts): { flags: number; reasons: string[] } {
  if (!(info.flags & MELEE_MAP)) return { flags: info.flags, reasons: [] };
  const reasons = meleeBlockers({ ...info, customConstants: facts.customConstants }, placed, facts.terrain ? startsUnderWater(facts.terrain, placed) : false);
  return { flags: reasons.length ? info.flags & ~MELEE_MAP : info.flags, reasons };
}

/** meleeAfterSave with the facts read from the project; nothing is read when the flag is already off. */
export async function savedMelee(ws: MeleeFiles, info: MeleeInfo, placed: readonly PlacedLike[], terrain?: Terrain | null): Promise<{ flags: number; reasons: string[] }> {
  if (!(info.flags & MELEE_MAP)) return { flags: info.flags, reasons: [] };
  return meleeAfterSave(info, placed, await readMeleeFacts(ws, terrain));
}
