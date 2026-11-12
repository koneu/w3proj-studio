// Every change an AI tool makes goes through here, so the rules hold for all of them:
//
// - Nothing is written while anything in the app is unsaved. An editor's memory and the file would
//   drift apart, and which of them wins would depend on who saves last.
// - Only files under map/. An AI that could write .w3proj/ could install its own extensions.
// - One edit at a time, reading and writing together: parallel calls can't overwrite each other.
// - The first edit of a project is preceded by a checkpoint, and each can be undone.

import { AiWordedError, projectPath } from "../../extensions/mcp";

export interface EditFile { path: string; text: string }
/** A file an edit changed by way of what it wrote (the map script, regenerated from the triggers, and its stamp). */
export interface DerivedChange { path: string; before: string | null; after: string | null }
export interface EditRecord {
  id: number; title: string; at: number; files: { path: string; before: string | null; after: string }[]; follows: EditFollow[];
  /** Derived files as they were before the edit and after it: undo puts them back where nothing changed them since. */
  derived: DerivedChange[];
}
/** Work derived from the files, after an edit and after its undo: their change is done by then. */
export type EditFollow = (undoing: boolean) => Promise<void>;

export interface EditIO {
  /** A file's text, or null if it doesn't exist. */
  read(path: string): Promise<string | null>;
  /** null: deletes it. */
  write(path: string, text: string | null): Promise<void>;
  /** Files with unsaved changes in an editor. */
  unsaved(): string[];
  /** Saves editors whose only unsaved change is view state (opened or closed trigger categories). */
  saveViewOnly?(): Promise<unknown>;
  checkpoint(): Promise<void>;
  log(line: string): void;
  /** Files made from the changed ones by work that follows a save (the map script and its stamp, from the triggers and
   *  the rest): kept as they were before the edit, so undo can put back a script that regenerating can't make again. */
  derived?(changed: string[]): string[];
  /** Waits until that work is done (the map script due after a save is written). */
  settle?(): Promise<void>;
}

/** A file an edit may touch, normalized; throws for any other. */
export function editablePath(path: string): string {
  const p = projectPath(path);
  if (!p.toLowerCase().startsWith("map/")) throw new Error(`AI edits stay inside map/: "${path}" isn't.`);
  return p;
}

export class EditLog {
  private records: EditRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private checkpointed = false;
  private next = 1;
  /** What has happened, undone edits too, for showing: it stays when an edit goes. */
  private past: { id: number; title: string; undone: boolean }[] = [];
  /** Open group: edits go into this record, which is the newest one. */
  private group: EditRecord | null = null;
  /** After an edit or an undo. */
  onChange: () => void = () => {};

  constructor(private io: EditIO, private keep = 30) {}

  /** The group edits are going into, if one is open. */
  get openGroup(): string | null {
    return this.group?.title ?? null;
  }

  /** The edits so far, newest first, with those undone marked. */
  history(): readonly { title: string; undone: boolean }[] {
    return [...this.past].reverse();
  }

  private remember(r: EditRecord) {
    this.past.push({ id: r.id, title: r.title, undone: false });
    if (this.past.length > this.keep) this.past.shift();
  }

  list(): readonly EditRecord[] {
    return this.records;
  }

  /** Another project: its edits and its checkpoint are its own. */
  reset() {
    this.records = [];
    this.past = [];
    this.group = null;
    this.checkpointed = false;
    this.onChange();
  }

  private inTurn<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private async refuseUnsaved() {
    // Opened or closed categories alone are saved, not refused.
    if (this.io.unsaved().length) await this.io.saveViewOnly?.();
    const open = this.io.unsaved();
    if (!open.length) return;
    // The app's own commands (Adjust Map String IDs, …) come here too: a person reads the first, an AI client the second.
    const what = `Not changed: ${open.join(", ")} ${open.length === 1 ? "has" : "have"} unsaved changes in the editor.`;
    throw new AiWordedError(`${what} Save or discard them first, then try again.`, `${what} Ask the user to save or discard them first.`);
  }

  /** Puts files back; a failure here is reported along with what caused it. */
  private async restore(files: { path: string; before: string | null }[]) {
    for (const f of [...files].reverse()) await this.io.write(f.path, f.before);
  }

  /** The derived files' texts (null: missing); one that can't be read is left out, so it's never written back. */
  private async readDerived(paths: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const p of paths) {
      try { out.set(p, await this.io.read(p)); } catch (e) { this.io.log(`${p} can't be read, so undo won't put it back: ${String(e)}`); }
    }
    return out;
  }

  /** Waits for the work that follows a save; its failure is only logged. */
  private async settle() {
    await this.io.settle?.().catch((e) => this.io.log(`waiting for the map script: ${String(e)}`));
  }

  /** A failure here doesn't take the edit back: files derived from it are only out of date. */
  private async followUp(title: string, follow: EditFollow | undefined, undoing: boolean) {
    await follow?.(undoing).catch((e) => this.io.log(`after "${title}": ${String(e)}`));
  }

  /** The edits from here until endGroup are one: one entry, one undo. Ends any group still open. */
  beginGroup(title: string): Promise<void> {
    return this.inTurn(async () => {
      this.group = { id: this.next++, title, at: Date.now(), files: [], follows: [], derived: [] };
    });
  }

  /** The group's title and how many files it changed, or null if none is open. */
  endGroup(): Promise<{ title: string; files: number } | null> {
    return this.inTurn(async () => {
      const g = this.group;
      this.group = null;
      return g ? { title: g.title, files: g.files.length } : null;
    });
  }

  /** `change` reads what it needs and gives the new texts. False if nothing changed. */
  edit(title: string, change: (read: (path: string) => Promise<string | null>) => Promise<EditFile[]>, follow?: EditFollow): Promise<boolean> {
    return this.inTurn(async () => {
      await this.refuseUnsaved();
      const wanted = (await change((path) => this.io.read(editablePath(path)))).map((f) => ({ path: editablePath(f.path), text: f.text }));
      const files: EditRecord["files"] = [];
      for (const f of wanted) {
        const before = await this.io.read(f.path);
        if (before !== f.text) files.push({ path: f.path, before, after: f.text });
      }
      if (!files.length) return false;
      const derivedPaths = this.io.derived?.(files.map((f) => f.path)) ?? [];
      // Work due from an earlier save belongs to the files as they are now, not to this edit.
      if (derivedPaths.length) await this.settle();
      const derivedBefore = await this.readDerived(derivedPaths);
      if (!this.checkpointed) {
        // A checkpoint is the second safety net, after undo: not reason enough to refuse.
        await this.io.checkpoint().catch((e) => this.io.log(`no checkpoint before the first AI edit: ${String(e)}`));
        this.checkpointed = true;
      }
      const done: EditRecord["files"] = [];
      try {
        for (const f of files) { done.push(f); await this.io.write(f.path, f.after); }
      } catch (e) {
        await this.restore(done).catch((e2) => this.io.log(`couldn't put files back: ${String(e2)}`));
        throw e;
      }
      const g = this.group;
      let record: EditRecord;
      if (g) {
        // First in the group: it joins the list only now, so an empty group leaves no trace.
        if (!this.records.includes(g)) { this.records.push(g); this.remember(g); }
        for (const f of files) {
          const known = g.files.find((x) => x.path === f.path);
          if (known) known.after = f.after; else g.files.push({ ...f });
        }
        if (follow) g.follows.push(follow);
        record = g;
      } else {
        record = { id: this.next++, title, at: Date.now(), files, follows: follow ? [follow] : [], derived: [] };
        this.records.push(record);
        this.remember(record);
      }
      if (this.records.length > this.keep) this.records.shift();
      this.io.log(`AI edit: ${title} (${files.map((f) => f.path).join(", ")})`);
      await this.followUp(title, follow, false);
      // The map script follows the save a moment later: what it is then is this edit's "after" (in a group, the first
      // edit's "before" stays).
      if (derivedPaths.length) {
        await this.settle();
        const after = await this.readDerived([...derivedBefore.keys()]);
        for (const [path, before] of derivedBefore) {
          if (!after.has(path)) continue;
          const now = after.get(path)!;
          const known = record.derived.find((x) => x.path === path);
          if (known) known.after = now;
          else if (now !== before) record.derived.push({ path, before, after: now });
        }
      }
      this.onChange();
      return true;
    });
  }

  /** Takes back the newest edit, unless its files changed since. Its title, or null if there's none. */
  undo(): Promise<string | null> {
    return this.inTurn(async () => {
      const last = this.records.at(-1);
      if (!last) return null;
      await this.refuseUnsaved();
      // Undoing closes a group: edits after this one wouldn't belong to anything.
      this.group = null;
      for (const f of last.files) {
        if ((await this.io.read(f.path)) !== f.after) throw new Error(`Not undone: ${f.path} changed after "${last.title}".`);
      }
      // A derived file is put back only as the edit left it: one changed since (the script edited by hand, or made
      // again from a later save) is left to the work that follows the restored files.
      if (last.derived.length) await this.settle();
      const now = await this.readDerived(last.derived.map((d) => d.path));
      const putBack = last.derived.filter((d) => {
        if (now.has(d.path) && now.get(d.path) === d.after) return true;
        this.io.log(`${d.path} changed after "${last.title}", so undo doesn't put it back; it follows the restored files instead.`);
        return false;
      });
      await this.restore(last.files);
      this.records.pop();
      const shown = this.past.find((p) => p.id === last.id);
      if (shown) shown.undone = true;
      this.io.log(`AI edit undone: ${last.title}`);
      for (const follow of [...last.follows].reverse()) await this.followUp(last.title, follow, true);
      if (last.derived.length) {
        // The restored files' own regeneration first, then the script as it was before the edit over it (a script
        // written by hand, which no regeneration makes again), with its stamp.
        await this.settle();
        for (const d of putBack) {
          if ((await this.io.read(d.path).catch(() => undefined)) !== d.before) await this.io.write(d.path, d.before);
        }
      }
      this.onChange();
      return last.title;
    });
  }
}
