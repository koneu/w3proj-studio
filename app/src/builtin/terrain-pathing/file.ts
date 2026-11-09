// .w3proj/pathing.json as the Pathing Editor finds it, and what painting may do to it. A file that isn't
// there is started anew; one that is there and can't be read, or was made for another map size, is never
// written over unless the user chose to replace it, and then a backup of it is kept first.

import { overridesForSize, validPathingOverrides, type PathingOverrides } from "../../lib/terrain/resize";

export type PathingFile =
  | { state: "absent" }
  | { state: "ok"; file: PathingOverrides }
  /** A pathing overrides file for another size of pathing map (`file.width`×`file.height`). */
  | { state: "otherSize"; file: PathingOverrides }
  /** There (or not known to be absent), but its overrides can't be had. */
  | { state: "unreadable"; why: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Reads the file for a `width`×`height` pathing map. `exists` must throw when it can't tell (a folder it
 *  may not look into): that is "unreadable", never "absent". */
export async function readPathingFile(exists: () => Promise<boolean>, read: () => Promise<string>, width: number, height: number): Promise<PathingFile> {
  let there: boolean;
  try { there = await exists(); } catch (e) { return { state: "unreadable", why: `whether it is there can't be checked (${message(e)})` }; }
  if (!there) return { state: "absent" };
  let text: string;
  try { text = await read(); } catch (e) { return { state: "unreadable", why: `it can't be read (${message(e)})` }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { return { state: "unreadable", why: `it isn't valid JSON (${message(e)})` }; }
  if (!validPathingOverrides(parsed)) return { state: "unreadable", why: "it isn't a pathing overrides file" };
  return overridesForSize(parsed, width, height) ? { state: "ok", file: parsed } : { state: "otherSize", file: parsed };
}

/** Whether painting may change the overrides, which a save then writes into the file. */
export const mayPaint = (f: PathingFile | null, replacing: boolean) => !!f && (f.state === "absent" || f.state === "ok" || replacing);

/** What is asked before painting over a file it can't use, or null when nothing needs asking. The first action replaces. */
export function replaceQuestion(f: PathingFile | null, path: string, width: number, height: number): { message: string; actions: [string, string] } | null {
  if (f?.state === "unreadable") {
    return { message: `${path} is there, but ${f.why}, so painting is off: a save would write over it. Fix the file and open the map again, or start a new overrides file; the old one is kept as a backup next to it (${path}.bak).`, actions: ["Start a new file", "Cancel"] };
  }
  if (f?.state === "otherSize") {
    return { message: `${path} has ${f.file.cells.length.toLocaleString()} overrides for a ${f.file.width}×${f.file.height} pathing map; this map's is ${width}×${height}. Painting replaces them with this map's: the file is kept as a backup first (${path}.bak).`, actions: ["Replace", "Cancel"] };
  }
  return null;
}

/** A name for the backup of `path` that isn't taken: `.bak`, else `.bak2`, `.bak3`… An answer that can't be had
 *  (`exists` throws) stops it: no backup, so nothing is written. */
export async function backupPath(path: string, exists: (p: string) => Promise<boolean>): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const p = `${path}.bak${i === 1 ? "" : i}`;
    if (!(await exists(p))) return p;
  }
  throw new Error(`${path}: there are 99 backups of it already; move some away first.`);
}
