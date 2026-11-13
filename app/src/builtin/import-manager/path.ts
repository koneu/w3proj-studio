// Undo and redo of the Import Manager's Change path: the entries get their old paths and flags back, the files move
// back, and the references the "Update references" answer changed get their old bytes back. Each only while things are
// as the step left them (files the same, nothing in the way, no editor holding unsaved changes of a reference file);
// otherwise it is refused before anything is changed.

import type { ReplaceFs } from "./replace";

export interface PathFs extends ReplaceFs {
  rename(from: string, to: string): Promise<void>;
  /** Whether an editor of the project file has unsaved changes. */
  isDirty(projectPath: string): boolean;
}

/** One moved entry: its path and flags before and after, and the project file that moved with it (if any). */
export interface PathMove<T> {
  entry: T;
  before: { path: string; flags: number };
  after: { path: string; flags: number };
  file?: { from: string; to: string };
}

/** A done change of path; `refs` are the reference files "Update references" rewrote (empty when it wasn't asked). */
export interface PathStep<T> { moves: PathMove<T>[]; refs: { path: string; before: Uint8Array; after: Uint8Array }[] }

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const lower = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** Undoes (`dir` -1) or redoes (1) a change of path on `doc.files`; the caller saves the list after. Throws with the
 *  reason, before anything is changed, when what the step left isn't there any more. */
export async function stepPath<T extends { path: string; flags: number }>(fs: PathFs, doc: { files: T[] }, step: PathStep<T>, dir: -1 | 1): Promise<void> {
  const from = (m: PathMove<T>) => (dir < 0 ? m.after : m.before), to = (m: PathMove<T>) => (dir < 0 ? m.before : m.after);
  const verb = dir < 0 ? "taken back" : "done again";
  for (const m of step.moves) {
    if (!doc.files.includes(m.entry) || m.entry.path !== from(m).path) throw new Error(`${from(m).path} isn't in the list as the change left it; it can't be ${verb}.`);
    const other = doc.files.find((e) => e !== m.entry && lower(e.path) === lower(to(m).path));
    if (other) throw new Error(`${to(m).path} is in the list already; it can't be ${verb}.`);
    if (m.file) {
      const [src, dst] = dir < 0 ? [m.file.to, m.file.from] : [m.file.from, m.file.to];
      if (fs.size(src) === undefined) throw new Error(`${src} isn't in the project any more; it can't be ${verb}.`);
      if (fs.size(dst) !== undefined) throw new Error(`${dst} is in the project already; it isn't written over.`);
    }
  }
  for (const r of step.refs) {
    const want = dir < 0 ? r.after : r.before;
    if (fs.size(r.path) === undefined) throw new Error(`${r.path} isn't in the project any more; it can't be ${verb}.`);
    if (fs.isDirty(r.path)) throw new Error(`${r.path} has unsaved changes in an editor; save or close it first.`);
    if (!sameBytes(await fs.readBytes(r.path), want)) throw new Error(`${r.path} changed since; its references aren't touched.`);
  }
  // The files first, then the references, then the list: a failure leaves the list saying where the files are.
  const moved: PathMove<T>[] = [], written: PathStep<T>["refs"] = [];
  try {
    for (const m of step.moves) {
      if (m.file) await fs.rename(dir < 0 ? m.file.to : m.file.from, dir < 0 ? m.file.from : m.file.to);
      moved.push(m);
    }
    for (const r of step.refs) { await fs.writeBytes(r.path, dir < 0 ? r.before : r.after); written.push(r); }
  } catch (e) {
    for (const r of written) await fs.writeBytes(r.path, dir < 0 ? r.after : r.before).catch(() => {});
    for (const m of moved.reverse()) if (m.file) await fs.rename(dir < 0 ? m.file.from : m.file.to, dir < 0 ? m.file.to : m.file.from).catch(() => {});
    throw e;
  }
  for (const m of step.moves) { m.entry.path = to(m).path; m.entry.flags = to(m).flags; }
}
