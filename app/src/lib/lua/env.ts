// The names a Lua map script can call without defining them: Lua's own and the game's API (the same natives and
// Blizzard functions JASS has, read by jass/env, plus the natives of common.ai).

import { gameJassEnv } from "../jass/env";
import { luaApiFrom, luaKnownNames } from "./check";

let api: Promise<Set<string>> | null = null;

/** The game's Lua API (cached). Null when the game's scripts can't be read: names aren't judged then (the syntax
 *  check still runs), and the next call tries again. */
export async function gameLuaApi(read: (path: string) => Promise<string>): Promise<Set<string> | null> {
  api ??= (async () => luaApiFrom(await gameJassEnv(read), await read("Scripts\\common.ai")))();
  try {
    return await api;
  } catch {
    api = null;
    return null;
  }
}

/** What a Lua text inside a map is checked against: the game's API and the globals `scripts` define (the map's
 *  war3map.lua, other texts), each script null when there is none. Null: names aren't judged (checkLua). */
export async function mapLuaNames(read: (path: string) => Promise<string>, scripts: readonly (string | null)[]): Promise<Set<string> | null> {
  return luaKnownNames(await gameLuaApi(read), scripts.filter((s): s is string => s !== null));
}
