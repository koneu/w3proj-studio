// For AI tools (MCP) that change one of a map's documents: the project's JSON form of a map file, through the edit
// list of the MCP Server ("w3.mcpEdits"), so the change is refused while anything is unsaved, can be undone, and the
// open editors of the file take it (the workbench reloads them after the write).

import type { W3Api } from "./api";
import { MCP_EDITS_SERVICE, type McpEditsService } from "./services";
import { jsonPathOf, projectWithFiles } from "../lib/formats/mapdoc";

/** One edit of the map file `name` ("war3map.w3c") as its JSON. `empty`: the document of a map that has no such file
 *  yet (the edit then creates it); without it a missing file is refused. `change` works on the parsed document and
 *  throws to refuse; the file is written canonical, as the editors' saves write it. Whether anything changed. */
export async function editMapDoc<T>(w3: W3Api, name: string, title: string, change: (doc: T) => void | Promise<void>, empty?: () => T): Promise<boolean> {
  // From the whole file list: a file not listed yet (right after an open) isn't a missing one.
  const { root } = await projectWithFiles(w3);
  const path = jsonPathOf(w3, name);
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
  return edits.edit(title, async (read) => {
    const text = await read(path);
    if (text === null && !empty) throw new Error(`This project has no ${name}.`);
    let doc: T;
    try { doc = text === null ? empty!() : JSON.parse(text) as T; } catch (e) { throw new Error(`${path} can't be read (${(e as Error).message}); nothing was changed.`); }
    await change(doc);
    return [{ path, text: await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: JSON.stringify(doc) }) }];
  });
}

/** A number a tool was given for `label`, or a refusal naming it. */
export function toolNumber(value: unknown, label: string, limits: { min?: number; max?: number; whole?: boolean } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a number.`);
  if (limits.whole && !Number.isInteger(value)) throw new Error(`${label} must be a whole number.`);
  if ((limits.min !== undefined && value < limits.min) || (limits.max !== undefined && value > limits.max)) {
    throw new Error(`${label} must be from ${limits.min ?? "-∞"} to ${limits.max ?? "∞"}.`);
  }
  return value;
}
