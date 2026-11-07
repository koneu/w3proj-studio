/** Which undo position the files on disk match. A save takes its position when the files are
 *  taken (`begin`), before any await, and records it only when the writes are done (`finish`),
 *  so an edit made meanwhile stays dirty. A new edit after an undo drops the redo steps; if that
 *  drops the saved one, the position can be reached again by other steps, so it is forgotten.
 *  Saves run one at a time (see `serial`), so at most one position is in flight. */
export class SaveMark {
  private saved = 0;
  private flight: number | null = null;

  begin(at: number): void {
    this.flight = at;
  }

  finish(): void {
    if (this.flight !== null) this.saved = this.flight;
    this.flight = null;
  }

  /** The save failed: nothing is recorded. */
  abort(): void {
    this.flight = null;
  }

  /** A running save took the files at this position: that step must not change any more. */
  pending(at: number): boolean {
    return this.flight === at;
  }

  /** The history was cut to `at` steps by a new edit. */
  truncated(at: number): void {
    if (at < this.saved) this.saved = -1;
    if (this.flight !== null && at < this.flight) this.flight = -1;
  }

  isDirty(at: number): boolean {
    return at !== this.saved;
  }

  reset(): void {
    this.saved = 0;
    this.flight = null;
  }
}

/** Takes what a save writes in one go, with no await, then writes it; the mark records the
 *  position of the take, not of the end. Returns what was taken. */
export async function saveSnapshot<S>(mark: SaveMark, io: {
  at: () => number;
  take: () => S;
  write: (taken: S) => Promise<void>;
  saved: () => void;
}): Promise<S> {
  mark.begin(io.at());
  const taken = io.take();
  try {
    await io.write(taken);
  } catch (e) {
    mark.abort();
    throw e;
  }
  mark.finish();
  io.saved();
  return taken;
}

/** Makes calls run one after the other, each starting only when the one before has ended, so each
 *  takes a fresh snapshot. A failed call doesn't stop the later ones. */
export function serial(work: () => Promise<void>): () => Promise<void> {
  let last: Promise<void> = Promise.resolve();
  return () => (last = last.catch(() => {}).then(work));
}

/** "Something changed since the last draw" for a file drawn from a snapshot. The save takes a
 *  token with the snapshot and cleans with it after the draw; an edit made in between has set
 *  the flag again, so it stays set and the next save draws again. */
export class Stale {
  private edits = 0;
  private cleanAt = 0;

  set(): void {
    this.edits++;
  }

  isSet(): boolean {
    return this.edits !== this.cleanAt;
  }

  take(): number {
    return this.edits;
  }

  clear(taken: number): void {
    if (taken >= this.cleanAt) this.cleanAt = taken;
  }
}
