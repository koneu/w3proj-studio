/** One refresh of the view layers. `start` draws what is quick and returns the parts still being
 *  worked out; the busy label shows while they are out. For the latest refresh the label always
 *  ends hidden, also when `start` throws before returning (a layer that fails at once): a refresh
 *  that came later and threw would otherwise leave on the label an earlier one put up.
 *  Resolves with the first failure, thrown or rejected, or null. */
export async function runLayerJobs(
  start: () => Promise<unknown>[],
  isLatest: () => boolean,
  setBusy: (busy: boolean) => void,
): Promise<{ error: unknown } | null> {
  try {
    const late = start();
    if (isLatest()) setBusy(late.length > 0);
    const failed = (await Promise.allSettled(late)).find((r): r is PromiseRejectedResult => r.status === "rejected");
    return failed ? { error: failed.reason } : null;
  } catch (error) {
    return { error };
  } finally {
    if (isLatest()) setBusy(false);
  }
}

/** A reload whose newest start wins: each call starts `load`, and its result reaches `apply` only if no later call
 *  started meanwhile and `alive` still holds, so an older load that finishes after a newer one (a slow read of the
 *  lighting before a save, a tileset switch) can't put back the old values. A failed load is dropped.
 *  Returns the promise of the started load's handling. */
export function newestOnly<T>(load: () => Promise<T>, apply: (value: T) => void, alive: () => boolean = () => true): () => Promise<void> {
  let seq = 0;
  return () => {
    const mine = ++seq;
    let started: Promise<T>;
    try { started = load(); } catch (e) { started = Promise.reject(e); }
    return started.then((value) => { if (mine === seq && alive()) apply(value); }, () => {});
  };
}
