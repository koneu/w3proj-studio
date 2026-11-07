// The gate's scheduler: which step starts when, and the locks between them. Kept apart from
// tests/gate.mjs so that it can be tested without running any step (app/scripts/gate-scheduler.test.mjs).

/** Named locks, shared ("r": many at once) or exclusive ("w"). */
export class Locks {
  state = new Map();
  waiting = [];
  /** Called after every release, once all of its locks are free. */
  onRelease = null;
  can(name, mode) {
    const s = this.state.get(name) ?? { r: 0, w: false };
    return mode === "w" ? !s.w && s.r === 0 : !s.w;
  }
  take(name, mode) {
    const s = this.state.get(name) ?? { r: 0, w: false };
    if (mode === "w") s.w = true;
    else s.r++;
    this.state.set(name, s);
  }
  release(name, mode) {
    this.releaseAll([[name, mode]]);
  }
  /** Frees all of `held` before anyone is told: who looks next sees the whole state, not half. */
  releaseAll(held) {
    for (const [name, mode] of held) {
      const s = this.state.get(name);
      if (mode === "w") s.w = false;
      else s.r--;
    }
    this.waiting = this.waiting.filter((go) => !go());
    this.onRelease?.();
  }
  /** Waits for the lock, runs `body` holding it. First come, first served among those waiting. */
  async hold(name, mode, body) {
    await new Promise((granted) => {
      const go = () => {
        if (!this.can(name, mode)) return false;
        this.take(name, mode);
        granted();
        return true;
      };
      if (!go()) this.waiting.push(go);
    });
    try {
      return await body();
    } finally {
      this.release(name, mode);
    }
  }
}

/**
 * Runs `steps` (in the order they are started when they can be), each once, and resolves with
 * `done`: step id (and "id#built") -> { ok, seconds }.
 *
 * A step: { id, weight, after?: ids or "id#built", locks?: [[name, "r" | "w"]], built?: truthy }.
 * `launch(step, { built })` runs it and resolves with true when it passed; a step with `built` calls
 * `built()` once it is done with its locks (they are freed then, and "id#built" is done).
 * `skip(step, why)` reports a step that doesn't run (it fails).
 *
 * Steps queue in the order they became ready to run (all they come `after` done; in the order of
 * `steps` among those ready at once). A step doesn't start while one ahead of it in the queue waits
 * for a lock they can't hold together: so a step that waits for a write lock gets it once the readers
 * that were there before it are done, instead of later readers handing the lock on without a gap.
 * Steps that don't share a lock pass each other, to fill the cores.
 */
export function schedule({ steps, locks, serial = false, jobs, launch, skip: onSkip, done = new Map(), now = Date.now }) {
  const waiting = [...steps];
  const ticket = new Map();
  let nextTicket = 0;
  /** The locks of each step that runs and hasn't freed them yet. */
  const holding = new Set();
  let busy = 0;
  let running = 0;
  return new Promise((finish) => {
    locks.onRelease = () => pump();
    function pump() {
      // Who is ready now, and who never will be because a step it needs failed. A skipped step's
      // "built" event can make others ready: look again until nothing changes.
      for (let changed = true; changed; ) {
        changed = false;
        for (const step of [...waiting]) {
          const deps = (step.after ?? []).filter((id) => steps.some((s) => s.id === id.split("#")[0]));
          if (deps.some((id) => !done.has(id))) continue;
          // "step#event" only orders: a step waiting for the app's build still runs if there was none.
          const failed = deps.filter((id) => !id.includes("#") && !done.get(id).ok);
          if (failed.length) {
            skip(step, `not run: ${failed.join(", ")} failed`);
            changed = true;
            continue;
          }
          if (!ticket.has(step)) ticket.set(step, nextTicket++);
        }
      }
      const queue = waiting.filter((s) => ticket.has(s)).sort((a, b) => ticket.get(a) - ticket.get(b));
      /** The locks wanted by steps ahead in the queue that didn't start. */
      const ahead = [];
      for (const step of queue) {
        const wants = step.locks ?? [];
        const behind = wants.some(([name, mode]) => ahead.some(([n, m]) => n === name && (mode === "w" || m === "w")));
        const fits = running === 0 || (!serial && busy + step.weight <= jobs);
        if (behind || !fits || !wants.every(([name, mode]) => locks.can(name, mode))) {
          ahead.push(...wants);
          continue;
        }
        start(step);
      }
      if (waiting.length && running === 0) stalled();
      if (!waiting.length && running === 0) finish(done);
    }
    function start(step) {
      waiting.splice(waiting.indexOf(step), 1);
      const held = [...(step.locks ?? [])];
      for (const [name, mode] of held) locks.take(name, mode);
      holding.add(held);
      busy += step.weight;
      running++;
      const t0 = now();
      let freed = false;
      const free = () => {
        freed = true;
        holding.delete(held);
        locks.releaseAll(held); // and looks for what can start now
      };
      const built = () => {
        if (freed) return;
        mark(step, true);
        free();
      };
      Promise.resolve()
        .then(() => launch(step, { built }))
        .catch(() => false)
        .then((ok) => {
          mark(step, ok === true);
          done.set(step.id, { ok: ok === true, seconds: Math.round((now() - t0) / 1000) });
          busy -= step.weight;
          running--;
          if (freed) pump();
          else free();
        });
    }
    /**
     * Nothing runs and nothing could start: a step waits for something that won't come. That would
     * be a mistake in the steps; they fail instead of the gate waiting forever. Never while a step
     * still holds a lock one of them needs: its release looks again.
     */
    function stalled() {
      const needed = new Set(waiting.flatMap((s) => (s.locks ?? []).map(([name]) => name)));
      if ([...holding].some((held) => held.some(([name]) => needed.has(name)))) return;
      // What each waits for, all said before the first is skipped (that makes it "done").
      const why = waiting.map((step) => {
        const missing = (step.after ?? []).filter((id) => !done.has(id));
        const locked = (step.locks ?? []).filter(([name, mode]) => !locks.can(name, mode)).map(([name]) => `the lock "${name}", held by no step`);
        return [step, `not run: still waiting for ${[...missing, ...locked].join(", ") || "nothing it can name (a scheduler mistake)"}`];
      });
      for (const [step, text] of why) skip(step, text);
    }
    /** A step that doesn't run fails, and what waits for its events goes on. */
    function skip(step, why) {
      waiting.splice(waiting.indexOf(step), 1);
      onSkip(step, why);
      done.set(step.id, { ok: false, seconds: 0 });
      mark(step, false);
    }
    /** The step's "built" event, once: ok says whether the build happened. */
    function mark(step, ok) {
      if (step.built && !done.has(`${step.id}#built`)) done.set(`${step.id}#built`, { ok, seconds: 0 });
    }
    pump();
  });
}
