// The start building the World Editor shows, see-through, inside each start location's ring: the
// town hall of the player's race (war3map.w3i). A player of selectable race gets one of the four
// at random in the editor, picked anew each time the map opens (seen 2026-11-08: Night Elf,
// Human and Undead for the same map); here it is one of them by player number instead, so the
// view doesn't change from one opening to the next. The previews are only drawn: not placed,
// not saved, not selectable.

import type { Placed } from "./objects";
import { DEEP_WATER } from "../../lib/terrain/pathing";
import { heightAt, waterSurfaceAt, type Terrain } from "../../lib/terrain/w3e";
import type { TileRect } from "./specials";

/** Whether a start location's preview is left out, as the World Editor does where a start can't be built on:
 *  in shallow water (the water over the ground no deeper than DEEP_WATER; deep water keeps it) or on a tile
 *  a special doodad covers. Studio's own reading of the open point; the editor's exact limits aren't measured. */
export function startPreviewHidden(t: Terrain, specials: readonly TileRect[], x: number, y: number): boolean {
  const water = waterSurfaceAt(t, x, y);
  if (water !== null && water - heightAt(t, x, y) <= DEEP_WATER) return true;
  const tx = Math.floor((x - t.offsetX) / 128), ty = Math.floor((y - t.offsetY) / 128);
  return specials.some((r) => tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1);
}

/** Town halls by race as war3map.w3i stores it: 1 Human, 2 Orc, 3 Undead, 4 Night Elf. */
export const START_BUILDINGS = ["htow", "ogre", "unpl", "etoa"] as const;

/** The see-through look of the previews (the alpha the models are drawn with). */
export const START_PREVIEW_ALPHA = 0.5;

/** The town hall a player's start location shows: by race, else (selectable, a player the map
 *  doesn't list, a race the editor doesn't know) one by player number. */
export function startBuilding(player: number, race: number | undefined): string {
  if (race !== undefined && race >= 1 && race <= 4) return START_BUILDINGS[race - 1];
  return START_BUILDINGS[((player % 4) + 4) % 4];
}

/** One preview per start location of a player: its race's town hall where the start location
 *  stands, facing as buildings do (270°). `races`: player id → race, from war3map.w3i. Whatever
 *  the map's Melee flag: the World Editor drew them on fresh opens of maps with the flag off (also
 *  with custom forces and fixed player settings, and for a computer player) and kept them after a
 *  player's unit was pasted (we-drive, 2026-11-13; the user's decision the same day). */
export function startPreviews(units: readonly Placed[], races: ReadonlyMap<number, number>,
  hidden?: (x: number, y: number) => boolean): Placed[] {
  const out: Placed[] = [];
  for (const u of units) {
    if (u.id !== "sloc" || u.player === undefined) continue;
    if (hidden?.(u.position[0], u.position[1])) continue;
    out.push({ id: startBuilding(u.player, races.get(u.player)), variation: 0, position: [...u.position], angle: (3 * Math.PI) / 2, scale: [1, 1, 1], player: u.player });
  }
  return out;
}

/** Player id → race from war3map.w3i (as its project JSON); empty without players. */
export function playerRaces(info: { players?: { id?: unknown; race?: unknown }[] } | null | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of info?.players ?? []) {
    if (typeof p?.id === "number" && typeof p.race === "number") out.set(p.id, p.race);
  }
  return out;
}

/** What the previews are made from: equal keys draw the same previews. */
export function startPreviewKey(units: readonly Placed[], races: ReadonlyMap<number, number>, hidden?: (x: number, y: number) => boolean): string {
  return JSON.stringify(startPreviews(units, races, hidden).map((p) => [p.id, p.position[0], p.position[1], p.position[2]]));
}
