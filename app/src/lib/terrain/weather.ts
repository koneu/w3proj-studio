// Weather effects' names. Weather.slk names them by WorldEditStrings keys. The game names the rains' ground
// splashes itself (WESTRING_WEATHER_LORDAERONHEAVYRAINSPLASH="Lordaeron Rain (Heavy, Splash)"); a splash whose key
// a game's strings lack is named after its rain the same way.

import { lookupWestring } from "../formats/text";

/** The name of a Weather.slk row: `strings` has upper-case keys. */
export function weatherName(key: string | undefined, id: string, strings: ReadonlyMap<string, string>): string {
  if (!key) return id;
  const k = key.toUpperCase();
  const own = lookupWestring(strings, k);
  if (own !== undefined) return own.replace(/&/g, "");
  const base = k.endsWith("SPLASH") ? lookupWestring(strings, k.slice(0, -"SPLASH".length)) : undefined;
  return base !== undefined ? splashName(base.replace(/&/g, "")) : k.startsWith("WESTRING_") ? id : key;
}

/** "Rain (Heavy)" becomes "Rain (Heavy, Splash)", "Rain" "Rain (Splash)": the game's own splash names. */
function splashName(rain: string): string {
  const m = /^(.*)\)\s*$/.exec(rain);
  return m && m[1].includes("(") ? `${m[1]}, Splash)` : `${rain} (Splash)`;
}
