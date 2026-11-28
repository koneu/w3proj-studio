// The game's skin tables (Units\UnitSkin.txt & co.) split some fields per art set: `file:hd`, `file:sd`, `file:de`
// next to or instead of a plain `file`. Which key a graphics mode reads, in order.

/** The keys of `key` the graphics mode `mode` ("sd", "hd", "de") reads, first found wins: its own, the plain one,
 *  then Classic's. The 3.0 art (DE) falls back to Classic as its storage layers do (`_de.w3mod`, then the base game):
 *  16 of the game's unit types name only `file:hd` and `file:sd` (the Ogre Lord nogl among them), and
 *  with neither `file:de` nor `file` they had no model in DE at all.
 *
 *  `hdFirst` (doodads and destructables): the 3.0 art reads the HD key right after its own. The World Editor's DE
 *  view draws such a type with its HD art when it names no DE art (we-drive 2026-11-28: eight doodads and
 *  destructables whose `file:hd` is another model than their plain `file`, which the DE layers store too, the Ruins
 *  and Barrens canopy trees ZTtc and BTtc, the Silvermoon tree Yts1, King Terenas' statue YOss, the archway entrance
 *  YSa2, the lion statue BTs2, the high elf banner HEcs and the tulips ZPf0, all showed their HD model). Units weren't
 *  measured. */
export function artKeys(key: string, mode: string, hdFirst = false): string[] {
  const keys = mode === "de" && hdFirst ? [`${key}:de`, `${key}:hd`, key, `${key}:sd`] : [`${key}:${mode}`, key, `${key}:sd`];
  return keys.filter((k, i) => keys.indexOf(k) === i);
}

/** The 3.0 art's (DE) other value of an entry without `key:de`, read when the first one's file isn't stored in the DE
 *  set. Without `hdFirst`: its HD art (`key:hd`) behind the Classic one artKeys reads (the new Reforged doodads EW00,
 *  ET00 and EMt0 name a plain `file` no DE layer holds). With `hdFirst`: its Classic value (the plain key, else
 *  `key:sd`) behind the HD one. Undefined in other modes, when the entry has its own `key:de`, or no `key:hd`. */
export function reforgedArt(get: (key: string) => string | undefined, key: string, mode: string, hdFirst = false): string | undefined {
  if (mode !== "de" || get(`${key}:de`) !== undefined || get(`${key}:hd`) === undefined) return undefined;
  return hdFirst ? get(key) ?? get(`${key}:sd`) : get(`${key}:hd`);
}

/** The value of a skin table's `key` in graphics mode `mode` (see artKeys); `get` reads one key of the entry. */
export function artValue(get: (key: string) => string | undefined, key: string, mode: string, hdFirst = false): string | undefined {
  for (const k of artKeys(key, mode, hdFirst)) {
    const v = get(k);
    if (v !== undefined) return v;
  }
  return undefined;
}
