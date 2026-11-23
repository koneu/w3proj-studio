// The players' and the forces' plain names become strings of war3map.wts when the map is packed, as the World Editor's
// save gives them (we-compare plain-names, 2026-11-19: open and save, nothing else; lib/formats/infostrings
// namesToStrings), in the project too. Numbered on from every number the map's files, the languages' tables and the
// record of dropped strings take (as Map Size's strings, terrain-viewer resizeFirstString), each new string added to
// every language's table as well (lib/formats/localewts addLocaleStrings). A campaign's chapter maps
// (`maps/<chapter>/`, each a project of its own) get the same, each from its own files and tables: they are maps the
// editor saved.
//
// A name with a `}` stays plain: the game and the editor end a string of war3map.wts at its first `}` and there is no
// way to keep one (lib/formats/wts wtsCutLines), while war3map.w3i holds the name whole. The outcome names those fields.
//
// A map without war3map.wts: a TRIGSTR_ reference among the texts the editor reads (the names, the map's texts) has no
// string, and the editor's save writes it as "" (we-compare studio-paths-nowts; infostrings blankStringlessTexts). So
// does this, in the same edit, without making a table when no name needs one. With a war3map.wts such a reference stays.
//
// One undoable edit (the MCP edit log, like Drop Unused Strings, which runs after it), after every editor is saved and
// the map script settled; nothing while anything is still unsaved, nothing without the edit log, and nothing when
// war3map.w3i is kept raw (left as it is, as the placing tools do). A file that is there but can't be read stops it
// (nothing is changed): never taken for an empty one.

import type { W3Api } from "../../extensions/api";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { blankStringlessTexts, namesTableCantHold, namesToStrings, tableCantHold, type InfoString } from "../../lib/formats/infostrings";
import { addLocaleStrings, isLocaleWts } from "../../lib/formats/localewts";
import { stringNumbersTaken } from "../../lib/formats/mapdoc";
import { StringTable } from "../../lib/formats/wts";
import { joinPath } from "../../lib/paths";

const WTS = "map/war3map.wts";
const INFO_JSON = "map/war3map.w3i.json";
/** A chapter map's war3map.w3i in a campaign project: `maps/<chapter>/map/war3map.w3i.json`. */
const CHAPTER_INFO = /^(maps\/[^/]+\/)map\/war3map\.w3i\.json$/i;

/** A chapter map's part of the outcome: its folder (`maps/<chapter>`) and, as for the project's own map, the new
 *  strings' numbers and how many names now refer to a string its table had. */
export interface ChapterNames { folder: string; added: number[]; reused: number; blanked?: number[] }

/** `added`: the new strings' numbers; `reused`: how many names now refer to a string the table had already (or one
 *  added for an earlier name); `kept`: why nothing was looked at (unsaved editors, no edit log), else null. Both of the
 *  project's own map. `plainKept`: the names left plain because a string table can't hold them ("Player 2's name",
 *  "maps/Chapter 1: Force 1's name"); `blanked`: the numbers of the stringless references written as "" (no
 *  war3map.wts); `chapters`: the chapter maps that changed. Each only when there is one. */
export interface NameStringsOutcome { added: number[]; reused: number; kept: string | null; plainKept?: string[]; blanked?: number[]; chapters?: ChapterNames[] }

/** The workspace as a chapter map's own project sees it (paths without `prefix`, its folder as the root): what
 *  stringNumbersTaken reads goes to the chapter's files, its record of dropped strings included. */
function chapterView(w3: W3Api, prefix: string): W3Api {
  const ws = w3.workspace;
  const workspace = {
    project: () => { const p = ws.project(); return p ? { ...p, root: joinPath(p.root, prefix) } : null; },
    files: () => ws.files().filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) })),
    readText: (p: string) => ws.readText(prefix + p),
    readBytes: (p: string) => ws.readBytes(prefix + p),
    resolve: (p: string) => ws.resolve(prefix + p),
  };
  return { ...w3, workspace } as unknown as W3Api;
}

/** One map's change (`prefix`: "" for the project's own, `maps/<chapter>/` for a chapter): the files to write (tables
 *  first, then the w3i), the new strings, how many names were plain, and the names kept plain. */
async function mapNames(w3: W3Api, root: string, prefix: string, read: (p: string) => Promise<string | null>, listed: string[]):
  Promise<{ out: { path: string; text: string }[]; added: InfoString[]; plain: number; plainKept: string[]; blanked: number[] }> {
  const none = { out: [], added: [], plain: 0, plainKept: [], blanked: [] };
  const changed = () => { if (w3.workspace.project()?.root !== root) throw new Error("the project changed meanwhile"); };
  const infoPath = prefix + INFO_JSON, wtsPath = prefix + WTS;
  // Absent is nothing to do; there but unreadable (or not JSON) throws.
  const text = await read(infoPath);
  if (text === null) return none;
  let info: unknown;
  try { info = JSON.parse(text); } catch { throw new Error(`${infoPath} is there but can't be read`); }
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error(`${infoPath} is there but can't be read`);
  const plainKept = namesTableCantHold(info as Record<string, unknown>).map((n) => (prefix ? `${prefix.slice(0, -1)}: ${n}` : n));
  const wts = await read(wtsPath);
  // No war3map.wts: a TRIGSTR_ reference among the texts the editor reads has no string, and its save writes "".
  const blanked = wts === null ? blankStringlessTexts(info as Record<string, unknown>, () => false) : [];
  const plain = namesToStrings(JSON.parse(JSON.stringify(info)) as Record<string, unknown>, 1, undefined, tableCantHold).length;
  // Nothing plain and nothing blanked: nothing else is read.
  if (!plain && !blanked.length) return { ...none, plainKept };
  if (!plain) {
    // Only war3map.w3i changes: no table is made from nothing (the editor makes none either).
    const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root: prefix ? joinPath(root, prefix) : root, path: INFO_JSON, text: JSON.stringify(info) });
    changed();
    return { out: [{ path: infoPath, text: canonical }], added: [], plain: 0, plainKept, blanked };
  }
  const own = prefix ? listed.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)) : listed;
  const taken = await stringNumbersTaken(prefix ? chapterView(w3, prefix) : w3, own);
  for (const [n] of wts === null ? [] : new StringTable(wts).entries()) taken.add(n);
  let max = 0;
  for (const n of taken) max = Math.max(max, n);
  changed();
  // A name whose text the table has already refers to that string (a name met twice to one string).
  const added = namesToStrings(info as Record<string, unknown>, max + 1, wts === null ? [] : new StringTable(wts).entries(), tableCantHold);
  // The tables first, then the file that refers to their new strings.
  const out: { path: string; text: string }[] = [];
  for (const path of own.filter(isLocaleWts)) {
    const table = await read(prefix + path);
    if (table === null) continue;
    const next = addLocaleStrings(prefix + path, table, added);
    if (next !== table) out.push({ path: prefix + path, text: next });
  }
  out.push({ path: wtsPath, text: addLocaleStrings(wtsPath, wts ?? "﻿", added) });
  const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root: prefix ? joinPath(root, prefix) : root, path: INFO_JSON, text: JSON.stringify(info) });
  changed();
  out.push({ path: infoPath, text: canonical });
  return { out, added, plain, plainKept, blanked };
}

/** See the top. Throws when a file it needs can't be read, or the project changes meanwhile: nothing is changed. */
export async function namesToStringTable(w3: W3Api): Promise<NameStringsOutcome> {
  const root = w3.workspace.project()?.root;
  if (!root) return { added: [], reused: 0, kept: "no project is open" };
  // The numbers taken are searched in the listed files: only once every file is listed.
  await w3.workspace.filesReady();
  if (w3.workspace.project()?.root !== root) throw new Error("the project changed meanwhile");
  const listed = () => w3.workspace.files().map((f) => f.path);
  const prefixes = [
    ...(listed().some((p) => p.toLowerCase() === INFO_JSON) ? [""] : []),
    ...listed().map((p) => CHAPTER_INFO.exec(p)?.[1]).filter((p): p is string => !!p).sort(),
  ];
  if (!prefixes.length) return { added: [], reused: 0, kept: null };
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) return { added: [], reused: 0, kept: `${unsaved.join(", ")} ${unsaved.length === 1 ? "has" : "have"} unsaved changes` };
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE).catch(() => null);
  if (!edits) return { added: [], reused: 0, kept: "the edit log (the MCP extension) is off" };
  let maps: { prefix: string; added: InfoString[]; plain: number; blanked: number[] }[] = [];
  let plainKept: string[] = [];
  const done = await edits.edit("Strings for Players' and Forces' Names", async (read) => {
    if (w3.workspace.project()?.root !== root) throw new Error("the project changed meanwhile");
    maps = [];
    plainKept = [];
    const out: { path: string; text: string }[] = [];
    const files = listed();
    for (const prefix of prefixes) {
      const one = await mapNames(w3, root, prefix, read, files);
      out.push(...one.out);
      plainKept.push(...one.plainKept);
      maps.push({ prefix, added: one.added, plain: one.plain, blanked: one.blanked });
    }
    return out;
  });
  const outcome: NameStringsOutcome = { added: [], reused: 0, kept: null };
  if (plainKept.length) outcome.plainKept = plainKept;
  if (!done) return outcome;
  const chapters: ChapterNames[] = [];
  for (const m of maps) {
    const added = m.added.map((s) => s.num), reused = m.plain - m.added.length;
    if (!m.prefix) {
      outcome.added = added; outcome.reused = reused;
      if (m.blanked.length) outcome.blanked = m.blanked;
    } else if (m.plain || m.blanked.length) {
      chapters.push({ folder: m.prefix.slice(0, -1), added, reused, ...(m.blanked.length ? { blanked: m.blanked } : {}) });
    }
  }
  if (chapters.length) outcome.chapters = chapters;
  return outcome;
}
