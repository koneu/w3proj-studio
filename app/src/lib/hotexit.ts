// Hot exit: while an editor has unsaved changes, a snapshot of them is kept in the project's build/unsaved/
// (git-ignored, one file per editor). Saving or closing the editor deletes it, so a snapshot found when the project
// opens is one Studio never got to settle (a crash, a killed process, a power cut): it is offered back.
// No journal and no history: each snapshot is the editor's unsaved state as last seen.

import { joinPath } from "./paths";

export const BACKUP_FOLDER = ["build", "unsaved"] as const;
const FORMAT = "w3proj.unsaved/1";

/** One editor's snapshot as its file holds it. */
export interface Backup {
  /** The tab's file and editor. */
  path: string;
  editor: string;
  /** The hash of the file's contents when the editor read or last wrote it; null when it wasn't known. */
  saved: string | null;
  /** When the snapshot was taken (milliseconds since 1970). */
  time: number;
  /** What the editor's `backup()` gave. */
  data: string;
}

/** The files of a project's snapshots; paths are absolute. */
export interface BackupStore {
  /** The open project's snapshot folder; null without a project. */
  folder(): string | null;
  /** The names of the files in `folder` (none when it isn't there). */
  list(folder: string): Promise<string[]>;
  read(file: string): Promise<string>;
  /** Writes `file`, its folder made first; whole or not at all. */
  write(file: string, text: string): Promise<void>;
  remove(file: string): Promise<void>;
}

/** The snapshot file's name for a tab: FNV-1a of its editor and file (64 bits). */
export function backupName(editor: string, path: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${editor}\n${path}`)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `${hash.toString(16).padStart(16, "0")}.json`;
}

export const backupText = (b: Backup) => JSON.stringify({ format: FORMAT, ...b });

/** A snapshot file's text read; null when it isn't one (cut short, another format). */
export function parseBackup(text: string): Backup | null {
  try {
    const b = JSON.parse(text) as Backup & { format?: unknown };
    if (b.format !== FORMAT || typeof b.path !== "string" || typeof b.editor !== "string" || typeof b.data !== "string") return null;
    return { path: b.path, editor: b.editor, saved: typeof b.saved === "string" ? b.saved : null, time: Number(b.time) || 0, data: b.data };
  } catch {
    return null;
  }
}

/** The snapshots in the store's folder, each with its file; ones that can't be read are left where they are. */
export async function readBackups(store: BackupStore): Promise<{ file: string; backup: Backup }[]> {
  const folder = store.folder();
  if (!folder) return [];
  const out: { file: string; backup: Backup }[] = [];
  for (const name of (await store.list(folder)).filter((n) => n.endsWith(".json")).sort()) {
    const file = joinPath(folder, name);
    const backup = parseBackup(await store.read(file).catch(() => ""));
    if (backup) out.push({ file, backup });
  }
  return out;
}

/** Bytes as base64 text, for a snapshot's binary parts. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** What the terrain editor keeps of its unsaved changes: the ground, the placed objects' files once objects changed,
 *  each tool tab's unsaved content, and the subterrains that were open (a split project's partial load; null: flat or
 *  all). */
export interface TerrainBackup { w3e: string; doodads: string | null; units: string | null; groups: Record<string, string>; open: string | null }

export function parseTerrainBackup(text: string): TerrainBackup {
  const b = JSON.parse(text) as Partial<TerrainBackup>;
  if (typeof b.w3e !== "string" || !b.groups) throw new Error("the kept changes aren't this editor's");
  return { w3e: b.w3e, doodads: b.doodads ?? null, units: b.units ?? null, groups: b.groups, open: b.open ?? null };
}
