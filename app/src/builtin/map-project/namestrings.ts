// The players' and the forces' plain names become strings of war3map.wts when the map is packed, as the World Editor's
// save gives them (we-compare plain-names, 2026-11-19: open and save, nothing else; lib/formats/infostrings
// namesToStrings), in the project too. Numbered on from every number the map's files, the languages' tables and the
// record of dropped strings take (as Map Size's strings, terrain-viewer resizeFirstString), each new string added to
// every language's table as well (lib/formats/localewts addLocaleStrings).
//
// One undoable edit (the MCP edit log, like Drop Unused Strings, which runs after it), after every editor is saved and
// the map script settled; nothing while anything is still unsaved, nothing without the edit log, and nothing when
// war3map.w3i is kept raw (left as it is, as the placing tools do). A file that is there but can't be read stops it
// (nothing is changed): never taken for an empty one.

import type { W3Api } from "../../extensions/api";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { namesToStrings, type InfoString } from "../../lib/formats/infostrings";
import { addLocaleStrings, isLocaleWts } from "../../lib/formats/localewts";
import { stringNumbersTaken } from "../../lib/formats/mapdoc";
import { StringTable } from "../../lib/formats/wts";

const WTS = "map/war3map.wts";
const INFO_JSON = "map/war3map.w3i.json";

/** `added`: the new strings' numbers; `kept`: why nothing was looked at (unsaved editors, no edit log), else null. */
export interface NameStringsOutcome { added: number[]; kept: string | null }

/** See the top. Throws when a file it needs can't be read, or the project changes meanwhile: nothing is changed. */
export async function namesToStringTable(w3: W3Api): Promise<NameStringsOutcome> {
  const root = w3.workspace.project()?.root;
  if (!root) return { added: [], kept: "no project is open" };
  // The numbers taken are searched in the listed files: only once every file is listed.
  await w3.workspace.filesReady();
  if (w3.workspace.project()?.root !== root) throw new Error("the project changed meanwhile");
  const listed = () => w3.workspace.files().map((f) => f.path);
  if (!listed().some((p) => p.toLowerCase() === INFO_JSON)) return { added: [], kept: null };
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) return { added: [], kept: `${unsaved.join(", ")} ${unsaved.length === 1 ? "has" : "have"} unsaved changes` };
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE).catch(() => null);
  if (!edits) return { added: [], kept: "the edit log (the MCP extension) is off" };
  let added: InfoString[] = [];
  const done = await edits.edit("Strings for Players' and Forces' Names", async (read) => {
    if (w3.workspace.project()?.root !== root) throw new Error("the project changed meanwhile");
    added = [];
    // Absent is nothing to do; there but unreadable (or not JSON) throws.
    const text = await read(INFO_JSON);
    if (text === null) return [];
    let info: unknown;
    try { info = JSON.parse(text); } catch { throw new Error(`${INFO_JSON} is there but can't be read`); }
    if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error(`${INFO_JSON} is there but can't be read`);
    // Nothing plain: nothing else is read.
    if (!namesToStrings(JSON.parse(text) as Record<string, unknown>, 1).length) return [];
    const wts = await read(WTS);
    const taken = await stringNumbersTaken(w3, listed());
    for (const [n] of wts === null ? [] : new StringTable(wts).entries()) taken.add(n);
    let max = 0;
    for (const n of taken) max = Math.max(max, n);
    if (w3.workspace.project()?.root !== root) throw new Error("the project changed meanwhile");
    added = namesToStrings(info as Record<string, unknown>, max + 1);
    // The tables first, then the file that refers to their new strings.
    const out: { path: string; text: string }[] = [];
    for (const path of listed().filter(isLocaleWts)) {
      const table = await read(path);
      if (table === null) continue;
      const next = addLocaleStrings(path, table, added);
      if (next !== table) out.push({ path, text: next });
    }
    out.push({ path: WTS, text: addLocaleStrings(WTS, wts ?? "﻿", added) });
    const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root, path: INFO_JSON, text: JSON.stringify(info) });
    if (w3.workspace.project()?.root !== root) throw new Error("the project changed meanwhile");
    out.push({ path: INFO_JSON, text: canonical });
    return out;
  });
  return { added: done ? added.map((s) => s.num) : [], kept: null };
}
