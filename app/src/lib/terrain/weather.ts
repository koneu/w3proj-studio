// Weather effects' names. Weather.slk names them by WorldEditStrings keys; the ground splashes of
// the rain effects have keys the game doesn't define (…HEAVYRAINSPLASH beside …HEAVYRAIN).

/** The name of a Weather.slk row: `strings` has upper-case keys. */
export function weatherName(key: string | undefined, id: string, strings: ReadonlyMap<string, string>): string {
  if (!key) return id;
  const k = key.toUpperCase();
  const own = strings.get(k);
  if (own !== undefined) return own.replace(/&/g, "");
  const base = k.endsWith("SPLASH") ? strings.get(k.slice(0, -"SPLASH".length)) : undefined;
  return base !== undefined ? `${base.replace(/&/g, "")} – splash` : k.startsWith("WESTRING_") ? id : key;
}
