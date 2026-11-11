// "Settled": nothing the app started is still running or waiting to run.
//
// What a test (or a tool) can wait for instead of a fixed pause after an action. `PendingWork` counts work that runs
// in the background (a write, a save, the editors' reload after a save); `settleRounds` runs the settle steps (each
// brings one kind of waiting work to an end now: a debounced rebuild, a frame still to draw) and the pending work
// in turns, until a whole round started nothing new. Work started by a step (a script written after a save, a
// reload after that write) is waited for by the next round.

/** Work in the background that can be waited for. A job that fails counts as ended: settling is about time, not
 *  about success (the job reports its own failure). */
export class PendingWork {
  private running = new Set<Promise<unknown>>();
  private count = 0;

  /** How many jobs have started so far: a round that ends with the same number started nothing. */
  get started(): number { return this.count; }
  /** Jobs running now. */
  get size(): number { return this.running.size; }

  /** Notes a job; it is returned as it is, so `await track(job)` still gets its value or its error. */
  track<T>(job: Promise<T>): Promise<T> {
    this.count++;
    const p = job.then(() => {}, () => {}).finally(() => this.running.delete(p));
    this.running.add(p);
    return job;
  }

  /** Runs `job` as tracked work. */
  run<T>(job: () => Promise<T>): Promise<T> {
    return this.track(Promise.resolve().then(job));
  }

  /** Resolves once no job runs, jobs started meanwhile included. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }
}

/** A settle step: brings one kind of waiting work to its end (or waits for it). A step that throws counts as done. */
export type SettleStep = () => unknown;

/** Runs the steps in turn, then waits for the pending work, until a round started no tracked job. Resolves with the
 *  number of rounds; throws after `maxRounds` that each started something (work that keeps starting more work). */
export async function settleRounds(steps: readonly SettleStep[], work: PendingWork, maxRounds = 20): Promise<number> {
  for (let round = 1; round <= maxRounds; round++) {
    const before = work.started;
    await work.idle();
    for (const step of steps) {
      try { await step(); } catch { /* the step's work reports its own failure */ }
      await work.idle();
    }
    if (work.started === before) return round;
  }
  throw new Error(`still busy after ${maxRounds} rounds of settling: work keeps starting more work`);
}
