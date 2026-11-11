import assert from "node:assert/strict";
import { test } from "node:test";
import { BusyQueue } from "./busyqueue";

/** A change that runs until `finish` (or `fail`) is called. */
function gate() {
  let finish!: () => void, fail!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => { finish = res; fail = rej; });
  return { done, finish, fail };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** An editor's history as the Import Manager keeps it: `at` steps done; each step moves files before it counts. */
function editor(q: BusyQueue) {
  const log: string[] = [];
  const moves: ReturnType<typeof gate>[] = [];
  let at = 1;
  const steps = 2;
  const step = (dir: -1 | 1) => q.step(async () => {
    if (dir < 0 ? at === 0 : at === steps) { log.push(`${dir < 0 ? "undo" : "redo"}: nothing`); return; }
    const move = gate();
    moves.push(move);
    try { await move.done; } catch { log.push("failed"); return false; }
    at += dir;
    log.push(`${dir < 0 ? "undo" : "redo"} -> ${at}`);
  });
  return { log, moves, step, at: () => at };
}

test("a step while nothing runs starts at once", () => {
  const q = new BusyQueue();
  let ran = 0;
  q.step(() => { ran++; });
  assert.equal(ran, 1);
  assert.equal(q.pending, 0);
});

test("undo and redo pressed during a move wait for it and run in order, each after the one before", async () => {
  const q = new BusyQueue();
  const e = editor(q);
  const replace = gate();
  const running = q.hold(() => replace.done);
  assert.equal(q.busy, true);
  e.step(-1);
  e.step(-1);
  e.step(1);
  assert.deepEqual(e.log, []);
  assert.equal(q.pending, 3);
  replace.finish();
  await running;
  // The first undo holds the queue now; the others wait for its move.
  assert.equal(q.busy, true);
  assert.equal(q.pending, 2);
  assert.equal(e.moves.length, 1);
  e.moves[0].finish();
  await tick();
  assert.deepEqual(e.log, ["undo -> 0", "undo: nothing"]);
  assert.equal(e.moves.length, 2, "the redo's move started after the second undo found nothing to do");
  e.moves[1].finish();
  await tick();
  assert.deepEqual(e.log, ["undo -> 0", "undo: nothing", "redo -> 1"]);
  assert.equal(q.busy, false);
  assert.equal(q.pending, 0);
});

test("a step reads the history when it runs, not when it was pressed", async () => {
  const q = new BusyQueue();
  const e = editor(q);
  const replace = gate();
  const running = q.hold(() => replace.done);
  e.step(-1);
  e.step(-1);
  replace.finish();
  await running;
  e.moves[0].finish();
  await tick();
  assert.equal(e.at(), 0);
  assert.deepEqual(e.log, ["undo -> 0", "undo: nothing"]);
});

test("a move that fails drops the steps waiting for it", async () => {
  const q = new BusyQueue();
  const e = editor(q);
  const replace = gate();
  const running = q.hold(() => replace.done);
  e.step(-1);
  e.step(1);
  replace.fail(new Error("disk full"));
  await assert.rejects(running, /disk full/);
  assert.equal(q.busy, false);
  assert.equal(q.pending, 0);
  assert.deepEqual(e.log, []);
  assert.equal(e.moves.length, 0);
});

test("an undo whose files can't move drops the steps after it", async () => {
  const q = new BusyQueue();
  const e = editor(q);
  e.step(-1);
  e.step(1);
  assert.equal(q.pending, 1);
  e.moves[0].fail(new Error("taken"));
  await tick();
  assert.deepEqual(e.log, ["failed"]);
  assert.equal(q.pending, 0);
  assert.equal(e.moves.length, 1);
});

test("the editor closed or another project opened during the move: the waiting steps are dropped", async () => {
  let alive = true;
  const q = new BusyQueue(() => alive);
  const e = editor(q);
  const replace = gate();
  const running = q.hold(() => replace.done);
  e.step(-1);
  alive = false;
  replace.finish();
  await running;
  assert.equal(q.pending, 0);
  assert.deepEqual(e.log, []);
  e.step(1);
  assert.equal(q.pending, 0, "a step after the close isn't kept either");
  assert.equal(e.moves.length, 0);
});

test("a step that throws counts as failed: the steps after it are dropped, the queue takes new ones", async () => {
  const q = new BusyQueue();
  const ran: string[] = [];
  const logged: unknown[] = [];
  const quiet = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    for (const bad of [() => { throw new Error("bug"); }, async () => { await tick(); throw new Error("bug"); }]) {
      const replace = gate();
      const running = q.hold(() => replace.done);
      q.step(bad);
      q.step(() => { ran.push("after"); });
      replace.finish();
      await running;
      await tick();
      await tick();
      assert.equal(q.busy, false);
      assert.equal(q.pending, 0);
    }
  } finally { console.error = quiet; }
  assert.equal(ran.length, 0);
  assert.equal(logged.length, 2);
  q.step(() => { ran.push("new"); });
  assert.deepEqual(ran, ["new"]);
});

test("steps without a file move run one after the other at once once the move is done", async () => {
  const q = new BusyQueue();
  const replace = gate();
  const running = q.hold(() => replace.done);
  let n = 0;
  const seen: number[] = [];
  q.step(() => { n++; seen.push(n); });
  q.step(() => { n++; seen.push(n); });
  replace.finish();
  await running;
  assert.deepEqual(seen, [1, 2]);
  assert.equal(q.busy, false);
});

test("a step holds the queue (busy: changes are refused) until it ends; a step pressed meanwhile waits for it", async () => {
  const q = new BusyQueue();
  const e = editor(q);
  e.step(-1);
  assert.equal(q.busy, true);
  e.step(1);
  assert.equal(q.pending, 1);
  e.moves[0].finish();
  await tick();
  assert.equal(e.moves.length, 2);
  e.moves[1].finish();
  await tick();
  assert.deepEqual(e.log, ["undo -> 0", "redo -> 1"]);
});

test("hold refuses while busy: the caller checks first", async () => {
  const q = new BusyQueue();
  const replace = gate();
  const running = q.hold(() => replace.done);
  await assert.rejects(q.hold(async () => {}), /while busy/);
  replace.finish();
  await running;
  assert.equal(q.busy, false);
});
