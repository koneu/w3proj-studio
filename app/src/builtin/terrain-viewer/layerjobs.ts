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
