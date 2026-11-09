// Ally and enemy start location priorities of a player (war3map.w3i): two bit masks per kind, a bit per other
// player, low and high. The map script turns them into SetStartLocPrio / SetEnemyStartLocPrio (lib/script/setup.ts).

export type Priority = "none" | "low" | "high";

/** A player's priority for player `id`, from its low and high masks (both set reads as low, as the map script takes it). */
export function priorityOf(low: number, high: number, id: number): Priority {
  return (low >>> id) & 1 ? "low" : (high >>> id) & 1 ? "high" : "none";
}

/** The masks with player `id` set to `p` (the other bits stay). */
export function withPriority(low: number, high: number, id: number, p: Priority): [number, number] {
  const bit = (1 << id) >>> 0;
  const l = (low & ~bit) >>> 0, h = (high & ~bit) >>> 0;
  return [p === "low" ? (l | bit) >>> 0 : l, p === "high" ? (h | bit) >>> 0 : h];
}

/** A player's "fixed start" field (war3map.w3i) holds flags: bit 0 the World Editor's Fixed Start Location
 *  (ForcePlayerStartLocation), bit 1 whether the race can be chosen in the lobby with Fixed Player Settings on
 *  (SetPlayerRaceSelectable: a we-drive save of World Editor 7003, 2026-11-09, wrote `true` for bit 1 with race Human,
 *  `false` for race Selectable without it). Its saves pair bit 1 with race Selectable (0): of the game's maps it last
 *  saved, all 40 such players have it and none of about 2600 with a fixed race. */
export const FIXED_START = 1, RACE_SELECTABLE = 2;

/** The field after the race is chosen in Map Properties: bit 1 follows the race, as the World Editor pairs them; the
 *  other bits stay. */
export const fixedStartForRace = (fixedStart: number, race: number): number =>
  race === 0 ? (fixedStart | RACE_SELECTABLE) >>> 0 : (fixedStart & ~RACE_SELECTABLE) >>> 0;

/** HUD skins (war3map.w3i, version 39 with player HUD skins): race preference bits, as SetPlayerRaceSkin takes them.
 *  The game's own maps (7003) have 64, "Selected Race". */
export const HUD_SKINS: [number, string][] = [[64, "Selected Race"], [1, "Human"], [2, "Orc"], [4, "Undead"], [8, "Night Elf"]];
