// The project's triggers as one document: `map/triggers/` (one file per trigger, crates/w3proj/src/trigger_layout.rs)
// read and saved by the backend in one call each way (crates/backend/src/triggers.rs), never a call per trigger. The
// app works with the tree as a TriggerFile and its texts as a CustomTextFile (wtg.ts): read, every item has an id
// (given in memory where the files store none, or the same one twice); saved, they are sliced into the files again and
// only those whose content changed are written. A map whose triggers couldn't be split keeps war3map.wtg and
// war3map.wct raw (WTG_RAW, WCT_RAW), read and written as they are.

import { parseWct, parseWtg, textTriggers, writeWct, writeWtg, type CustomTextFile, type TriggerFile } from "./wtg";
import type { TriggerData } from "./triggerdata";

export const TRIGGERS_DIR = "map/triggers";
/** The layout's root file: a project has the layout when it is listed. */
export const TRIGGERS_ROOT = "map/triggers/triggers.json";
export const WTG_RAW = "map/war3map.wtg", WCT_RAW = "map/war3map.wct";

/** Whether a project path is one of the layout's files (any case, either slash). */
export function isTriggerLayoutPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().startsWith("map/triggers/");
}

/** The tree as the backend reads it (`triggers_read`). */
export interface ProjectTriggers {
  file: TriggerFile;
  custom: CustomTextFile;
  /** Per item of `file.items`: its file or folder (project path), null for the map item and variable nodes. */
  files: (string | null)[];
  /** The custom script header's file; null when the header has no text. */
  headerFile: string | null;
  /** In-memory ids the files don't store as they are: "f" (folders, the map item), "t" (triggers, comments, script
   *  items) or "v" (variables) + the id → the id the files store (null: none). Handed back with a save. */
  stored: Record<string, number | null>;
  language: "jass" | "lua";
  script: "generated" | "kept";
  /** order.txt entries that aren't there, a variable defined twice alike, … */
  warnings: string[];
}

/** What a save hands the backend. */
export interface TriggerSave { file: TriggerFile; custom: CustomTextFile; stored?: Record<string, number | null> }

/** What a save did: the files written and removed (project paths), and the files of the saved items afterwards. */
export interface TriggersWritten { written: string[]; deleted: string[]; files: (string | null)[]; headerFile: string | null }

/** What a save would write and remove (`triggers_plan`), for an edit that writes the files itself (the MCP edits). */
export interface TriggersPlan { write: { path: string; text: string }[]; delete: string[] }

/** Project access for the triggers (the workspace). */
export interface TriggerIO {
  readBytes(path: string): Promise<Uint8Array>;
  /** The layout read in one call; null when the project has no `map/triggers/`. */
  readTriggers(): Promise<ProjectTriggers | null>;
}

/** Which form the project keeps its triggers in: the layout's root file if listed, else a raw war3map.wtg, else null. */
export function wtgPath(files: { path: string }[]): string | null {
  const has = (p: string) => files.some((f) => f.path.toLowerCase() === p);
  return has(TRIGGERS_ROOT) ? TRIGGERS_ROOT : has(WTG_RAW) ? WTG_RAW : null;
}

/** The project's triggers and their texts, in the form `path` (from wtgPath) names. A raw war3map.wtg needs the game's
 *  TriggerData (`data`); a raw war3map.wct that isn't there is no texts (null), one that can't be read an error. */
export async function readTriggerFiles(io: TriggerIO, path: string, data: () => Promise<TriggerData>): Promise<{ file: TriggerFile; custom: CustomTextFile | null; layout: ProjectTriggers | null }> {
  if (path.toLowerCase() === TRIGGERS_ROOT) {
    const layout = await io.readTriggers();
    if (!layout) throw new Error(`${TRIGGERS_DIR}/ isn't there (any more).`);
    return { file: layout.file, custom: layout.custom, layout };
  }
  const file = parseWtg(await io.readBytes(path), await data());
  const bytes = await io.readBytes(WCT_RAW).catch(() => null);
  return { file, custom: bytes ? parseWct(bytes, textTriggers(file).length) : null, layout: null };
}

/** Writes the triggers in the form `path` names: the layout through the backend (only changed files), a raw
 *  war3map.wtg and war3map.wct as they are. */
export async function writeTriggerFiles(io: { writeBytes(path: string, bytes: Uint8Array): Promise<void>; writeTriggers(save: TriggerSave): Promise<TriggersWritten> },
  path: string, save: TriggerSave): Promise<TriggersWritten | null> {
  if (path.toLowerCase() === TRIGGERS_ROOT) return io.writeTriggers(save);
  await io.writeBytes(path, writeWtg(save.file));
  await io.writeBytes(WCT_RAW, writeWct(save.custom));
  return null;
}
