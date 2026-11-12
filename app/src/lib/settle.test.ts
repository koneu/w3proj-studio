import assert from "node:assert/strict";
import { test } from "node:test";
import { DueTimer, PendingWork, settleRounds, whileRunning } from "./settle";

/** A promise and the hands to end it. */
function gate<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("idle waits for every running job, and for jobs started while it waits", async () => {
  const work = new PendingWork();
  const a = gate(), b = gate();
  work.track(a.promise);
  let idle = false;
  const waiting = work.idle().then(() => { idle = true; });
  // Started while idle() waits for the first.
  a.promise.then(() => work.track(b.promise));
  a.resolve();
  await tick();
  assert.equal(idle, false, "the job started meanwhile still runs (control: a single wait on the first job ends here)");
  assert.equal(work.size, 1);
  b.resolve();
  await waiting;
  assert.equal(idle, true);
  assert.equal(work.size, 0);
  assert.equal(work.started, 2);
});

test("a failed job counts as ended, and track hands its error to the caller", async () => {
  const work = new PendingWork();
  const g = gate();
  const tracked = work.track(g.promise);
  g.reject(new Error("disk full"));
  await assert.rejects(tracked, /disk full/);
  await work.idle();
  assert.equal(work.size, 0);
});

test("idle with nothing running resolves at once", async () => {
  const work = new PendingWork();
  await work.idle();
  assert.equal(work.started, 0);
});

test("settleRounds goes round again while a step starts work, and stops at the first quiet round", async () => {
  const work = new PendingWork();
  const order: string[] = [];
  // A save that sets off a script write, which sets off a reload: three rounds start work, the fourth is quiet.
  let chain = 3;
  const step = () => {
    order.push("step");
    if (chain-- > 0) work.run(async () => { await tick(); order.push("job"); });
  };
  const rounds = await settleRounds([step], work);
  assert.equal(rounds, 4);
  assert.deepEqual(order, ["step", "job", "step", "job", "step", "job", "step"]);
  assert.equal(work.size, 0);
});

test("settleRounds waits for work already running before it calls the steps", async () => {
  const work = new PendingWork();
  const g = gate();
  let doneFirst = false;
  work.track(g.promise.then(() => { doneFirst = true; }));
  let seen: boolean | null = null;
  const settling = settleRounds([() => { seen ??= doneFirst; }], work);
  await tick();
  assert.equal(seen, null, "no step before the running job ended");
  g.resolve();
  await settling;
  assert.equal(seen, true);
});

test("a step that throws doesn't stop the others", async () => {
  const work = new PendingWork();
  let ran = false;
  await settleRounds([() => { throw new Error("no terrain"); }, async () => { ran = true; }], work);
  assert.equal(ran, true);
});

test("DueTimer runs its job once after the last schedule, and runNow runs a waiting job at once", async () => {
  let runs = 0;
  const t = new DueTimer(() => { runs++; }, 20);
  assert.equal(t.runNow(), false, "nothing waits: nothing runs");
  assert.equal(runs, 0);
  t.schedule();
  t.schedule();
  assert.equal(t.due, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 1, "two schedules in a row run the job once, after the delay");
  assert.equal(t.due, false);
  t.schedule();
  assert.equal(t.runNow(), true);
  assert.equal(runs, 2, "runNow runs the waiting job without its delay");
  assert.equal(t.due, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 2, "and the delay's run doesn't come on top (control: a timer left running would run it again)");
  t.schedule();
  t.cancel();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 2, "a cancelled job doesn't run");
});

test("whileRunning waits for the job that a job starts as it ends, and for nothing when none runs", async () => {
  let current: Promise<void> | null = null;
  await whileRunning(() => current);
  const a = gate(), b = gate();
  let done = false;
  current = a.promise.then(() => { current = b.promise; });
  const waiting = whileRunning(() => current).then(() => { done = true; });
  a.resolve();
  await tick();
  assert.equal(done, false, "the second job still runs (control: one wait on the first job would end here)");
  b.resolve();
  await waiting;
  assert.equal(done, true);
  // A job that ended and stays named (a failed one nobody cleared) ends the wait instead of going round for ever.
  current = Promise.reject(new Error("unreadable"));
  await whileRunning(() => current);
});

test("settleRounds gives up on work that keeps starting more work", async () => {
  const work = new PendingWork();
  await assert.rejects(settleRounds([() => work.run(async () => {})], work, 5), /still busy after 5 rounds/);
});
