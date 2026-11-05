// Every change an AI tool makes goes through here, so the rules hold for all of them:
//
// - Nothing is written while anything in the app is unsaved. An editor's memory and the file would
//   drift apart, and which of them wins would depend on who saves last.
// - Only files under map/. An AI that could write .w3proj/ could install its own extensions.
// - One edit at a time, reading and writing together: parallel calls can't overwrite each other.
// - The first edit of a project is preceded by a checkpoint, and each can be undone.

import { projectPath } from "../../extensions/mcp";

export interface EditFile { path: string; text: string }
export interface EditRecord { id: number; title: string; at: number; files: { path: string; before: string | null; after: string }[] }

export interface EditIO {
  /** A file's text, or null if it doesn't exist. */
  read(path: string): Promise<string | null>;
  /** null: deletes it. */
  write(path: string, text: string | null): Promise<void>;
  /** Files with unsaved changes in an editor. */
  unsaved(): string[];
  checkpoint(): Promise<void>;
  log(line: string): void;
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
  /** After an edit or an undo. */
  onChange: () => void = () => {};

  constructor(private io: EditIO, private keep = 30) {}

  list(): readonly EditRecord[] {
    return this.records;
  }

  /** Another project: its edits and its checkpoint are its own. */
  reset() {
    this.records = [];
    this.checkpointed = false;
    this.onChange();
  }

  private inTurn<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private refuseUnsaved() {
    const open = this.io.unsaved();
    if (open.length) throw new Error(`Not changed: ${open.join(", ")} ${open.length === 1 ? "has" : "have"} unsaved changes in the editor. Ask the user to save or discard them first.`);
  }

  /** Puts files back; a failure here is reported along with what caused it. */
  private async restore(files: { path: string; before: string | null }[]) {
    for (const f of [...files].reverse()) await this.io.write(f.path, f.before);
  }

  /** `change` reads what it needs and gives the new texts. False if nothing changed. */
  edit(title: string, change: (read: (path: string) => Promise<string | null>) => Promise<EditFile[]>): Promise<boolean> {
    return this.inTurn(async () => {
      this.refuseUnsaved();
      const wanted = (await change((path) => this.io.read(editablePath(path)))).map((f) => ({ path: editablePath(f.path), text: f.text }));
      const files: EditRecord["files"] = [];
      for (const f of wanted) {
        const before = await this.io.read(f.path);
        if (before !== f.text) files.push({ path: f.path, before, after: f.text });
      }
      if (!files.length) return false;
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
      this.records.push({ id: this.next++, title, at: Date.now(), files });
      if (this.records.length > this.keep) this.records.shift();
      this.io.log(`AI edit: ${title} (${files.map((f) => f.path).join(", ")})`);
      this.onChange();
      return true;
    });
  }

  /** Takes back the newest edit, unless its files changed since. Its title, or null if there's none. */
  undo(): Promise<string | null> {
    return this.inTurn(async () => {
      const last = this.records.at(-1);
      if (!last) return null;
      this.refuseUnsaved();
      for (const f of last.files) {
        if ((await this.io.read(f.path)) !== f.after) throw new Error(`Not undone: ${f.path} changed after "${last.title}".`);
      }
      await this.restore(last.files);
      this.records.pop();
      this.io.log(`AI edit undone: ${last.title}`);
      this.onChange();
      return last.title;
    });
  }
}
