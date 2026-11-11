// One file change at a time, with undo and redo pressed meanwhile kept for later.
//
// An editor whose changes move files on disk (Campaign Editor, Import Manager) does one such
// change at a time: `hold` runs it with the queue busy. Undo and redo go through `step`: while
// a change or an earlier step is running they wait, in the order they were pressed, and each
// runs once the one before is done, its history bookkeeping included. A change or step that
// fails drops the waiting steps (they were meant for the state it didn't reach), and so does
// `alive` turning false (the editor closed or another project opened).

/** An undo or redo: false (or a throw) when it failed. Done with the queue busy: it doesn't call `hold`. */
export type QueuedStep = () => boolean | void | Promise<boolean | void>;

export class BusyQueue {
  private running = false;
  private waiting: QueuedStep[] = [];

  /** `alive`: false once the editor closed or its project changed; waiting steps are then dropped. */
  constructor(private alive: () => boolean = () => true) {}

  /** A change or step is running: other changes are refused, undo and redo wait. */
  get busy(): boolean { return this.running; }
  /** Steps waiting for the running change. */
  get pending(): number { return this.waiting.length; }

  /** Runs a change with the queue busy (the caller has checked `busy`); waiting steps run after it,
   *  or are dropped if it throws. The busy flag is set before this returns. */
  async hold<T>(job: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error("BusyQueue.hold while busy");
    this.running = true;
    let ok = false;
    try {
      const r = await job();
      ok = true;
      return r;
    } finally {
      this.done(ok);
    }
  }

  /** Runs an undo or redo now, or after the running change and the steps waiting before it.
   *  `run` reads the history when it runs, not when it was pressed. */
  step(run: QueuedStep): void {
    if (!this.alive()) { this.waiting = []; return; }
    this.waiting.push(run);
    this.drain();
  }

  private done(ok: boolean) {
    this.running = false;
    if (!ok) this.waiting = [];
    this.drain();
  }

  /** Runs waiting steps one after the other: one that is still going (a promise) holds the queue until it ends. */
  private drain() {
    while (!this.running && this.waiting.length) {
      if (!this.alive()) { this.waiting = []; return; }
      const run = this.waiting.shift()!;
      this.running = true;
      let r: ReturnType<QueuedStep>;
      try { r = run(); } catch (e) {
        // A step shows its own errors; one it lets through is a bug, logged.
        console.error("undo/redo step failed", e);
        r = false;
      }
      if (r instanceof Promise) {
        r.then((v) => this.done(v !== false), (e) => { console.error("undo/redo step failed", e); this.done(false); });
        return;
      }
      this.running = false;
      if (r === false) this.waiting = [];
    }
  }
}
