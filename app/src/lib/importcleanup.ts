// The Import Manager's "Clean up import list": what it changes in an import list (war3map.imp, war3campaign.imp) so
// that the list names exactly the files the map holds. Entries without a name (some tools store the list blank and
// name the files only in the archive's (listfile)) and entries whose file is neither in the map nor provided by the
// game go; files of the map folder the list doesn't name (lib/imports.ts unlistedFiles, the rule the Problems view and
// the Import Manager use) come in, with the flags new imports get. Pure: the caller previews and applies it.

import { archivePath, entryCandidates, gameLookupName, entryFile, newEntryFlags, unlistedFiles, type ImportEntry } from "./imports";

/** Why an entry leaves the list. */
export type DropReason = "blank" | "missing";

/** What a clean-up does to a list. */
export interface ImportCleanup {
  /** Entries that go, with their place in the list (ascending). */
  drop: { entry: ImportEntry; index: number; reason: DropReason }[];
  /** Entries whose file isn't in the map but the game provides (Blizzard's maps list such), or a chapter map's
   *  campaign: they stay. */
  keptProvided: ImportEntry[];
  /** New entries, for files of the map folder the list doesn't name (by archive path, case-insensitively sorted). */
  add: ImportEntry[];
}

/** An entry stored without a name. */
export const isBlankEntry = (e: ImportEntry) => e.path === "";

/** The archive names the game may provide an entry's file under (its candidates: the import folder for standard-path
 *  entries, a sound's other extensions), in the game's layer form (gameLookupName: `_HD.w3mod:Units\…`). */
export function entryGameNames(e: ImportEntry, folder: string): string[] {
  return [...new Set(entryCandidates(e, folder).map((c) => gameLookupName(archivePath(c))))];
}

const lowerIndex = (projectFiles: readonly string[]) => {
  const byLower = new Map<string, string>();
  for (const raw of projectFiles) {
    const p = raw.replace(/\\/g, "/");
    if (!byLower.has(p.toLowerCase())) byLower.set(p.toLowerCase(), p);
  }
  return byLower;
};

/** The named entries whose file isn't in the project (`projectFiles`: "map/…" paths): the ones to look up in the game. */
export function entriesWithoutFile(projectFiles: readonly string[], entries: readonly ImportEntry[], folder: string): ImportEntry[] {
  const byLower = lowerIndex(projectFiles);
  return entries.filter((e) => !isBlankEntry(e) && entryFile(e, folder, (l) => byLower.get(l)) === undefined);
}

/** The clean-up of `entries` against the project's files (`projectFiles`: "map/…" paths). `provided` says whether
 *  the game (see entryGameNames) or a chapter map's campaign has the file of an entry the map lacks; such entries stay. */
export function importCleanup(projectFiles: readonly string[], entries: readonly ImportEntry[], folder: string,
  provided: (e: ImportEntry) => boolean = () => false): ImportCleanup {
  const byLower = lowerIndex(projectFiles);
  const drop: ImportCleanup["drop"] = [];
  const keptProvided: ImportEntry[] = [];
  entries.forEach((entry, index) => {
    if (isBlankEntry(entry)) { drop.push({ entry, index, reason: "blank" }); return; }
    if (entryFile(entry, folder, (l) => byLower.get(l)) !== undefined) return;
    if (provided(entry)) keptProvided.push(entry);
    else drop.push({ entry, index, reason: "missing" });
  });
  const gone = new Set(drop.map((d) => d.entry));
  const remaining = entries.filter((e) => !gone.has(e));
  // One entry per archive path: two project files differing only in case are one file in the archive.
  const seen = new Set<string>();
  const add = unlistedFiles(projectFiles, remaining, folder).map(archivePath)
    .filter((p) => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; })
    .map((path) => ({ flags: newEntryFlags(path), path }));
  return { drop, keptProvided, add };
}

/** Whether a clean-up changes nothing. */
export const cleanupIsEmpty = (c: ImportCleanup) => !c.drop.length && !c.add.length;

/** The list after a clean-up: the entries that stay, in their order (the same objects), then the new ones. */
export function cleanedList(entries: readonly ImportEntry[], c: ImportCleanup): ImportEntry[] {
  const gone = new Set(c.drop.map((d) => d.entry));
  return [...entries.filter((e) => !gone.has(e)), ...c.add];
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The preview's text: what goes and what comes, with up to `max` names of each (none for 0). */
export function cleanupSummary(c: ImportCleanup, max = 6): string {
  const blank = c.drop.filter((d) => d.reason === "blank").length;
  const missing = c.drop.filter((d) => d.reason === "missing").map((d) => d.entry.path);
  const some = (paths: string[]) => (max <= 0 ? "" : ` (${paths.slice(0, max).join(", ")}${paths.length > max ? `, and ${paths.length - max} more` : ""})`);
  const parts: string[] = [];
  if (blank) parts.push(`remove ${count(blank, "entry", "entries")} without a name`);
  if (missing.length) parts.push(`remove ${count(missing.length, "entry", "entries")} whose file isn't in the map${some(missing)}`);
  if (c.add.length) parts.push(`add ${count(c.add.length, "file", "files")} of the map that ${c.add.length === 1 ? "isn't" : "aren't"} listed${some(c.add.map((e) => e.path))}`);
  const kept = c.keptProvided.length ? ` ${count(c.keptProvided.length, "entry names a file", "entries name files")} the game or the campaign provides; kept.` : "";
  if (!parts.length) return `The import list names exactly the map's files: nothing to clean up.${kept}`;
  return `Clean up the import list: ${parts.join("; ")}.${kept}`;
}
