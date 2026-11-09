// Replace File (the World Editor's Import Manager ▸ Replace File…): an imported file gets the content of
// another file from disk and keeps its path in the map, its entry and its flags. Undo puts the old content
// back, redo the new one, each only while the file still holds what the step left there.

/** Files up to this size are kept in memory for undo and redo; larger ones are replaced without a way back. */
export const UNDO_LIMIT = 64 * 1024 * 1024;

/** The part of the workspace a replace uses (so a test can stand in for it). */
export interface ReplaceFs {
  readBytes(projectPath: string): Promise<Uint8Array>;
  writeBytes(projectPath: string, bytes: Uint8Array): Promise<void>;
  /** Copies a file (absolute or project paths); a project target that exists is overwritten. */
  copy(from: string, to: string): Promise<void>;
  delete(projectPath: string): Promise<void>;
  /** The size of a project file, or undefined if there is none. */
  size(projectPath: string): number | undefined;
}

/** A done replace: the project file, and its content before and after (null when too large to keep). */
export interface ReplaceStep { file: string; before: Uint8Array | null; after: Uint8Array | null }

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Puts the content of `src` (a file on disk) into the project file `file`. The new content is copied next to it
 *  first, so a source that can't be read leaves the file as it was; if the last copy fails, the old content
 *  is written back when it was kept. */
export async function replaceFile(fs: ReplaceFs, file: string, src: string, limit = UNDO_LIMIT): Promise<ReplaceStep> {
  const size = fs.size(file);
  if (size === undefined) throw new Error(`${file} isn't in the project.`);
  const before = size <= limit ? await fs.readBytes(file) : null;
  const temp = `${file}.replacing`;
  if (fs.size(temp) !== undefined) throw new Error(`${temp} is in the way; remove it first.`);
  try {
    await fs.copy(src, temp);
    const newSize = fs.size(temp);
    const after = newSize !== undefined && newSize <= limit ? await fs.readBytes(temp) : null;
    try {
      await fs.copy(temp, file);
    } catch (e) {
      if (before) await fs.writeBytes(file, before);
      throw e;
    }
    return { file, before, after };
  } finally {
    if (fs.size(temp) !== undefined) await fs.delete(temp).catch(() => {});
  }
}

/** Undoes (`dir` -1) or redoes (1) a replace: only while the file holds what the step left there (after a redo,
 *  or before an undo), so nothing written since by something else is lost. Throws with the reason otherwise. */
export async function stepReplace(fs: ReplaceFs, step: ReplaceStep, dir: -1 | 1): Promise<void> {
  const want = dir < 0 ? step.after : step.before, put = dir < 0 ? step.before : step.after;
  if (!want || !put) throw new Error(`${step.file} was too large to keep its content: this replace can't be taken back.`);
  if (fs.size(step.file) === undefined) throw new Error(`${step.file} isn't in the project any more.`);
  if (!sameBytes(await fs.readBytes(step.file), want)) throw new Error(`${step.file} changed since; it isn't written over.`);
  await fs.writeBytes(step.file, put);
}
