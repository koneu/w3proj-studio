// What packing (and Move Texts) dropped from war3map.wts as unused, kept in the project (.w3proj/pruned-strings.json):
// the text by number. An editor's undo after the drop can bring a reference to such a string back (an object deleted,
// the map packed, the deletion undone in the Object Editor); the next pack then puts the string back with its old
// number and text before it drops anything (restorePrunedStrings). While a number is recorded no new string takes it
// (Move Texts and the Sound Editor number after the recorded ones too), so a reference that comes back never shows
// another text.
//
// The record holds the strings that are gone: a number that is in the table again (restored, or the drop undone with
// "MCP: Undo Last AI Edit") leaves it on the next drop (updatePrunedRecord). It is written before the table, so a
// string is never gone without being recorded; a record that names a string still there is harmless. Chapter maps and
// war3campaign.wts aren't pruned, so they have no record.

import type { W3Api } from "../../extensions/api";
import { isNotFoundError } from "../oserror";
import { StringTable, appendStrings } from "./wts";

export const PRUNED_STRINGS_FILE = ".w3proj/pruned-strings.json";
const FORMAT = "w3proj.prunedStrings/1";

/** The record in a file's text; throws when it isn't one (never taken for an empty record). */
export function parsePrunedStrings(text: string): Map<number, string> {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new Error(`${PRUNED_STRINGS_FILE} isn't valid JSON.`); }
  const strings = (doc as { format?: unknown; strings?: unknown } | null);
  if (!strings || strings.format !== FORMAT || typeof strings.strings !== "object" || strings.strings === null || Array.isArray(strings.strings)) {
    throw new Error(`${PRUNED_STRINGS_FILE} isn't a record of pruned strings (${FORMAT}).`);
  }
  const out = new Map<number, string>();
  for (const [k, v] of Object.entries(strings.strings as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || !Number.isSafeInteger(Number(k)) || typeof v !== "string") {
      throw new Error(`${PRUNED_STRINGS_FILE} has an entry that isn't a string number with its text (${JSON.stringify(k)}).`);
    }
    out.set(Number(k), v);
  }
  return out;
}

/** The file's text: numbers ascending, one per line in a diff. */
export function serializePrunedStrings(record: ReadonlyMap<number, string>): string {
  const strings: Record<string, string> = {};
  for (const n of [...record.keys()].sort((a, b) => a - b)) strings[String(n)] = record.get(n)!;
  return JSON.stringify({ format: FORMAT, strings }, null, 2) + "\n";
}

/** The project's record: empty when the file isn't there; throws when it is there and can't be read. */
export async function readPrunedStrings(w3: W3Api): Promise<Map<number, string>> {
  let text: string;
  try {
    text = await w3.workspace.readText(PRUNED_STRINGS_FILE);
  } catch (e) {
    if (isNotFoundError(e)) return new Map();
    throw new Error(`${PRUNED_STRINGS_FILE} is there but can't be read (${e instanceof Error ? e.message : String(e)}).`);
  }
  return parsePrunedStrings(text);
}

/** `wts` with the recorded strings that `referenced` names again and the table lacks put back at the end, with their old
 *  numbers and texts (as the World Editor writes a block). `restored`: their numbers, ascending; none gives `wts`
 *  itself. Throws rather than give a table that doesn't read back as it should. */
export function restorePrunedStrings(wts: string, record: ReadonlyMap<number, string>, referenced: ReadonlySet<number>): { text: string; restored: number[] } {
  const table = new StringTable(wts);
  const restored = [...record.keys()].filter((n) => referenced.has(n) && !table.has(n)).sort((a, b) => a - b);
  if (!restored.length) return { text: wts, restored };
  const eol = wts.includes("\r\n") || !wts.includes("\n") ? "\r\n" : "\n";
  const text = appendStrings(wts, restored.map((num) => ({ num, text: record.get(num)!.replace(/\r\n/g, "\n") })), eol);
  const back = new StringTable(text);
  for (const n of restored) {
    if (back.get(n)?.replace(/\r\n/g, "\n") !== record.get(n)!.replace(/\r\n/g, "\n")) throw new Error(`pruned string ${n} wouldn't read back as it was; nothing was restored.`);
  }
  for (const [n, v] of table.entries()) if (back.get(n) !== v) throw new Error(`string ${n} wouldn't stay as it is; nothing was restored.`);
  return { text, restored };
}

/** The record after a drop: `dropped` taken from `before` (the table as it was, texts with "\n"), every number that is
 *  in `after` (the table now) left out. Null when it stays as it is. */
export function updatePrunedRecord(record: ReadonlyMap<number, string>, before: string, dropped: readonly number[], after: string): Map<number, string> | null {
  const was = new StringTable(before), now = new StringTable(after);
  const out = new Map(record);
  for (const n of dropped) {
    const v = was.get(n);
    if (v !== undefined) out.set(n, v.replace(/\r\n/g, "\n"));
  }
  for (const [n] of now.entries()) out.delete(n);
  const same = out.size === record.size && [...out].every(([n, v]) => record.get(n) === v);
  return same ? null : out;
}

/** Records the strings a drop took out of the project's war3map.wts (`before` → `after`). Call it before the table is
 *  written. Throws when the record is there and can't be read: then the table mustn't be written either. */
export async function recordPrunedStrings(w3: W3Api, before: string, dropped: readonly number[], after: string, record?: ReadonlyMap<number, string>) {
  const next = updatePrunedRecord(record ?? (await readPrunedStrings(w3)), before, dropped, after);
  if (next) await w3.workspace.writeText(PRUNED_STRINGS_FILE, serializePrunedStrings(next));
}
