// Undo for Map Size and Camera Bounds. A resize rewrites a dozen files of the map (terrain,
// objects, pathing, shadows, minimap, w3i, regions, overrides), and the editor reopens on the
// result, so the editor's own undo steps can't take it back. Instead the files themselves are
// kept: before the resize and after it, only those that differ. Undo writes the first set back,
// redo the second. The history lives as long as the session.

import type { W3Api } from "../../extensions/api";
import { isNotFoundError } from "../oserror";
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
  /** What was on screen when the resize started (the toasts): what came after is the resize's, and an undo withdraws it. */
  shownBefore?: ReadonlySet<unknown>;
  before: Files;
  after: Files;
}

/** The project files a resize may rewrite: the map's own files at its root (war3map*), the
 *  terrain editor's file, the Pathing Editor's overrides, the stamp of the generated script
 *  (which says whether war3map.j / .lua is still the generated one) and the record of what pathing, shadows and
 *  the minimap were made from (w3proj::derived). Case doesn't matter. */
export function resizeCandidates(projectFiles: readonly string[], editor: string): string[] {
  const out = new Set<string>([editor, ".w3proj/pathing.json", ".w3proj/generated-script", ".w3proj/derived-from.json"]);
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

/** The bytes a record keeps. */
export function recordBytes(r: ResizeRecord): number {
  let n = 0;
  for (const side of [r.before, r.after]) for (const b of side.values()) n += b?.length ?? 0;
  return n;
}

export class ResizeHistory {
  private list: ResizeRecord[] = [];
  private at = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private held = false;
  /** Keeps at most `keep` steps and `maxBytes` of files (the newest step always stays). */
  constructor(private keep = 5, private maxBytes = 200 * 1024 * 1024) {}

  /** Runs one task at a time: a resize, an undo and a redo all rewrite the same files, and the step
   *  they move along is only right if no other one runs between its checks and its writes. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.held = true;
      try { return await task(); } finally { this.held = false; }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  record(r: ResizeRecord) {
    this.list.length = this.at;
    this.list.push(r);
    while (this.list.length > this.keep) this.list.shift();
    let total = this.list.reduce((n, x) => n + recordBytes(x), 0);
    while (total > this.maxBytes && this.list.length > 1) total -= recordBytes(this.list.shift()!);
    this.at = this.list.length;
  }
  clear() { this.list = []; this.at = 0; }
  /** The steps kept, for showing and testing. */
  get steps(): readonly ResizeRecord[] { return this.list; }
  /** What Undo would take back, for a project; null when there is nothing (another project's steps stay out of reach). */
  nextUndo(root: string): ResizeRecord | null {
    const r = this.list[this.at - 1];
    return r && r.root === root ? r : null;
  }
  nextRedo(root: string): ResizeRecord | null {
    const r = this.list[this.at];
    return r && r.root === root ? r : null;
  }
  /** Writes the files from before the resize (inside `exclusive`). `ask` is given the files changed since, which would be lost;
   *  when it says no nothing is written. Resolves with the record, or null when there was nothing or the answer was no. */
  async undo(io: FileIO, root: string, ask: (changed: string[]) => Promise<boolean>): Promise<ResizeRecord | null> {
    if (!this.held) throw new Error("undo runs inside exclusive()");
    const r = this.nextUndo(root);
    if (!r) return null;
    const changed = await drifted(io, r.after);
    if (changed.length && !(await ask(changed))) return null;
    // The answer took time; the step must still be the one asked about.
    if (this.nextUndo(root) !== r) return null;
    await restoreFiles(io, r.before);
    this.at--;
    return r;
  }
  async redo(io: FileIO, root: string, ask: (changed: string[]) => Promise<boolean>): Promise<ResizeRecord | null> {
    if (!this.held) throw new Error("redo runs inside exclusive()");
    const r = this.nextRedo(root);
    if (!r) return null;
    const changed = await drifted(io, r.before);
    if (changed.length && !(await ask(changed))) return null;
    if (this.nextRedo(root) !== r) return null;
    await restoreFiles(io, r.after);
    this.at++;
    return r;
  }
}

/** The session's resize history, shared by the terrain editor (which records) and Map Size (which undoes). */
export const resizeHistory = new ResizeHistory();

/** What a resize takes away, for asking first: tiles of ground cut off, and the objects it removes (`removed`: the
 *  terrain editor's resizeRemovals; start locations move inside, so they aren't among them). Empty when it takes
 *  nothing. */
export function resizeLoss(t: Terrain, change: Sides, removed: number): string[] {
  const ow = t.width - 1, oh = t.height - 1;
  // The old map's tiles that are still inside the new one.
  const kw = Math.max(0, Math.min(ow, ow + change[1]) - Math.max(0, -change[0])), kh = Math.max(0, Math.min(oh, oh + change[3]) - Math.max(0, -change[2]));
  const cut = ow * oh - kw * kh;
  const out: string[] = [];
  if (cut > 0) out.push(`${cut} tile${cut === 1 ? "" : "s"} of terrain (ground, cliffs, water, pathing, shadows)`);
  if (removed > 0) out.push(`${removed} object${removed === 1 ? "" : "s"} (doodads on or past the new edge, units and items outside the playable area)`);
  return out;
}

type Workspace = Pick<W3Api["workspace"], "project" | "files" | "readBytes" | "writeBytes" | "delete" | "refresh">;

/** Whether a backend error says the file isn't there (see lib/oserror). */
export const isNotFound = isNotFoundError;

/** The project's files as the history reads and writes them. A file that isn't there reads as missing;
 *  one that is there but can't be read is an error (it must not be taken for absent and deleted later). */
export function workspaceIO(ws: Workspace): FileIO {
  return {
    read: (path) => ws.readBytes(path).catch((e) => { if (isNotFound(e)) return null; throw e; }),
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
export async function beginResize(ws: Workspace, editor: string, title: string, shownBefore?: ReadonlySet<unknown>): Promise<ResizeSession> {
  const io = workspaceIO(ws);
  const root = ws.project()!.root;
  const before = await takeSnapshot(io, resizeCandidates(ws.files().map((f) => f.path), editor));
  return {
    async finish() {
      await ws.refresh();
      const after = await takeSnapshot(io, resizeCandidates(ws.files().map((f) => f.path), editor));
      const kept = changedFiles(before, after);
      if (kept.before.size) resizeHistory.record({ root, editor, title, shownBefore, before: kept.before, after: kept.after });
    },
    async abort() {
      await ws.refresh();
      const after = await takeSnapshot(io, resizeCandidates(ws.files().map((f) => f.path), editor));
      await restoreFiles(io, changedFiles(before, after).before);
    },
  };
}

/** Waits for work that must be done before a resize or an undo (the rebuild of the derived files due from an
 *  edit). A rebuild that doesn't end within \`ms\` must not hold the resize for ever: it fails with a message. */
export async function settleWithin(settle: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Pathing, shadows and the minimap from the last edit are still being rebuilt after ${Math.round(ms / 1000)} s. Nothing was changed; try again when that is done.`)), ms);
  });
  try {
    await Promise.race([settle().catch(() => {}), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether an undo or redo that finds unsaved documents says so. Ctrl+Z reaches it when the editor has nothing of its
 *  own left to undo: if the editor's own changes are all that is unsaved, they are the editor's business, not a message. */
export function warnsAboutUnsaved(unsaved: readonly string[], editor: string, quiet: boolean): boolean {
  if (!unsaved.length) return false;
  return !(quiet && unsaved.length === 1 && unsaved[0] === editor);
}
