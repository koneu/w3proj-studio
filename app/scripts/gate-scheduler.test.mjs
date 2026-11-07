import test from "node:test";
import assert from "node:assert/strict";
import { Locks, schedule } from "../../tests/gate-scheduler.mjs";

/**
 * The gate's scheduler on made-up steps that end when the test says so. `steps` as in
 * tests/gate.mjs; `end(id, ok)` ends a running step and lets the scheduler react.
 */
function harness(steps, { jobs = 100, serial = false } = {}) {
  const locks = new Locks();
  const ends = new Map();
  const builts = new Map();
  const started = [];
  const skipped = new Map();
  const result = schedule({
    steps,
    locks,
    serial,
    jobs,
    launch: (step, { built }) =>
      new Promise((resolve) => {
        started.push(step.id);
        ends.set(step.id, resolve);
        builts.set(step.id, built);
      }),
    skip: (step, why) => skipped.set(step.id, why),
  });
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    locks,
    started,
    skipped,
    result,
    running: () => [...ends.keys()],
    settle,
    async end(id, ok = true) {
      const resolve = ends.get(id);
      assert.ok(resolve, `${id} isn't running (started: ${started.join(", ")})`);
      ends.delete(id);
      resolve(ok);
      await settle();
    },
    async built(id) {
      builts.get(id)();
      await settle();
    },
  };
}

// The steps of the `all` tier that share app/dist, as in tests/gate.mjs.
const distSteps = () => [
  { id: "rustcov", weight: 8, locks: [["dist", "r"]] },
  { id: "rust", weight: 4, locks: [["cargo", "w"], ["dist", "r"]] },
  { id: "clippy", weight: 4, locks: [["cargo", "w"], ["dist", "r"]] },
  { id: "ui", weight: 2, locks: [["dist", "w"]] },
];

test("a step waiting for a write lock runs after readers that hand the lock on without a gap", async () => {
  const h = harness(distSteps());
  await h.settle();
  assert.deepEqual(h.started, ["rustcov", "rust"]);
  await h.end("rust");
  await h.end("rustcov");
  // Clippy frees "cargo" before "dist": nothing runs for a moment while "dist" is still held.
  await h.end("clippy");
  assert.ok(!h.skipped.has("ui"), `ui was not run: ${h.skipped.get("ui")}`);
  assert.ok(h.started.includes("ui"), `started: ${h.started.join(", ")}`);
  await h.end("ui");
  const done = await h.result;
  for (const id of ["rustcov", "rust", "clippy", "ui"]) assert.equal(done.get(id)?.ok, true, id);
});

test("once a writer waits, a reader that comes later doesn't start before it", async () => {
  const h = harness([
    { id: "pre", weight: 1 },
    { id: "reader", weight: 1, locks: [["dist", "r"]] },
    { id: "late", weight: 1, after: ["pre"], locks: [["dist", "r"]] },
    { id: "writer", weight: 1, locks: [["dist", "w"]] },
  ]);
  await h.settle();
  assert.deepEqual(h.started, ["pre", "reader"]);
  // "late" is ready only now, after the writer began to wait.
  await h.end("pre");
  assert.ok(!h.started.includes("late"), `started: ${h.started.join(", ")}`);
  await h.end("reader");
  assert.deepEqual(h.running(), ["writer"]);
  await h.end("writer");
  assert.deepEqual(h.running(), ["late"]);
  await h.end("late");
  const done = await h.result;
  assert.equal(h.skipped.size, 0);
  assert.equal(done.size, 4);
});

test("readers that came before the writer still share the lock", async () => {
  const h = harness([
    { id: "a", weight: 1, locks: [["dist", "r"]] },
    { id: "b", weight: 1, locks: [["dist", "r"]] },
    { id: "w", weight: 1, locks: [["dist", "w"]] },
  ]);
  await h.settle();
  assert.deepEqual(h.started, ["a", "b"]);
  await h.end("a");
  await h.end("b");
  await h.end("w");
  await h.result;
});

test("a step's locks are all free before the next one is chosen", async () => {
  // When "first" ends, "cargo" and "dist" must both be free for "next", which needs both exclusively.
  const h = harness([
    { id: "first", weight: 1, locks: [["cargo", "w"], ["dist", "r"]] },
    { id: "next", weight: 1, locks: [["cargo", "w"], ["dist", "w"]] },
  ]);
  await h.settle();
  await h.end("first");
  assert.deepEqual(h.running(), ["next"]);
  assert.equal(h.skipped.size, 0);
  await h.end("next");
  await h.result;
});

test("a step that frees its locks early lets the next one start while it still runs", async () => {
  const h = harness([
    { id: "app", weight: 1, built: "Built", locks: [["dist", "w"]] },
    { id: "rust", weight: 1, after: ["app#built"], locks: [["dist", "r"]] },
  ]);
  await h.settle();
  assert.deepEqual(h.started, ["app"]);
  await h.built("app");
  assert.deepEqual(h.running(), ["app", "rust"]);
  await h.end("rust");
  await h.end("app");
  const done = await h.result;
  assert.equal(done.get("app#built").ok, true);
});

test("stall detection: steps that wait for each other fail instead of waiting forever", async () => {
  const h = harness([
    { id: "ok", weight: 1 },
    { id: "a", weight: 1, after: ["b"] },
    { id: "b", weight: 1, after: ["a"] },
  ]);
  await h.settle();
  await h.end("ok");
  const done = await h.result;
  assert.equal(done.get("ok").ok, true);
  assert.match(h.skipped.get("a"), /still waiting for b/);
  assert.match(h.skipped.get("b"), /still waiting for a/);
  assert.deepEqual(h.started, ["ok"]);
});

test("stall detection: a lock that nothing running holds and nothing will free fails the step", async () => {
  const locks = new Locks();
  locks.take("dist", "w"); // held by no step: it would never be freed
  const skipped = new Map();
  const done = await schedule({
    steps: [{ id: "ui", weight: 1, locks: [["dist", "w"]] }],
    locks,
    jobs: 10,
    launch: () => Promise.resolve(true),
    skip: (step, why) => skipped.set(step.id, why),
  });
  assert.equal(done.get("ui").ok, false);
  assert.match(skipped.get("ui"), /still waiting for .*dist/);
});

test("a step whose prerequisite failed fails without running", async () => {
  const h = harness([
    { id: "cli", weight: 1 },
    { id: "corpus", weight: 1, after: ["cli"] },
  ]);
  await h.settle();
  await h.end("cli", false);
  await h.result;
  assert.deepEqual(h.started, ["cli"]);
  assert.match(h.skipped.get("corpus"), /cli failed/);
});

test("serial: one step at a time, in the given order", async () => {
  const h = harness(distSteps(), { serial: true });
  for (const id of ["rustcov", "rust", "clippy", "ui"]) {
    await h.settle();
    assert.deepEqual(h.running(), [id]);
    await h.end(id);
  }
  await h.result;
});

test("a step waiting for a lock inside its run is served when the lock is freed", async () => {
  // As the hostile-input step builds under "cargo" while it runs.
  const h = harness([
    { id: "hostile", weight: 1 },
    { id: "rust", weight: 1, locks: [["cargo", "w"]] },
    { id: "clippy", weight: 1, locks: [["cargo", "w"]] },
  ]);
  await h.settle();
  assert.deepEqual(h.running(), ["hostile", "rust"]);
  let release;
  const holding = h.locks.hold("cargo", "w", () => new Promise((r) => (release = r)));
  await h.end("rust");
  // The waiter inside "hostile" got "cargo" first; clippy waits for it, and isn't given up on.
  assert.deepEqual(h.running(), ["hostile"]);
  assert.equal(h.skipped.size, 0);
  release();
  await holding;
  await h.settle();
  assert.deepEqual(h.running(), ["hostile", "clippy"]);
  await h.end("clippy");
  await h.end("hostile");
  await h.result;
  assert.equal(h.skipped.size, 0);
});
