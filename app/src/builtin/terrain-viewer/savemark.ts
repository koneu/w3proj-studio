/** Which undo position the files on disk match. A save takes its position when the files are
 *  taken (`begin`), before any await, and records it only when the writes are done (`finish`),
 *  so an edit made meanwhile stays dirty. A new edit after an undo drops the redo steps; if that
 *  drops the saved one, the position can be reached again by other steps, so it is forgotten. */
export class SaveMark {
  private saved = 0;
  private inFlight = new Set<{ at: number }>();

  begin(at: number): { at: number } {
    const token = { at };
    this.inFlight.add(token);
    return token;
  }

  finish(token: { at: number }): void {
    if (this.inFlight.delete(token)) this.saved = token.at;
  }

  /** The save failed: nothing is recorded. */
  abort(token: { at: number }): void {
    this.inFlight.delete(token);
  }

  /** The history was cut to `at` steps by a new edit. */
  truncated(at: number): void {
    if (at < this.saved) this.saved = -1;
    for (const t of this.inFlight) if (at < t.at) t.at = -1;
  }

  isDirty(at: number): boolean {
    return at !== this.saved;
  }

  reset(): void {
    this.saved = 0;
    this.inFlight.clear();
  }
}
