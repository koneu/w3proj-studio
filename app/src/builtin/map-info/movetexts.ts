// Move Texts to String Table (w3.strings.moveToTable): lib/formats/movetexts.ts on the open project, as one undoable edit
// (the MCP edit log, like Adjust Map String IDs): refused while anything is unsaved, every file read again inside the
// edit, undone in one step.

import type { W3Api } from "../../extensions/api";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { requireProject } from "../../lib/formats/mapdoc";
import { moveTexts, OBJECT_KINDS, refsIn, type MoveTextsResult, type TextMapInfo, type TextObjectFile } from "../../lib/formats/movetexts";
import { loadKind, type KindData } from "../../lib/objects/metadata";

const WTS = "map/war3map.wts";
const INFO = "map/war3map.w3i";
/** Files that may refer to strings and are read as text (latin1 here: a reference is plain ASCII). */
const TEXT_FILE = /^map\/.*\.(json|j|lua|txt|fdf|toc|ai|slk|ini)$/i;
/** The map's own files kept raw (no codec): searched as bytes. */
const RAW_MAP_FILE = /^map\/war3(map|campaign)[^/]*$/i;

export interface MoveTextsOutcome { moved: number; dropped: number; kept: string[]; raw: string[] }

/** The game's metadata of the kinds whose fields move, for the comments; a kind it can't read (no game) gives none. */
async function gameData(w3: W3Api, kinds: string[]): Promise<Map<string, KindData>> {
  const out = new Map<string, KindData>();
  await Promise.all(kinds.map(async (kind) => {
    const data = await loadKind(w3, kind).catch(() => null);
    if (data) out.set(kind, data);
  }));
  return out;
}

/** See the top. Gives what was done; nothing to do is no edit. */
export async function moveTextsToStringTable(w3: W3Api): Promise<MoveTextsOutcome> {
  const root = requireProject(w3).root;
  const listed = () => new Map(w3.workspace.files().map((f) => [f.path.toLowerCase(), f.path] as [string, string]));
  const has = (path: string) => listed().has(path.toLowerCase());
  const objectFiles = OBJECT_KINDS.flatMap((kind) => [false, true].map((skin) => ({ kind, skin, path: `map/war3map${skin ? "Skin" : ""}.${kind}` })));
  const data = await gameData(w3, [...new Set(objectFiles.filter((f) => has(`${f.path}.json`)).map((f) => f.kind))]);
  // A map script still due from the last save is written first: the references it holds are searched below, and it's
  // what the map's data makes (a script that isn't, kept by the Map Script extension, counts as it is).
  await w3.commands.execute("w3.script.settle").catch(() => {});
  if (w3.workspace.project()?.root !== root) throw new Error("The project changed meanwhile; nothing was changed.");
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
  let result: MoveTextsResult | null = null;
  let raw: string[] = [];
  const done = await edits.edit("Move Texts to String Table", async (read) => {
    if (w3.workspace.project()?.root !== root) throw new Error("The project changed meanwhile; nothing was changed.");
    const files = listed();
    // Absent is null; there but unreadable (or not JSON) throws, so it never passes for empty.
    const readJson = async <T>(path: string): Promise<T | null> => {
      const text = await read(path);
      if (text === null) return null;
      try { return JSON.parse(text) as T; } catch { throw new Error(`${path} is there but can't be read; nothing was changed.`); }
    };
    const wts = await read(WTS).catch((e) => {
      if ((e as Error)?.name === "NotUtf8Error" || /not valid UTF-8/.test(String(e))) throw new Error("war3map.wts isn't UTF-8 text, so no texts were moved. Nothing changed.");
      throw e;
    });
    const info = await readJson<TextMapInfo>(`${INFO}.json`);
    const objects: { path: string; kind: string; skin: boolean; doc: TextObjectFile }[] = [];
    for (const f of objectFiles) {
      const doc = await readJson<TextObjectFile>(`${f.path}.json`);
      if (doc) objects.push({ path: `${f.path}.json`, kind: f.kind, skin: f.skin, doc });
    }
    const edited = new Set([WTS, `${INFO}.json`, ...objects.map((o) => o.path)].map((p) => p.toLowerCase()));
    // What else refers to strings: every text file of the map, and the map's own files kept raw (as bytes).
    const otherRefs = new Set<number>();
    raw = [];
    for (const [lower, path] of files) {
      if (edited.has(lower) || lower.endsWith(".wts")) continue;
      const text = TEXT_FILE.test(path), rawFile = RAW_MAP_FILE.test(path);
      if (!text && !rawFile) continue;
      const bytes = await w3.workspace.readBytes(path);
      refsIn(new TextDecoder("latin1").decode(bytes), otherRefs);
      if (!text && !edited.has(`${lower}.json`) && (lower === INFO || objectFiles.some((f) => f.path.toLowerCase() === lower))) raw.push(path);
    }
    result = moveTexts({
      wts, info, objects, otherTexts: [], otherRefs,
      describe: (kind, field) => {
        const f = data.get(kind)?.fieldById.get(field);
        return f && f.field && f.label ? { field: f.field, label: f.label } : undefined;
      },
      baseName: (kind, base) => data.get(kind)?.names.get(base),
    });
    const out: { path: string; text: string }[] = [];
    for (const o of result.objects) {
      out.push({ path: o.path, text: await w3.backend.invoke<string>("objects_canonicalize", { name: o.path, text: JSON.stringify(o.doc) }) });
    }
    if (result.info) {
      out.push({ path: `${INFO}.json`, text: await w3.backend.invoke<string>("codec_canonicalize", { root, path: `${INFO}.json`, text: JSON.stringify(result.info) }) });
    }
    // The table last: written after the files that refer to its new strings.
    if (result.wts !== null) out.push({ path: WTS, text: result.wts });
    return out;
  });
  const r = result as MoveTextsResult | null;
  const kept = r ? r.kept.map((k) => `${k.where}: ${k.why}`) : [];
  const outcome: MoveTextsOutcome = { moved: done && r ? r.added.length : 0, dropped: done && r ? r.dropped.length : 0, kept, raw };
  const plural = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
  const notes = [
    kept.length ? ` ${plural(kept.length, "text")} stay${kept.length === 1 ? "s" : ""} literal: ${kept.slice(0, 3).join("; ")}${kept.length > 3 ? "; …" : ""}.` : "",
    raw.length ? ` ${raw.join(", ")} ${raw.length === 1 ? "is" : "are"} kept raw, so ${raw.length === 1 ? "its" : "their"} texts weren't moved.` : "",
  ].join("");
  if (!done) {
    void w3.window.showInfo(`No texts to move, and no strings to drop.${notes}`);
    return outcome;
  }
  const what = [
    outcome.moved ? `Moved ${plural(outcome.moved, "text")} into war3map.wts` : "",
    outcome.dropped ? `${outcome.moved ? "dropped" : "Dropped"} ${plural(outcome.dropped, "string")} nothing refers to` : "",
  ].filter(Boolean).join("; ");
  void w3.window.showInfo(`${what}.${notes}`, "Undo")
    .then((a) => { if (a === "Undo") void w3.commands.execute("w3.mcp.undo").catch((e) => w3.window.showError(String(e))); });
  return outcome;
}
