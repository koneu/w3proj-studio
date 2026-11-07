// Undo for Map Size and Camera Bounds. A resize rewrites a dozen files of the map (terrain,
// objects, pathing, shadows, minimap, w3i, regions, overrides), and the editor reopens on the
// result, so the editor's own undo steps can't take it back. Instead the files themselves are
// kept: before the resize and after it, only those that differ. Undo writes the first set back,
// redo the second. The history lives as long as the session.

import type { W3Api } from "../../extensions/api";
import type { Terrain } from "./w3e";
import type { Sides } from "./resize";

/** Bytes by project path; null: the file doesn't exist. */
export type Files = Map<string, Uint8Array | null>;

export interface FileIO {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ResizeRecord {
  root: string;
  /** The terrain editor's file, which is closed and opened again around an undo. */
  editor: string;
  title: string;
  before: Files;
  after: Files;
}

/** The project files a resize may rewrite: the map's own files at its root (war3map*), the
 *  terrain editor's file and the Pathing Editor's overrides. Case doesn't matter. */
export function resizeCandidates(projectFiles: readonly string[], editor: string): string[] {
  const out = new Set<string>([editor, ".w3proj/pathing.json"]);
  for (const f of projectFiles) {
    const p = f.replace(/\\/g, "/");
    const m = /^map\/([^/]+)$/i.exec(p);
    if (m && /^war3map/i.test(m[1])) out.add(p);
  }
  return [...out];
}

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function takeSnapshot(io: FileIO, paths: readonly string[]): Promise<Files> {
  const out: Files = new Map();
  for (const p of paths) out.set(p, await io.read(p));
  return out;
}

/** Both sides reduced to the paths whose bytes differ (a file on one side only counts as null on the other). */
export function changedFiles(before: Files, after: Files): { before: Files; after: Files } {
  const b: Files = new Map(), a: Files = new Map();
  for (const p of new Set([...before.keys(), ...after.keys()])) {
    const x = before.get(p) ?? null, y = after.get(p) ?? null;
    if (sameBytes(x, y)) continue;
    b.set(p, x); a.set(p, y);
  }
  return { before: b, after: a };
}

/** The paths of `files` whose bytes on disk differ from the ones given. */
export async function drifted(io: FileIO, files: Files): Promise<string[]> {
  const out: string[] = [];
  for (const [p, bytes] of files) if (!sameBytes(await io.read(p), bytes)) out.push(p);
  return out;
}

async function put(io: FileIO, files: Files) {
  for (const [p, bytes] of files) {
    if (bytes === null) await io.remove(p).catch(async (e) => { if ((await io.read(p)) !== null) throw e; });
    else await io.write(p, bytes);
  }
}

/** Writes `files`; when that fails halfway, what was there before is written back and the error passes on. */
export async function restoreFiles(io: FileIO, files: Files): Promise<void> {
  const current = await takeSnapshot(io, [...files.keys()]);
  try {
    await put(io, files);
  } catch (e) {
    await put(io, current).catch(() => {});
    throw e;
  }
}

export class ResizeHistory {
  private list: ResizeRecord[] = [];
  private at = 0;
  constructor(private keep = 5) {}

  record(r: ResizeRecord) {
    this.list.length = this.at;
    this.list.push(r);
    if (this.list.length > this.keep) this.list.shift();
    this.at = this.list.length;
  }
  clear() { this.list = []; this.at = 0; }
  /** What Undo would take back, for a project; null when there is nothing (another project's steps stay out of reach). */
  nextUndo(root: string): ResizeRecord | null {
    const r = this.list[this.at - 1];
    return r && r.root === root ? r : null;
  }
  nextRedo(root: string): ResizeRecord | null {
    const r = this.list[this.at];
    return r && r.root === root ? r : null;
  }
  /** Writes the files from before the resize. `ask` is given the files changed since, which would be lost;
   *  when it says no nothing is written. Resolves with the record, or null when there was nothing or the answer was no. */
  async undo(io: FileIO, root: string, ask: (changed: string[]) => Promise<boolean>): Promise<ResizeRecord | null> {
    const r = this.nextUndo(root);
    if (!r) return null;
    const changed = await drifted(io, r.after);
    if (changed.length && !(await ask(changed))) return null;
    await restoreFiles(io, r.before);
    this.at--;
    return r;
  }
  async redo(io: FileIO, root: string, ask: (changed: string[]) => Promise<boolean>): Promise<ResizeRecord | null> {
    const r = this.nextRedo(root);
    if (!r) return null;
    const changed = await drifted(io, r.before);
    if (changed.length && !(await ask(changed))) return null;
    await restoreFiles(io, r.after);
    this.at++;
    return r;
  }
}

/** The session's resize history, shared by the terrain editor (which records) and Map Size (which undoes). */
export const resizeHistory = new ResizeHistory();

/** What a resize takes away, for asking first: tiles of ground cut off, and how many objects
 *  lie outside (start locations move inside, so they aren't counted). Empty when nothing is cut. */
export function resizeLoss(t: Terrain, change: Sides, objects: readonly { id?: string; position: readonly number[] }[]): string[] {
  if (change.every((c) => c >= 0)) return [];
  const ow = t.width - 1, oh = t.height - 1;
  // The old map's tiles that are still inside the new one.
  const kw = Math.max(0, Math.min(ow, ow + change[1]) - Math.max(0, -change[0])), kh = Math.max(0, Math.min(oh, oh + change[3]) - Math.max(0, -change[2]));
  const cut = ow * oh - kw * kh;
  // The new map's edges, as the resize keeps objects (inclusive).
  const left = t.offsetX - change[0] * 128, right = t.offsetX + (ow + change[1]) * 128;
  const bottom = t.offsetY - change[2] * 128, top = t.offsetY + (oh + change[3]) * 128;
  // Start locations aren't removed: they move inside the map.
  const objectsOutside = objects.filter((o) => o.id !== "sloc" && (o.position[0] < left || o.position[0] > right || o.position[1] < bottom || o.position[1] > top)).length;
  const out: string[] = [];
  if (cut > 0) out.push(`${cut} tile${cut === 1 ? "" : "s"} of terrain (ground, cliffs, water, pathing, shadows)`);
  if (objectsOutside > 0) out.push(`${objectsOutside} object${objectsOutside === 1 ? "" : "s"} (doodads, units, items) outside the new map`);
  return out;
}

type Workspace = Pick<W3Api["workspace"], "project" | "files" | "readBytes" | "writeBytes" | "delete" | "refresh">;

/** The project's files as the history reads and writes them. A file that isn't in the project reads as
 *  missing; one that is but can't be read is an error (it must not be taken for absent and deleted later). */
export function workspaceIO(ws: Workspace): FileIO {
  const listed = (path: string) => ws.files().some((f) => f.path.toLowerCase() === path.toLowerCase());
  return {
    read: (path) => ws.readBytes(path).catch((e) => { if (listed(path)) throw e; return null; }),
    write: (path, bytes) => ws.writeBytes(path, bytes),
    remove: (path) => ws.delete(path),
  };
}

export interface ResizeSession {
  /** After the resize wrote its files: remembers both states. */
  finish(): Promise<void>;
  /** The resize failed: puts the files back as they were. */
  abort(): Promise<void>;
}

/** Keeps every file a resize may rewrite, to undo it later (or at once, if it fails). Reads all
 *  of them before returning, so call it before the first write. */
export async function beginResize(ws: Workspace, editor: string, title: string): Promise<ResizeSession> {
  const io = workspaceIO(ws);
  const root = ws.project()!.root;
  const before = await takeSnapshot(io, resizeCandidates(ws.files().map((f) => f.path), editor));
  return {
    async finish() {
      await ws.refresh();
      const after = await takeSnapshot(io, resizeCandidates(ws.files().map((f) => f.path), editor));
      const kept = changedFiles(before, after);
      if (kept.before.size) resizeHistory.record({ root, editor, title, before: kept.before, after: kept.after });
    },
    async abort() {
      await ws.refresh();
      const after = await takeSnapshot(io, resizeCandidates(ws.files().map((f) => f.path), editor));
      await restoreFiles(io, changedFiles(before, after).before);
    },
  };
}
