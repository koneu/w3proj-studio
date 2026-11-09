// Players and their start locations (unit "sloc" in war3mapUnits.doo). In the game's maps every
// player of war3map.w3i has a start location at its stored start position; some campaign
// maps also have start locations of players that aren't in the map (controller "None").
// So placing a start location for a new player adds the player, deleting it removes the
// player, and moving it moves the player's start; the "None" ones stay as they are.

export interface StartPlayer {
  id: number; controller: number; race: number; fixedStart: number; name: string; start: number[];
  allyLow: number; allyHigh: number; enemyLow?: number; enemyHigh?: number; hudSkin?: number;
}
export interface PlayerInfo { version: number; playerHudSkins?: boolean; players: StartPlayer[]; forces: { players: number }[] }
interface Placed { id: string; player?: number; position: number[] }

/** Players a w3i version can hold: 24 since 1.31 (w3i v31), 12 before. */
export const maxPlayers = (info: { version: number }) => (info.version >= 31 ? 24 : 12);

/** Start location per player (the first one when a player has several). */
export function startLocations(units: readonly Placed[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const u of units) if (u.id === "sloc" && u.player !== undefined && !out.has(u.player)) out.set(u.player, u.position);
  return out;
}

/** Adds player `id` (a new user player of selectable race in the first force), sorted by id. */
export function addPlayer(info: PlayerInfo, id: number, start: number[]): StartPlayer {
  const like = info.players[0];
  const p: StartPlayer = { id, controller: 1, race: 0, fixedStart: 0, name: `Player ${id + 1}`, start: [start[0], start[1]], allyLow: 0, allyHigh: 0 };
  // Fields that depend on the file version, as the other players have them. The first player of a
  // map has nobody to go by.
  if (like ? like.enemyLow !== undefined : info.version >= 31) { p.enemyLow = 0; p.enemyHigh = 0; }
  if (like ? like.hudSkin !== undefined : info.version >= 39 && info.playerHudSkins) p.hudSkin = 0;
  info.players.push(p);
  info.players.sort((a, b) => a.id - b.id);
  const bit = (1 << id) >>> 0;
  if (info.forces.length && !info.forces.some((f) => (f.players & bit) !== 0)) info.forces[0].players = (info.forces[0].players | bit) >>> 0;
  return p;
}

/** Where a map without a start location gets one: the middle of its playable part, on the 64 grid
 *  start locations keep to. The game stays in its main menu on a map with no players. */
export const firstStart = (a: { left: number; right: number; bottom: number; top: number }): [number, number] =>
  [Math.round((a.left + a.right) / 128) * 64, Math.round((a.bottom + a.top) / 128) * 64];

/** Removes player `id` from the players and the forces. */
export function removePlayer(info: PlayerInfo, id: number) {
  info.players = info.players.filter((p) => p.id !== id);
  const bit = (1 << id) >>> 0;
  for (const f of info.forces) f.players = (f.players & ~bit) >>> 0;
}

/** Brings the players in line with the start locations after editing them. `before`: the
 *  start locations as they were (so players that never had one, and start locations of
 *  players left out on purpose, stay as they are). Returns what changed, for a message;
 *  empty if nothing did. */
export function syncPlayers(info: PlayerInfo, now: Map<number, number[]>, before: Map<number, number[]>): string[] {
  const changes: string[] = [];
  for (const p of [...info.players]) {
    const at = now.get(p.id);
    if (at) {
      if (Math.abs(p.start[0] - at[0]) > 1e-3 || Math.abs(p.start[1] - at[1]) > 1e-3) {
        p.start = [at[0], at[1]];
        changes.push(`moved player ${p.id + 1}'s start`);
      }
    } else if (before.has(p.id)) {
      removePlayer(info, p.id);
      changes.push(`removed player ${p.id + 1}`);
    }
  }
  for (const [id, at] of now) {
    if (before.has(id) || info.players.some((p) => p.id === id) || id >= maxPlayers(info)) continue;
    addPlayer(info, id, at);
    changes.push(`added player ${id + 1}`);
  }
  return changes;
}

// ---- ally priorities ------------------------------------------------------------------------------

/** war3map.w3i flag: "Modify ally priorities" (the map keeps its own). */
export const MODIFY_ALLY_PRIORITIES = 0x0002;
/** A player slot a person plays (controller User). */
const USER = 1;

/** Whether the World Editor works out the map's ally priorities itself when it saves: unless "Modify ally priorities"
 *  is on. Neither the Melee flag nor custom forces or fixed player settings matter (we-drive saves of World Editor
 *  7003, 2026-11-09: a map it took the Melee flag off, one it put it on, one with custom forces and fixed settings
 *  all got them; the game's maps: the user players of all 238 without the flag hold them). */
export const autoAllyPriorities = (flags: number): boolean => (flags & MODIFY_ALLY_PRIORITIES) === 0;

/**
 * The ally priorities the World Editor gives the user players when it works them out: those whose start is at most
 * 1.25 times as far from the player's own as the nearest other user's start get High, at most 1.5 times Low, the rest
 * none. Computer and neutral players are left out: they get nothing here and are nobody's. By user player id:
 * [allyLow, allyHigh]. Found with we-drive saves (2026-11-09: exactly 1.25 and 1.5 count, 1.26 and 1.505 don't; a
 * computer player between two users is skipped) and checked on the game's maps (all 238 without the Modify flag).
 */
export function editorAllyPriorities(players: readonly Pick<StartPlayer, "id" | "controller" | "start">[]): Map<number, [number, number]> {
  const users = players.filter((p) => p.controller === USER);
  const out = new Map<number, [number, number]>(users.map((p) => [p.id, [0, 0]]));
  for (const p of users) {
    // Squared distances: 1.25² and 1.5² are exact, so a start at exactly 1.25 or 1.5 times counts as the editor's does.
    const others = users.filter((q) => q !== p).map((q) => ({ id: q.id, d: (q.start[0] - p.start[0]) ** 2 + (q.start[1] - p.start[1]) ** 2 }));
    if (!others.length) continue;
    const nearest = Math.min(...others.map((o) => o.d));
    let low = 0, high = 0;
    for (const { id, d } of others) {
      if (d <= 1.5625 * nearest) high |= 1 << id;
      else if (d <= 2.25 * nearest) low |= 1 << id;
    }
    out.set(p.id, [low >>> 0, high >>> 0]);
  }
  return out;
}

/** Gives the user players the World Editor's ally priorities when the map's flags let it work them out
 *  (autoAllyPriorities) and takes their enemy priorities away, as its save does; the other players keep theirs (the
 *  game's campaign maps' computer players hold masks it never touched). A file version without enemy priorities
 *  stays without. True when anything changed. */
export function applyAllyPriorities(info: { flags: number; players: StartPlayer[] }): boolean {
  if (!autoAllyPriorities(info.flags)) return false;
  const masks = editorAllyPriorities(info.players);
  let changed = false;
  for (const p of info.players) {
    const own = masks.get(p.id);
    if (!own) continue;
    const [low, high] = own;
    if ((p.allyLow >>> 0) !== low || (p.allyHigh >>> 0) !== high) { p.allyLow = low; p.allyHigh = high; changed = true; }
    if (p.enemyLow !== undefined && p.enemyLow !== 0) { p.enemyLow = 0; changed = true; }
    if (p.enemyHigh !== undefined && p.enemyHigh !== 0) { p.enemyHigh = 0; changed = true; }
  }
  return changed;
}
