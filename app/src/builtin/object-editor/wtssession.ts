import { StringTable } from "../../lib/formats/wts";

/** One string in a history entry. `e` says which stretch of the editor's ownership of the string
 *  the entry belongs to (see `WtsSession.epoch`). */
export type WtsSnapshot = Record<number, { e: number; t: string }>;

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
  saved: string;
  /** The strings of `saved`, to tell dirty without serializing. */
  private savedValues: Map<number, string>;
  /** The text of each string the editor owns (has changed), before its first change. */
  private origin = new Map<number, string>();
  /** Counts how often the editor gave up a string (another editor saved it). History entries
   *  from before that are stale for the string: they hold text that is no longer the editor's. */
  private epoch = new Map<number, number>();
  /** Strings put back by undo/redo and not typed since. If another editor changed one on disk
   *  since the editor saved, putting the old text back would undo their work, so it is left. */
  private undone = new Set<number>();
  /** The table's strings at the last look, to notice what changed since. */
  private known = new Map<number, string>();

  constructor(text: string) {
    this.saved = text;
    this.table = new StringTable(text);
    this.savedValues = new Map(this.table.entries());
    this.sync();
  }

  private sync() { this.known = new Map(this.table.entries()); }
  private ep(n: number) { return this.epoch.get(n) ?? 0; }

  set(n: number, text: string) { this.table.set(n, text); this.undone.delete(n); }

  /** Whether a string differs from the saved file. */
  get dirty(): boolean {
    for (const [n, v] of this.table.entries()) if (norm(v) !== norm(this.savedValues.get(n))) return true;
    return false;
  }

  /** The editor's strings now, as a history entry. Call after each change. */
  snapshot(): WtsSnapshot {
    for (const [n, v] of this.table.entries()) {
      if (this.known.get(n) !== v && !this.origin.has(n) && this.known.has(n)) this.origin.set(n, this.known.get(n)!);
    }
    this.sync();
    const out: WtsSnapshot = {};
    for (const n of this.origin.keys()) out[n] = { e: this.ep(n), t: this.table.get(n)! };
    return out;
  }

  /** Puts the editor's strings back to a snapshot; the others stay as they are. */
  restore(snap: WtsSnapshot) {
    for (const [n, orig] of this.origin) {
      const s = snap[n];
      const to = s && s.e === this.ep(n) ? s.t : orig;
      if (this.table.get(n) !== to) { this.table.set(n, to); this.undone.add(n); }
    }
    this.sync();
  }

  /** Writes the editor's changes onto the file as it is now (other editors may have saved).
   *  A failed read stops the save, as the merge needs the real file. */
  async save(read: () => Promise<string>, write: (text: string) => Promise<void>) {
    if (!this.dirty) return;
    const current = await read();
    const mine = new Map(this.table.entries());
    const disk = new StringTable(current);
    for (const n of this.undone) {
      if (disk.has(n) && norm(disk.get(n)) !== norm(this.savedValues.get(n))) this.table.set(n, disk.get(n)!);
    }
    this.undone.clear();
    const merged = StringTable.merge(this.saved, this.table, current);
    if (merged !== current) await write(merged);
    this.saved = merged;
    this.table = new StringTable(merged);
    this.savedValues = new Map(this.table.entries());
    this.sync();
    // A string another editor saved over the editor's: it is theirs now, and undo leaves it be.
    for (const n of [...this.origin.keys()]) {
      if (norm(this.table.get(n)) !== norm(mine.get(n))) { this.origin.delete(n); this.epoch.set(n, this.ep(n) + 1); }
    }
  }
}
