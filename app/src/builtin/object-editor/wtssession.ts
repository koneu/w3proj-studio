import { StringTable } from "../../lib/formats/wts";

/** A history entry: the editor's strings at the time, and how many saves had happened. */
export interface WtsSnapshot { v: number; s: Record<number, string> }

/** A string the editor has changed. */
interface Owned {
  /** Its text before the editor's first change. */
  text: string;
  /** The save count when the editor took it. Entries older than this hold text from before another
   *  editor had it, and must not be put back. */
  since: number;
  /** Put back by undo/redo from before the last save, and not typed since: if another editor saved
   *  it meanwhile, their text stays. A fresh edit (typed, or redone from after the last save) is
   *  a normal edit, where the last save wins. */
  undone: boolean;
}

const norm = (s: string | undefined) => s?.replace(/\r\n/g, "\n");

/** What the object editor holds of war3map.wts, with undo that only touches the strings the
 *  editor itself changed: strings other editors saved meanwhile are kept when it undoes past one
 *  of its saves. A snapshot is the editor's strings only, not the whole file.
 *
 *  The editor can only change strings that already exist in the file (it needs the number to be in
 *  the table), so it never adds strings and numbers can't collide. */
export class WtsSession {
  table: StringTable;
  /** The file as last read or saved (the base for merging). */
  private saved: string;
  /** The strings of `saved`, to tell dirty without serializing. */
  private savedValues: Map<number, string>;
  private owned = new Map<number, Owned>();
  private saves = 0;
  constructor(text: string) {
    this.saved = text;
    this.table = new StringTable(text);
    this.savedValues = new Map(this.table.entries());
  }

  /** The editor changes a string. */
  set(n: number, text: string) {
    const was = this.table.get(n);
    if (was === undefined || was === text) return;
    const o = this.owned.get(n);
    if (o) o.undone = false;
    else this.owned.set(n, { text: was, since: this.saves, undone: false });
    this.table.set(n, text);
  }

  /** Whether a string differs from the saved file. */
  get dirty(): boolean {
    for (const [n, v] of this.table.entries()) if (norm(v) !== norm(this.savedValues.get(n))) return true;
    return false;
  }

  /** The editor's strings now, as a history entry. */
  snapshot(): WtsSnapshot {
    const s: Record<number, string> = {};
    for (const n of this.owned.keys()) s[n] = this.table.get(n)!;
    return { v: this.saves, s };
  }

  /** Puts the editor's strings back to a snapshot; the others stay as they are. */
  restore(snap: WtsSnapshot) {
    for (const [n, o] of this.owned) {
      const entry = snap.v >= o.since ? snap.s[n] : undefined;
      const to = entry ?? o.text;
      if (this.table.get(n) === to) continue;
      this.table.set(n, to);
      o.undone = entry === undefined || snap.v < this.saves;
    }
  }

  /** Writes the editor's changes onto the file as it is now (other editors may have saved).
   *  A failed read or write stops the save and leaves the session as it was. Returns whether a
   *  string the editor shows changed (another editor's text was kept).
   *
   *  A failed read is only forgiven when `isMissing(error)` says the file is really gone (not
   *  locked, not unreadable). It is then read once more after `retryMs` (a tool that saves by
   *  delete-and-recreate leaves a moment where it is gone); only if it is still gone, the file is
   *  written anew from the editor's strings (`recreated`). */
  async save(
    read: () => Promise<string>,
    write: (text: string) => Promise<void>,
    isMissing?: (error: unknown) => Promise<boolean>,
    retryMs = 200,
  ): Promise<{ shown: boolean; recreated: boolean }> {
    if (!this.dirty) return { shown: false, recreated: false };
    let current: string | null;
    try {
      current = await read();
    } catch (e) {
      if (!isMissing || !(await isMissing(e))) throw e;
      await new Promise((r) => setTimeout(r, retryMs));
      try {
        current = await read();
      } catch (e2) {
        if (!(await isMissing(e2))) throw e2;
        current = null;
      }
    }
    if (current === null) {
      // Nothing on disk to merge with: the editor's table is the file.
      const text = this.table.serialize();
      const mine = new Map(this.table.entries());
      await write(text);
      return { shown: this.took(text, mine), recreated: true };
    }
    const disk = new StringTable(current);
    const mine = new Map(this.table.entries());
    // What to write: the editor's table, but another editor's newer text over an undo.
    const edited = new StringTable(this.table.serialize());
    for (const [n, o] of this.owned) {
      if (o.undone && disk.has(n) && norm(disk.get(n)) !== norm(this.savedValues.get(n))) edited.set(n, disk.get(n)!);
    }
    const merged = StringTable.merge(this.saved, edited, current);
    if (merged !== current) await write(merged);
    return { shown: this.took(merged, mine), recreated: false };
  }

  /** Written: now the session takes it over. Strings typed during the write stay the editor's. */
  private took(merged: string, mine: Map<number, string>): boolean {
    const next = new StringTable(merged);
    const typed = new Set<number>();
    for (const [n, v] of this.table.entries()) {
      if (v !== mine.get(n)) { next.set(n, v); typed.add(n); }
    }
    let shown = false;
    for (const [n, v] of mine) {
      if (typed.has(n) || norm(next.get(n)) === norm(v)) continue;
      this.owned.delete(n); // the other editor's now
      shown = true;
    }
    for (const o of this.owned.values()) o.undone = false;
    this.table = next;
    this.saved = merged;
    this.savedValues = new Map(new StringTable(merged).entries());
    this.saves++;
    return shown;
  }
}

/** Whether a failed read says the file is not there: Windows error 2 (file) or 3 (path). The
 *  Rust error text ends in "(os error N)" whatever the system language. */
export function isNotFoundError(e: unknown): boolean {
  return /\(os error (2|3)\)/.test(String(e)) || /^os error (2|3)$/.test(String(e));
}

/** Whether war3map.wts is really gone, and not just unreadable or in the middle of being replaced:
 *  the read said not found, the file list was refreshed (so it can be trusted) and doesn't have
 *  it, and the rest of map/ is still there (not a vanished folder). */
export function fileIsMissing(x: { error: unknown; refreshed: boolean; listed: boolean; otherMapFiles: boolean }): boolean {
  return isNotFoundError(x.error) && x.refreshed && !x.listed && x.otherMapFiles;
}

/** The packed map to point the user at: the project's build output if it exists, else the newest
 *  checkpoint (a path), else null. */
export function findPackedMap(output: string, outputExists: boolean, newestCheckpoint: string | null): string | null {
  return outputExists ? output : newestCheckpoint;
}

/** The warning shown when war3map.wts was recreated. */
export function recreatedMessage(packedMap: string | null): string {
  return "war3map.wts was missing and has been recreated from what this editor holds; strings added or changed elsewhere since may be lost."
    + (packedMap ? ` ${packedMap} may hold the old strings.` : "");
}

/** Whether a save must stop because the map folder is gone (writing would create a lone file in a
 *  half project). A new object file in a project that never had a map folder is fine. */
export function mapFolderGone(x: { folderExists: boolean; isNew: boolean; hasWts: boolean }): boolean {
  return !x.folderExists && (!x.isNew || x.hasWts);
}
