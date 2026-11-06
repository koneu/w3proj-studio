import { StringTable } from "../../lib/formats/wts";

/** What the object editor holds of war3map.wts, with undo that only touches the strings the
 *  editor itself changed: strings other editors saved meanwhile are kept when it undoes past one
 *  of its saves. A snapshot is the editor's strings only (number → text), not the whole file. */
export class WtsSession {
  table: StringTable;
  /** The file as last read or saved (the base for merging). */
  saved: string;
  /** The text of each string the editor has changed, before its first change. */
  private origin = new Map<number, string>();
  /** The table's strings at the last look, to notice what changed since. */
  private known = new Map<number, string>();

  constructor(text: string) {
    this.saved = text;
    this.table = new StringTable(text);
    this.sync();
  }

  private sync() { this.known = new Map(this.table.entries()); }

  set(n: number, text: string) { this.table.set(n, text); }

  get dirty(): boolean { return this.table.serialize() !== this.saved; }

  /** The editor's strings now, as a history entry. Call after each change. */
  snapshot(): Record<number, string> {
    for (const [n, v] of this.table.entries()) {
      if (this.known.get(n) !== v && !this.origin.has(n) && this.known.has(n)) this.origin.set(n, this.known.get(n)!);
    }
    this.sync();
    const out: Record<number, string> = {};
    for (const n of this.origin.keys()) out[n] = this.table.get(n)!;
    return out;
  }

  /** Puts the editor's strings back to a snapshot; the others stay as they are. */
  restore(snap: Record<number, string>) {
    for (const [n, orig] of this.origin) this.table.set(n, snap[n] ?? orig);
    this.sync();
  }

  /** Writes the editor's changes onto the file as it is now (other editors may have saved). */
  async save(read: () => Promise<string>, write: (text: string) => Promise<void>) {
    if (!this.dirty) return;
    const current = await read().catch(() => this.saved);
    const merged = StringTable.merge(this.saved, this.table, current);
    if (merged !== current) await write(merged);
    this.saved = merged;
    this.table = new StringTable(merged);
    this.sync();
  }
}
