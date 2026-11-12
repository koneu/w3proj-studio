// What a failed checkpoint (save, restore, prune) says to the person: the backend's error carries
// the system's words in the system's language ("Die Datei existiert bereits. (os error 17)"). The
// usual causes get a plain English line; the raw text stays as "Details: ...".

/** The cause of an OS failure, from the code the backend appends ("(os error N)") or the English text. */
function cause(raw: string): string {
  const code = /\(os error (\d+)\)/i.exec(raw)?.[1];
  const n = code === undefined ? -1 : Number(code);
  // Codes: POSIX (17, 2, 13, 28) and Windows (80/183, 2/3, 5, 112).
  if (n === 17 || n === 80 || n === 183 || /already exists|EEXIST/i.test(raw)) return "exists";
  if (n === 2 || n === 3 || /no such file|not found|ENOENT|cannot find/i.test(raw)) return "missing";
  if (n === 13 || n === 5 || /permission denied|access is denied|EACCES|EPERM/i.test(raw)) return "denied";
  if (n === 28 || n === 112 || /no space left|not enough space|disk full|ENOSPC/i.test(raw)) return "full";
  return "other";
}

/** `err` (a failure while saving, restoring or pruning checkpoint `name`) as one plain sentence plus the raw text. */
export function checkpointErrorText(err: unknown, name?: string): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const what = name ? `the checkpoint ${name}` : "the checkpoint";
  const why = {
    exists: `${what} already exists. Try again in a moment.`,
    missing: `a file or folder of ${what} wasn't found. It may have been removed or moved.`,
    denied: `the system refused access to ${what}. Check that nothing else holds the files open and that you may write in the project's build folder.`,
    full: `the disk is full. Free some space, or lower "checkpoints.keep".`,
    other: `${what} couldn't be completed.`,
  }[cause(raw)];
  return `Checkpoint failed: ${why} Details: ${raw}`;
}
