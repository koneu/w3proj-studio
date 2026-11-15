// The Import Manager's list writes: one at a time, in the order asked for, each writing the list as it is when its
// turn comes (so the last state asked for is the one on disk). The tab is dirty from the moment a write is asked for
// until a write lands that holds the list as it is then: a change made while a write was running stays dirty.

export interface ListWriterOptions {
  /** The list as it is now, as text (what a write puts on disk, and what tells whether it changed meanwhile). */
  snapshot: () => string;
  /** Writes one snapshot to disk. */
  persist: (text: string) => Promise<void>;
  setDirty: (dirty: boolean) => void;
}

/** A `write()` for the list: resolves when its own write has landed, rejects with its own failure (a failed write
 *  doesn't stop the ones after it; the tab stays dirty until one lands). */
export function listWriter(o: ListWriterOptions): () => Promise<void> {
  let tail: Promise<unknown> = Promise.resolve();
  return () => {
    o.setDirty(true);
    const run = tail.then(async () => {
      const text = o.snapshot();
      await o.persist(text);
      if (o.snapshot() === text) o.setDirty(false);
    });
    tail = run.catch(() => {});
    return run;
  };
}
