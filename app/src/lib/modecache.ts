// A cache of what is read from the game's files, which differ by graphics mode (Classic, HD and DE share paths).

/** Values by graphics mode and key. One whose mode changed while it was made (its reads may be of both modes)
 *  isn't kept, nor is a make that failed (rejected): the next ask makes it again, so one flaky read doesn't stick
 *  for the session. A make that catches inside and resolves to a fallback keeps that fallback. */
export class ModeCache<T> {
  private entries = new Map<string, Promise<T>>();

  /** The value for `key` in the mode now, made by `make` the first time. */
  get(mode: () => string, key: string, make: () => Promise<T>): Promise<T> {
    const m = mode(), k = `${m}|${key}`;
    let p = this.entries.get(k);
    if (!p) {
      const made = make();
      p = made;
      this.entries.set(k, made);
      const settle = () => { if (mode() !== m && this.entries.get(k) === made) this.entries.delete(k); };
      made.then(settle, () => { if (this.entries.get(k) === made) this.entries.delete(k); });
    }
    return p;
  }

  get size(): number { return this.entries.size; }
}
