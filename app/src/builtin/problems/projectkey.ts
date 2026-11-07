/** What identifies the open project for the results of the checks: they belong to it, and are
 *  dropped when another project (or none) is open. Re-opening the same folder counts as another
 *  open: the files may have changed on disk. */
export function resultsStale(ranFor: string | null, nowOpen: string | null): boolean {
  return ranFor !== nowOpen;
}
