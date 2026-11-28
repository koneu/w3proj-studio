// The files an Object Editor reads to open (its object file, the Skin file, the map's strings, a campaign's data),
// asked all at once: they don't depend on each other, so one after another they only added up. The outcomes are
// read in the order the editor needs them, so the errors are the same ones as before: the object file's first, then
// the Skin file's. The strings and the campaign never fail the open: a strings file that can't be read is taken as
// absent, a campaign that can't be read is told as `campaignError` (its ids then aren't known to be free).

export interface OpenReads<M, S, C> {
  main: Promise<M>;
  skin: Promise<S | null>;
  /** The strings' text; null when the file can't be read (the caller tells absent from unreadable, if it must). */
  wts: Promise<string | null>;
  campaign: Promise<{ campaign: C | null; error: string | null }>;
}

export function startOpenReads<M, S, C>(io: {
  main: () => Promise<M>;
  /** null: no Skin file to read. */
  skin: (() => Promise<S | null>) | null;
  wts: () => Promise<string>;
  /** null: this file has no campaign to ask. */
  campaign: (() => Promise<C | null>) | null;
}): OpenReads<M, S, C> {
  const main = io.main();
  const skin = io.skin ? io.skin() : Promise.resolve(null);
  // The object file failing ends the open before the Skin file's outcome is looked at: that one mustn't go unhandled.
  main.catch(() => {});
  skin.catch(() => {});
  return {
    main,
    skin,
    wts: io.wts().then((t) => t, () => null),
    campaign: io.campaign
      ? io.campaign().then((campaign) => ({ campaign, error: null }), (e) => ({ campaign: null, error: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve({ campaign: null, error: null }),
  };
}
