// Undo steps and the unsaved state of the Object Editor, kept per object instead of per file.
//
// The editor changes its objects in place and then says which ones it touched (`commit`). Only those are written to
// a string (JSON) and compared with the text they had at the last commit; an edit is one step holding the objects'
// text before and after, never the whole file. The two lists (custom, standard) are compared by object identity, so
// adding, removing and reordering cost no serialising at all. Unsaved is "the objects' texts differ from the ones
// saved", by the cached text of each: no serialising either.

/** The objects an edit changed in place; "all" when the editor can't say (every object is then looked at). */
export type Touched<T> = readonly T[] | "all";

/** What a save wrote: the text of the file's parts. */
export interface SavedPoint {
  head: string;
  custom: string[];
  /** Only the standard objects that were written (those with modifications). */
  original: string[];
}

interface Patch<T> { obj: T; before: string; after: string }
interface Step<T> {
  patches: Patch<T>[];
  /** The two lists before and after, when they changed. */
  lists: { before: [T[], T[]]; after: [T[], T[]] } | null;
  /** The editor's other state (its strings) before and after, as the editor gave it. */
  extra: { before: string; after: string };
}

export interface LedgerOptions<T> {
  /** Whether a standard object is written (has modifications). */
  hasMods: (o: T) => boolean;
  /** The file's text apart from its two lists (version and so on). */
  head: () => string;
  /** Other state that goes with the objects (the strings): taken as text at each commit, put back by undo and redo. */
  extra: { take: () => string; put: (state: string) => void };
  /** How many undo steps are kept at most (the oldest go first). */
  limit: number;
}

const same = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((o, i) => o === b[i]);

export class ObjectLedger<T extends object> {
  /** Each object's text as of the last commit. */
  private texts = new WeakMap<T, string>();
  private lists: [T[], T[]] = [[], []];
  private extraNow = "";
  private undos: Step<T>[] = [];
  private redos: Step<T>[] = [];
  private saved: SavedPoint = { head: "", custom: [], original: [] };

  /** `file`'s two lists may be replaced by the editor; the ledger reads them each time. */
  constructor(private file: { custom: T[]; original: T[] }, private opts: LedgerOptions<T>) {
    this.reset();
  }

  /** Takes the file as it is now as the new start: no steps, every text read again. The saved point stays. */
  reset() {
    this.undos = [];
    this.redos = [];
    this.texts = new WeakMap();
    for (const o of [...this.file.custom, ...this.file.original]) this.texts.set(o, JSON.stringify(o));
    this.lists = [this.file.custom.slice(), this.file.original.slice()];
    this.extraNow = this.opts.extra.take();
  }

  private text(o: T): string {
    let t = this.texts.get(o);
    if (t === undefined) this.texts.set(o, (t = JSON.stringify(o)));
    return t;
  }

  /** Records what was changed since the last commit as one step; false, and no step, when nothing changed. Objects new
   *  to the lists are noticed by themselves; `touched` names those changed in place. */
  commit(touched: Touched<T> = "all"): boolean {
    const { custom, original } = this.file;
    const patches: Patch<T>[] = [];
    const seen = new Set<T>();
    const look = (o: T, changedInPlace: boolean) => {
      if (seen.has(o)) return;
      seen.add(o);
      const before = this.texts.get(o);
      if (before === undefined) { this.texts.set(o, JSON.stringify(o)); return; }
      if (!changedInPlace) return;
      const after = JSON.stringify(o);
      if (after === before) return;
      patches.push({ obj: o, before, after });
      this.texts.set(o, after);
    };
    for (const o of touched === "all" ? [...custom, ...original] : touched) look(o, true);
    for (const o of custom) look(o, false);
    for (const o of original) look(o, false);
    const listsChanged = !same(custom, this.lists[0]) || !same(original, this.lists[1]);
    const extra = this.opts.extra.take();
    if (!patches.length && !listsChanged && extra === this.extraNow) return false;
    const after: [T[], T[]] = listsChanged ? [custom.slice(), original.slice()] : this.lists;
    this.undos.push({ patches, lists: listsChanged ? { before: this.lists, after } : null, extra: { before: this.extraNow, after: extra } });
    if (this.undos.length > this.opts.limit) this.undos.shift();
    this.redos = [];
    this.lists = after;
    this.extraNow = extra;
    return true;
  }

  undo(): boolean {
    const step = this.undos.pop();
    if (!step) return false;
    for (let i = step.patches.length - 1; i >= 0; i--) this.put(step.patches[i].obj, step.patches[i].before);
    this.move(step.lists?.before, step.extra.before);
    this.redos.push(step);
    return true;
  }

  redo(): boolean {
    const step = this.redos.pop();
    if (!step) return false;
    for (const p of step.patches) this.put(p.obj, p.after);
    this.move(step.lists?.after, step.extra.after);
    this.undos.push(step);
    return true;
  }

  get canUndo() { return this.undos.length > 0; }
  get canRedo() { return this.redos.length > 0; }

  /** An object takes the content of `text`, staying the same object (selections and lists keep pointing at it). */
  private put(o: T, text: string) {
    const rec = o as Record<string, unknown>;
    for (const k of Object.keys(rec)) delete rec[k];
    Object.assign(rec, JSON.parse(text) as object);
    this.texts.set(o, text);
  }

  private move(lists: [T[], T[]] | undefined, extra: string) {
    if (lists) {
      this.file.custom = lists[0].slice();
      this.file.original = lists[1].slice();
      this.lists = lists;
    }
    this.opts.extra.put(extra);
    this.extraNow = extra;
  }

  /** What a save would write now, read from the objects themselves (not the cached texts): the point to give
   *  `markSaved` when the save ends. Taken when the save begins, so an edit during the save stays unsaved. */
  point(): SavedPoint { return this.pointOf(this.opts.head(), this.file.custom, this.file.original); }

  /** The point of a file made of these objects (what was read from disk, or merged from it). */
  pointOf(head: string, custom: readonly T[], original: readonly T[]): SavedPoint {
    return { head, custom: custom.map((o) => JSON.stringify(o)), original: original.filter(this.opts.hasMods).map((o) => JSON.stringify(o)) };
  }

  markSaved(point: SavedPoint) { this.saved = point; }

  /** Whether the objects now differ from what was saved (the strings are the editor's to judge). */
  differs(): boolean {
    const s = this.saved;
    const { custom, original } = this.file;
    if (this.opts.head() !== s.head || custom.length !== s.custom.length) return true;
    for (let i = 0; i < custom.length; i++) if (this.text(custom[i]) !== s.custom[i]) return true;
    let j = 0;
    for (const o of original) {
      if (!this.opts.hasMods(o)) continue;
      if (j >= s.original.length || this.text(o) !== s.original[j++]) return true;
    }
    return j !== s.original.length;
  }
}
