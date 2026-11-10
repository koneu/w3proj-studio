// The game's skin tables (Units\UnitSkin.txt & co.) split some fields per art set: `file:hd`, `file:sd`, `file:de`
// next to or instead of a plain `file`. Which key a graphics mode reads, in order.

/** The keys of `key` the graphics mode `mode` ("sd", "hd", "de") reads, first found wins: its own, the plain one,
 *  then Classic's. The 3.0 art (DE) falls back to Classic as its storage layers do (`_de.w3mod`, then the base game):
 *  16 of the game's unit types name only `file:hd` and `file:sd` (the Ogre Lord nogl among them), and
 *  with neither `file:de` nor `file` they had no model in DE at all. */
export function artKeys(key: string, mode: string): string[] {
  const keys = [`${key}:${mode}`, key, `${key}:sd`];
  return keys.filter((k, i) => keys.indexOf(k) === i);
}

/** The value of a skin table's `key` in graphics mode `mode` (see artKeys); `get` reads one key of the entry. */
export function artValue(get: (key: string) => string | undefined, key: string, mode: string): string | undefined {
  for (const k of artKeys(key, mode)) {
    const v = get(k);
    if (v !== undefined) return v;
  }
  return undefined;
}
