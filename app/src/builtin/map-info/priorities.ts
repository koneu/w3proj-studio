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

/** HUD skins (war3map.w3i, version 39 with player HUD skins): race preference bits, as SetPlayerRaceSkin takes them.
 *  The game's own maps (7003) have 64, "Selected Race". */
export const HUD_SKINS: [number, string][] = [[64, "Selected Race"], [1, "Human"], [2, "Orc"], [4, "Undead"], [8, "Night Elf"]];
