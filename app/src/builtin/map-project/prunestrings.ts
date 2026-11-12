// Strings nothing refers to leave war3map.wts when the map is packed, as the World Editor drops them on every save.
//
// What the World Editor keeps (we-drive saves of scratch maps, 2026-11-13): the strings its own data names, the map
// info's fields, object fields whose whole value is a reference, GUI trigger parameters whose whole value is one, and
// the sounds' dialogue keys (numbers in war3map.w3s, not TRIGSTR_ text). It drops a string even where only the custom
// script (war3map.wct), the map script, a region's or a camera's name, the imports list, a variable's initial value, a
// trigger's description, a trigger comment or a Custom Script action still refers to it, and leaves those references
// pointing at nothing. Studio keeps every string any file of the map still refers to (TRIGSTR_ anywhere in a text or
// raw map file, and the dialogue keys): lib/formats/mapdoc stringRefsInMap. The strings that stay keep their numbers
// (the editor doesn't renumber either), their comments and their order; the editor rewrites the whole file, in order,
// without comments other than the ones it makes for object fields.
//
// One undoable edit (the MCP edit log, like Move Texts), after every editor is saved and the map script settled;
// refused while anything is still unsaved, as an unsaved editor may hold references the files don't have yet.

import type { W3Api } from "../../extensions/api";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { stringRefsInMap } from "../../lib/formats/mapdoc";
import { pruneStrings } from "../../lib/formats/wts";

const WTS = "map/war3map.wts";

/** `dropped`: the string numbers that went; `kept`: why nothing was looked at (unsaved editors), else null. */
export interface PruneOutcome { dropped: number[]; kept: string | null }

/** See the top. Throws when a file can't be read (war3map.wts, or one that may refer to strings): nothing is dropped. */
export async function dropUnusedStrings(w3: W3Api): Promise<PruneOutcome> {
  const root = w3.workspace.project()?.root;
  if (!root) return { dropped: [], kept: "no project is open" };
  const listed = () => w3.workspace.files().map((f) => f.path);
  if (!listed().some((p) => p.toLowerCase() === WTS)) return { dropped: [], kept: null };
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) return { dropped: [], kept: `${unsaved.join(", ")} ${unsaved.length === 1 ? "has" : "have"} unsaved changes` };
  let dropped: number[] = [];
  const change = async (read: (path: string) => Promise<string | null>) => {
    if (w3.workspace.project()?.root !== root) throw new Error("the project changed meanwhile");
    dropped = [];
    // Absent is no table; there but unreadable throws (never taken for empty).
    const wts = await read(WTS);
    if (wts === null) return [];
    const refs = await stringRefsInMap(w3, listed());
    const r = pruneStrings(wts, refs);
    dropped = r.dropped;
    return r.dropped.length ? [{ path: WTS, text: r.text }] : [];
  };
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE).catch(() => null);
  if (edits) {
    const done = await edits.edit("Drop Unused Strings", change);
    return { dropped: done ? dropped : [], kept: null };
  }
  // Without the edit log (the MCP extension off): the same, written only when the table is still as it was read.
  const read = (path: string) => w3.workspace.readText(path).catch((e) => {
    if (listed().some((p) => p.toLowerCase() === path.toLowerCase())) throw e;
    return null;
  });
  const before = await read(WTS);
  const out = await change(async (p) => (p === WTS ? before : read(p)));
  if (!out.length) return { dropped: [], kept: null };
  if ((await read(WTS)) !== before || w3.editors.unsavedPaths().length) throw new Error("war3map.wts changed meanwhile");
  await w3.workspace.writeText(WTS, out[0].text);
  return { dropped, kept: null };
}
