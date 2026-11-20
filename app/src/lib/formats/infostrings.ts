// war3map.w3i's plain texts as the World Editor turns them into strings of the map's table (war3map.wts): Map Size does
// it for every text field the table can hold (lib/terrain/resize.ts infoAfterResize), every save for the players' and
// the forces' names (namesToStrings).

import { wtsCutLines } from "./wts";

/** A string to add to the map's table: its number and text. */
export interface InfoString { num: number; text: string }

/** A text that already is a reference to the string table. */
const REF = /^TRIGSTR_\d+$/;

/** Each `[owner, key]` whose value is plain, non-empty text becomes a reference to a new string with that text,
 *  numbered on from `first` in the order given (TRIGSTR_ and three digits at least, as the editor writes them). An
 *  empty text, a reference already and an owner that isn't an object stay. Changes the owners in place; gives the new
 *  strings (CRLF breaks as LF, as the table holds them). With `reuse` (text to number, LF breaks), a text found there
 *  refers to that string instead, and each new string joins it, so a text met again refers to the first one made.
 *  `keepPlain`: a text it says yes to stays plain too (one a string table can't hold, see namesToStrings). */
export function textsToStrings(fields: readonly (readonly [unknown, string])[], first: number, reuse?: Map<string, number>,
  keepPlain?: (text: string) => boolean): InfoString[] {
  const added: InfoString[] = [];
  for (const [owner, key] of fields) {
    if (!owner || typeof owner !== "object") continue;
    const o = owner as Record<string, unknown>, text = o[key];
    if (typeof text !== "string" || text === "" || REF.test(text) || keepPlain?.(text)) continue;
    const lf = text.replace(/\r\n/g, "\n");
    let num = reuse?.get(lf);
    if (num === undefined) {
      num = first + added.length;
      added.push({ num, text: lf });
      reuse?.set(lf, num);
    }
    o[key] = `TRIGSTR_${String(num).padStart(3, "0")}`;
  }
  return added;
}

/** The players' and the forces' names of war3map.w3i (`info`) as the World Editor's save leaves them (we-compare
 *  plain-names-a and -b, branch we-compare-16, 2026-11-19: open and save, no other step): every plain, non-empty name
 *  becomes a new string, numbered on from the table's highest (3, 4, 5 after 1 and 2), the players' in their order
 *  first, then the forces'; an empty name and a TRIGSTR_ reference stay. The map's other texts stay plain (Map Size
 *  takes those: infoAfterResize). Changes `info` in place; gives the new strings for the caller to add to the tables.
 *
 *  `table` (the map's string table, number and text) is the save's: a name whose text, case and all, is a string of
 *  the table or one this call made refers to that string (of several, the lowest number: not measured) (plain-names-c and
 *  studio-paths-matrix-masks, branch we-compare-17, 2026-11-19: players Twin, Twin, Player 1, twin and forces Twin,
 *  Force 1, Lone with the table's 2 "Force 1" saved as 3, 3, 4, 5 and 3, 2, 6). Without it every plain name gets a
 *  string of its own (Map Size's, which wasn't measured with repeated texts). `keepPlain`: a name it says yes to stays
 *  plain (the pack passes tableCantHold: a name with a `}` can't be held by war3map.wts). */
export function namesToStrings(info: Record<string, unknown>, first: number, table?: Iterable<readonly [number, string]>,
  keepPlain?: (text: string) => boolean): InfoString[] {
  const players = Array.isArray(info.players) ? info.players : [];
  const forces = Array.isArray(info.forces) ? info.forces : [];
  let reuse: Map<string, number> | undefined;
  if (table) {
    reuse = new Map();
    for (const [num, text] of table) {
      const lf = text.replace(/\r\n/g, "\n");
      const had = reuse.get(lf);
      if (had === undefined || num < had) reuse.set(lf, num);
    }
  }
  return textsToStrings([...players.map((p) => [p, "name"] as const), ...forces.map((f) => [f, "name"] as const)], first, reuse, keepPlain);
}

/** Whether a string table can't hold `text`: the game and the World Editor end a string at its first `}` (wts
 *  wtsCutLines: there is no way to keep one), so such a name stays plain in war3map.w3i, where it is read whole. */
export const tableCantHold = (text: string): boolean => wtsCutLines(text).length > 0;

/** The players' and forces' plain names a string table can't hold (tableCantHold), named for a message: "Player 2's
 *  name" (by the player's number), "Force 1's name" (by its place). */
export function namesTableCantHold(info: Record<string, unknown>): string[] {
  const out: string[] = [];
  const plain = (o: unknown): o is { name: string } => {
    const name = (o as { name?: unknown } | null)?.name;
    return typeof name === "string" && name !== "" && !REF.test(name) && tableCantHold(name);
  };
  (Array.isArray(info.players) ? info.players : []).forEach((p: unknown, i) => {
    const id = (p as { id?: unknown } | null)?.id;
    if (plain(p)) out.push(`Player ${typeof id === "number" && Number.isSafeInteger(id) ? id + 1 : i + 1}'s name`);
  });
  (Array.isArray(info.forces) ? info.forces : []).forEach((f: unknown, i) => { if (plain(f)) out.push(`Force ${i + 1}'s name`); });
  return out;
}
