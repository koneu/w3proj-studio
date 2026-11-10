// Before a sync from a map deletes files of the project the map doesn't have (ones the user added under map/,
// a chapter map no longer in the campaign), the user is asked. The backend refuses such a sync with
// `WOULD_DELETE: <JSON list>` (`project_unpack` with `refuseDeletes`) and writes nothing.

/** The files a refused sync would delete (from the project root, a chapter map's folder ending in `/`); null when
 *  the error is another one. */
export function wouldDelete(error: unknown): string[] | null {
  const msg = error instanceof Error ? error.message : String(error);
  const at = msg.indexOf("WOULD_DELETE: ");
  if (at < 0) return null;
  try {
    const list: unknown = JSON.parse(msg.slice(at + "WOULD_DELETE: ".length));
    return Array.isArray(list) && list.every((x) => typeof x === "string") ? list : null;
  } catch {
    return null;
  }
}

/** The question before such a sync; the first action deletes, the second shows the list. */
export function deleteQuestion(gone: string[], map: string): { message: string; actions: string[] } {
  const n = gone.length;
  const shown = gone.slice(0, 3).join(", ") + (n > 3 ? ` and ${n - 3} more` : "");
  return {
    message: `Syncing from ${map} removes ${n} ${n === 1 ? "file" : "files"} of the project that the map doesn't have: ${shown}.`
      + ` What isn't in git or a checkpoint can't be got back. Remove ${n === 1 ? "it" : "them"} and sync?`,
    actions: ["Remove and sync", "Show list", "Cancel"],
  };
}

/** The question before the Campaign Editor's Replace Map leaves out files of the chapter's project that the new map
 *  doesn't have (`gone`, from the campaign's root); the first action replaces. They aren't deleted: they move into
 *  build/ with the old map, which git ignores. */
export function replaceQuestion(gone: string[], map: string, src: string): { message: string; actions: string[] } {
  const n = gone.length;
  const shown = gone.slice(0, 3).join(", ") + (n > 3 ? ` and ${n - 3} more` : "");
  return {
    message: `${src} doesn't have ${n} ${n === 1 ? "file" : "files"} of ${map}'s project: ${shown}. Replacing moves ${n === 1 ? "it" : "them"}`
      + " out of the project with the old map, into build/campaign-maps (which git ignores); Ctrl+Z puts the old map back while Studio stays open. Replace anyway?",
    actions: ["Replace", "Cancel"],
  };
}
