// How the Import Manager's list is shown: sorted by a column and filtered. View state only; the import list (its
// entries and their order) is never touched. Pure, so tests need no app.

import { kindOf, rowEntries, type ImportRow, type Side } from "../../lib/imports";

export type SortKey = "path" | "type" | "size";
export interface Sort { key: SortKey; dir: 1 | -1 }

/** What a row is sorted and filtered by. */
export interface RowFacts { row: ImportRow; size: number }

/** A filter: a choice list (the first value, "", is "all"); `test` says whether a row passes a chosen value. More
 *  filters (Teen, Locale) are entries of FILTERS; the toolbar and the counting follow. */
export interface RowFilter { id: string; label: string; options: { value: string; label: string; title?: string }[]; test(f: RowFacts, value: string): boolean }

const MODE_OPTIONS: { value: Side; label: string; title: string }[] = [
  { value: "classic", label: "SD (plain path)", title: "Files with a version at the plain path, which Classic reads" },
  { value: "reforged", label: "HD (_HD.w3mod)", title: "Files with a Reforged version below _HD.w3mod\\" },
  { value: "de", label: "3.0 (_DE.w3mod)", title: "Files with a 3.0 version below _DE.w3mod\\" }];

/** The file types the list can be filtered by: those the rows hold, by kindOf, alphabetical. */
export function typeOptions(rows: readonly ImportRow[]): string[] {
  return [...new Set(rows.map((r) => kindOf(r.path)))].sort((a, b) => a.localeCompare(b));
}

export const FILTERS: RowFilter[] = [
  { id: "mode", label: "Mode", options: [{ value: "", label: "All modes" }, ...MODE_OPTIONS],
    test: (f, v) => !v || !!f.row[v as Side] },
  // The options of "type" are the types present (typeOptions).
  { id: "type", label: "Type", options: [{ value: "", label: "All types" }], test: (f, v) => !v || kindOf(f.row.path) === v },
];

/** The chosen value per filter id; a missing one is "all". */
export type FilterValues = Record<string, string | undefined>;

export const passes = (f: RowFacts, values: FilterValues): boolean => FILTERS.every((x) => x.test(f, values[x.id] ?? ""));

/** The clicked header: the same column again reverses, another one sorts ascending. */
export function nextSort(cur: Sort | null, key: SortKey): Sort {
  return cur?.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 };
}

/** `facts` sorted (a new array; equal rows keep their list order). No sort: as given. */
export function sortRows(facts: readonly RowFacts[], sort: Sort | null): RowFacts[] {
  const out = [...facts];
  if (!sort) return out;
  const text = (f: RowFacts) => f.row.path.toLowerCase();
  const cmp = (a: RowFacts, b: RowFacts): number => {
    if (sort.key === "size") return a.size - b.size || text(a).localeCompare(text(b));
    if (sort.key === "type") return kindOf(a.row.path).localeCompare(kindOf(b.row.path)) || text(a).localeCompare(text(b));
    return text(a).localeCompare(text(b));
  };
  // Array.prototype.sort is stable: ties keep the list order.
  return out.sort((a, b) => sort.dir * cmp(a, b));
}

/** The entries and bytes of `facts` (what the count line adds up). */
export function totals(facts: readonly RowFacts[]): { entries: number; size: number } {
  return { entries: facts.reduce((n, f) => n + rowEntries(f.row).length, 0), size: facts.reduce((n, f) => n + f.size, 0) };
}
