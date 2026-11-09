// A set of listeners for a module's "did change" event (a service's onDidEdit and the like).

export class Listeners<T = void> {
  private set = new Set<(value: T) => void>();

  /** Adds a listener; its dispose takes it out again. */
  add(listener: (value: T) => void): { dispose(): void } {
    this.set.add(listener);
    return { dispose: () => { this.set.delete(listener); } };
  }

  /** Tells every listener: one that throws doesn't stop the others or the caller. Listeners added or removed by a
   *  listener count from the next time. */
  fire(value: T) {
    for (const l of [...this.set]) {
      try { l(value); } catch (e) { console.error(e); }
    }
  }

  get size() { return this.set.size; }
}
