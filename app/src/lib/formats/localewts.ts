// A map's per-language string tables (`map/_Locales/deDE.w3mod/war3map.wts`, one per language; the game's own melee maps
// carry eleven, each a full copy of war3map.wts with every number translated or not). Every tool that makes or renumbers
// strings of war3map.wts treats them the same way (Move Texts lib/formats/movetexts, the Sound Editor's dialogue
// strings, Adjust Map String IDs in the Trigger Editor):
// - a new string goes past every number of every table, so a string only a language has never shows in its place, and
//   goes into every table too, with the same text and comment (to be translated there; a table that replaces
//   war3map.wts whole would otherwise show the bare reference);
// - a renumbered string gets its new number in every table that has it, and no string takes a number only a language
//   has (those strings keep their numbers: something may name them, and a translation is never thrown away);
// - a table's own bytes stay as they are (its line ends included), so a table nothing changes is written byte for byte.
// The World Editor does none of it: its save leaves a listed table byte for byte (see movetexts.ts's header).

import { appendStrings, checkStringIds, renumberWts, StringTable, type NewString } from "./wts";

/** A language's string table in the project (`map/_Locales/deDE.w3mod/war3map.wts`), any case. */
export const LOCALE_WTS = /^map\/_locales\/[^/]+\.w3mod\/war3map\.wts$/i;

/** Whether a project path is a language's string table (either slash). */
export const isLocaleWts = (path: string) => LOCALE_WTS.test(path.replace(/\\/g, "/"));

/** The line ends new blocks get: the table's own, CRLF for a new table or one of a single line (as the editor writes). */
export const wtsEol = (wts: string | null) => (wts === null || wts.includes("\r\n") || !wts.includes("\n") ? "\r\n" : "\n");

/** Every string number of the tables, added to `into`: a new string goes past them. */
export function localeNumbers(tables: Iterable<string | StringTable>, into = new Set<number>()): Set<number> {
  for (const t of tables) for (const [n] of (typeof t === "string" ? new StringTable(t) : t).entries()) into.add(n);
  return into;
}

/** The numbers some language's table has and `main` (war3map.wts; null: none) lacks, each with the first table's path
 *  that has it: no other string may take one. */
export function localeOnlyNumbers(main: StringTable | null, locales: readonly { path: string; wts: string }[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of locales) {
    for (const [n] of new StringTable(l.wts).entries()) if (!main?.has(n) && !out.has(n)) out.set(n, l.path);
  }
  return out;
}

/** The languages' tables renumbered as war3map.wts is (`ids`, checked with wts checkStringIds and localeOnlyNumbers):
 *  only those that change, each with only its STRING headers' digits changed (wts renumberWts). Throws rather than give
 *  a table in which a string doesn't read back under its new number. */
export function renumberLocaleTables(locales: readonly { path: string; wts: string }[], ids: ReadonlyMap<number, number>): { path: string; wts: string }[] {
  const out: { path: string; wts: string }[] = [];
  for (const l of locales) {
    const wts = renumberWts(l.wts, ids);
    if (wts === l.wts) continue;
    const before = new StringTable(l.wts), back = new StringTable(wts);
    const numbers = new Set<number>();
    for (const [n, v] of before.entries()) {
      const to = ids.get(n) ?? n;
      if (numbers.has(to) || back.get(to) !== v) throw new Error(`string ${n} of ${l.path} wouldn't read back as string ${to}; nothing was changed.`);
      numbers.add(to);
    }
    out.push({ path: l.path, wts });
  }
  return out;
}

/** Adjust Map String IDs on war3map.wts (`wts`) and the languages' tables: `ids` checked against them (wts
 *  checkStringIds, with `reserved` and the languages' own numbers; throws why), then war3map.wts renumbered and the
 *  languages' tables that change. */
export function adjustStringTables(wts: string, locales: readonly { path: string; wts: string }[], ids: ReadonlyMap<number, number>,
  reserved: ReadonlySet<number> = new Set()): { wts: string; locales: { path: string; wts: string }[] } {
  const table = new StringTable(wts);
  checkStringIds(table, ids, reserved, localeOnlyNumbers(table, locales));
  return { wts: renumberWts(wts, ids), locales: renumberLocaleTables(locales, ids) };
}

/** `wts` (the table at `path`) with `blocks` added at its end, in its own line ends; everything before stays byte for
 *  byte. A number the table already has with the same text is left as it is; one with another text throws (something
 *  else took the number meanwhile). Throws rather than give a table that doesn't read back as it should. */
export function addLocaleStrings(path: string, wts: string, blocks: readonly NewString[]): string {
  const table = new StringTable(wts);
  const norm = (s: string | undefined) => s?.replace(/\r\n/g, "\n");
  const add: NewString[] = [];
  for (const b of blocks) {
    if (!table.has(b.num)) { add.push(b); continue; }
    if (norm(table.get(b.num)) !== norm(b.text)) throw new Error(`string ${b.num} is in ${path} already, with another text; nothing was changed.`);
  }
  if (!add.length) return wts;
  const out = appendStrings(wts, add, wtsEol(wts));
  const back = new StringTable(out);
  for (const b of add) {
    if (norm(back.get(b.num)) !== norm(b.text)) throw new Error(`string ${b.num} wouldn't read back as written in ${path}; nothing was changed.`);
  }
  for (const [n, v] of table.entries()) {
    if (back.get(n) !== v) throw new Error(`string ${n} of ${path} wouldn't stay as it is; nothing was changed.`);
  }
  return out;
}
