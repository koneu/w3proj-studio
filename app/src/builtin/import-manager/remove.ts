// Undo and redo of the Import Manager's Remove: the entries leave the list (and, when asked, their files leave the
// project); undo puts the very entries back at their places in the list and writes the deleted files again with the
// bytes they had, redo removes them again. Each only while things are as the step left them.

import { UNDO_LIMIT, type ReplaceFs } from "./replace";

/** A done remove: the entries with their place in the list (ascending), and the files deleted with them
 *  (`bytes` null when too large to keep: such a step can't be taken back). */
export interface RemoveStep<T> { entries: { entry: T; index: number }[]; files: { path: string; bytes: Uint8Array | null }[] }

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Reads the content of the files about to be deleted, as far as `limit` bytes in all allow (the rest gets null). */
export async function keepFiles(fs: ReplaceFs, paths: string[], limit = UNDO_LIMIT): Promise<RemoveStep<unknown>["files"]> {
  const out: RemoveStep<unknown>["files"] = [];
  let total = 0;
  for (const path of paths) {
    const size = fs.size(path);
    if (size === undefined) continue;
    if (total + size > limit) { out.push({ path, bytes: null }); continue; }
    total += size;
    out.push({ path, bytes: await fs.readBytes(path) });
  }
  return out;
}

/** The step for entries `gone` (as they stand in `list`, before they are taken out) and the `files` of them deleted. */
export function removeStep<T>(list: readonly T[], gone: ReadonlySet<T>, files: RemoveStep<T>["files"]): RemoveStep<T> {
  return { entries: list.flatMap((entry, index) => (gone.has(entry) ? [{ entry, index }] : [])), files };
}

/** Undoes (`dir` -1) or redoes (1) a remove on `doc.files`; the caller saves the list after. Throws with the reason,
 *  before anything is changed, if the list or the files aren't as the step left them (or its files weren't kept). */
export async function stepRemove<T>(fs: ReplaceFs, doc: { files: T[] }, step: RemoveStep<T>, dir: -1 | 1): Promise<void> {
  const inList = (e: T) => doc.files.includes(e);
  if (step.files.some((f) => !f.bytes)) throw new Error(`${step.files.find((f) => !f.bytes)!.path} was too large to keep its content: this remove can't be taken back.`);
  if (dir < 0) {
    if (step.entries.some((s) => inList(s.entry))) throw new Error("An entry of it is in the list again; nothing is put back.");
    const taken = step.files.find((f) => fs.size(f.path) !== undefined);
    if (taken) throw new Error(`${taken.path} is in the project again; it isn't written over.`);
    for (const f of step.files) await fs.writeBytes(f.path, f.bytes!);
    // Ascending indexes: each goes in at its old place, the earlier ones already back.
    for (const { entry, index } of step.entries) doc.files.splice(Math.min(index, doc.files.length), 0, entry);
  } else {
    if (step.entries.some((s) => !inList(s.entry))) throw new Error("An entry of it is gone from the list already; nothing is removed.");
    for (const f of step.files) {
      if (fs.size(f.path) !== undefined && !sameBytes(await fs.readBytes(f.path), f.bytes!)) throw new Error(`${f.path} changed since; it isn't deleted.`);
    }
    for (const f of step.files) if (fs.size(f.path) !== undefined) await fs.delete(f.path);
    const gone = new Set(step.entries.map((s) => s.entry));
    doc.files.splice(0, doc.files.length, ...doc.files.filter((e) => !gone.has(e)));
  }
}
