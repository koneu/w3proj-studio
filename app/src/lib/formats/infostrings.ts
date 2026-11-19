// war3map.w3i's plain texts as the World Editor turns them into strings of the map's table (war3map.wts): Map Size does
// it for every text field the table can hold (lib/terrain/resize.ts infoAfterResize), every save for the players' and
// the forces' names (namesToStrings).

/** A string to add to the map's table: its number and text. */
export interface InfoString { num: number; text: string }

/** A text that already is a reference to the string table. */
const REF = /^TRIGSTR_\d+$/;

/** Each `[owner, key]` whose value is plain, non-empty text becomes a reference to a new string with that text,
 *  numbered on from `first` in the order given (TRIGSTR_ and three digits at least, as the editor writes them). An
 *  empty text, a reference already and an owner that isn't an object stay. Changes the owners in place; gives the new
 *  strings (CRLF breaks as LF, as the table holds them). */
export function textsToStrings(fields: readonly (readonly [unknown, string])[], first: number): InfoString[] {
  const added: InfoString[] = [];
  for (const [owner, key] of fields) {
    if (!owner || typeof owner !== "object") continue;
    const o = owner as Record<string, unknown>, text = o[key];
    if (typeof text !== "string" || text === "" || REF.test(text)) continue;
    const num = first + added.length;
    added.push({ num, text: text.replace(/\r\n/g, "\n") });
    o[key] = `TRIGSTR_${String(num).padStart(3, "0")}`;
  }
  return added;
}

/** The players' and the forces' names of war3map.w3i (`info`) as the World Editor's save leaves them (we-compare
 *  plain-names-a and -b, branch we-compare-16, 2026-11-19: open and save, no other step): every plain, non-empty name
 *  becomes a new string, numbered on from the table's highest (3, 4, 5 after 1 and 2), the players' in their order
 *  first, then the forces'; an empty name and a TRIGSTR_ reference stay. The map's other texts stay plain (Map Size
 *  takes those: infoAfterResize). Changes `info` in place; gives the new strings for the caller to add to the tables. */
export function namesToStrings(info: Record<string, unknown>, first: number): InfoString[] {
  const players = Array.isArray(info.players) ? info.players : [];
  const forces = Array.isArray(info.forces) ? info.forces : [];
  return textsToStrings([...players.map((p) => [p, "name"] as const), ...forces.map((f) => [f, "name"] as const)], first);
}
