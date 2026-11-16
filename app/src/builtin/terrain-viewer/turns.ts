/** Jobs in a row, one at a time: the rebuilds of pathing, shadows and the minimap and a save's update of them all write
 *  the same files (the shadow map is read and written back). A job that fails doesn't hold the next. */
export class Turns {
  private tail: Promise<void> = Promise.resolve();

  /** `job` once every job queued before it has ended. */
  run<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job);
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  /** As `run`, but when the jobs before it haven't ended within `ms` it gives up: `job` never runs (and later jobs
   *  don't wait for it), and the result is `{ ran: false }`. A job that has started is waited for to its end. */
  async runWithin<T>(job: () => Promise<T>, ms: number): Promise<{ ran: true; value: T } | { ran: false }> {
    let state: "waiting" | "started" | "dropped" = "waiting";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = this.run(async () => {
      clearTimeout(timer);
      if (state === "dropped") return { ran: false as const };
      state = "started";
      return { ran: true as const, value: await job() };
    });
    const timeout = new Promise<{ ran: false }>((done) => {
      timer = setTimeout(() => {
        if (state !== "waiting") return;
        state = "dropped";
        done({ ran: false });
      }, ms);
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
