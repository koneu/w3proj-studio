import test from "node:test";
import assert from "node:assert/strict";
import { Locks, schedule } from "../../tests/gate-scheduler.mjs";

/**
 * The gate's scheduler on made-up steps that end when the test says so. `steps` as in
 * tests/gate.mjs; `end(id, ok)` ends a running step and lets the scheduler react.
 */
function harness(steps, { jobs = 100, serial = false, memBudget } = {}) {
  const locks = new Locks();
  const ends = new Map();
  const builts = new Map();
  const started = [];
  const skipped = new Map();
  const memWaits = [];
  const result = schedule({
    steps,
    locks,
    serial,
    jobs,
    memBudget,
    onMemWait: (step, { used, budget }) => memWaits.push(`${step.id} ${used}/${budget}`),
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
    memWaits,
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

// ---- memory ----

const memSteps = () => [
  { id: "wts", weight: 1, mem: 4000 },
  { id: "corpus", weight: 1, mem: 4000 },
  { id: "seeds", weight: 1, mem: 4000 },
];

test("memory: a step starts only while the running steps' estimates stay within the budget, and says it waits once", async () => {
  const h = harness(memSteps(), { memBudget: 10000 });
  await h.settle();
  assert.deepEqual(h.running(), ["wts", "corpus"]);
  assert.deepEqual(h.memWaits, ["seeds 8000/10000"]);
  await h.end("wts");
  assert.deepEqual(h.running(), ["corpus", "seeds"]);
  await h.end("corpus");
  await h.end("seeds");
  await h.result;
  assert.deepEqual(h.memWaits, ["seeds 8000/10000"]);
  assert.equal(h.skipped.size, 0);
});

test("memory, control: without a budget all start together and nobody waits", async () => {
  const h = harness(memSteps());
  await h.settle();
  assert.deepEqual(h.running(), ["wts", "corpus", "seeds"]);
  assert.deepEqual(h.memWaits, []);
  for (const id of ["wts", "corpus", "seeds"]) await h.end(id);
  await h.result;
});

test("memory: a step bigger than the whole budget runs alone instead of never", async () => {
  const h = harness(
    [
      { id: "small", weight: 1, mem: 1000 },
      { id: "big", weight: 1, mem: 8000 },
      { id: "small2", weight: 1, mem: 1000 },
    ],
    { memBudget: 5000 },
  );
  await h.settle();
  // Smaller ones pass the big one while it waits; it runs once nothing else does.
  assert.deepEqual(h.running(), ["small", "small2"]);
  await h.end("small");
  await h.end("small2");
  assert.deepEqual(h.running(), ["big"]);
  await h.end("big");
  const done = await h.result;
  assert.equal(done.get("big").ok, true);
  assert.equal(h.skipped.size, 0);
});

test("memory: a big step that comes first runs alone, the rest after it", async () => {
  const h = harness(
    [
      { id: "big", weight: 1, mem: 8000 },
      { id: "small", weight: 1, mem: 1000 },
    ],
    { memBudget: 5000 },
  );
  await h.settle();
  assert.deepEqual(h.running(), ["big"]);
  await h.end("big");
  assert.deepEqual(h.running(), ["small"]);
  await h.end("small");
  await h.result;
});

test("memory: a step without an estimate counts as the default (1000 MB)", async () => {
  const h = harness([{ id: "a", weight: 1 }, { id: "b", weight: 1 }], { memBudget: 1500 });
  await h.settle();
  assert.deepEqual(h.running(), ["a"]);
  await h.end("a");
  assert.deepEqual(h.running(), ["b"]);
  await h.end("b");
  await h.result;
});

test("memory: a step waiting for cores or a lock isn't said to wait for memory", async () => {
  const h = harness(
    [
      { id: "a", weight: 1, mem: 4000, locks: [["cargo", "w"]] },
      { id: "b", weight: 1, mem: 4000, locks: [["cargo", "w"]] },
    ],
    { memBudget: 5000 },
  );
  await h.settle();
  assert.deepEqual(h.running(), ["a"]);
  assert.deepEqual(h.memWaits, []);
  await h.end("a");
  await h.end("b");
  await h.result;
});

// The gate's long chain: the smoke parts become ready late (after the app's build) and need much memory.
const chainSteps = () => [
  { id: "build", weight: 1, mem: 2000, priority: 1 },
  { id: "part1", weight: 1, mem: 6000, priority: 1, after: ["build"] },
  { id: "part2", weight: 1, mem: 6000, priority: 1, after: ["build"] },
  { id: "corpus", weight: 1, mem: 9000 },
  { id: "tests", weight: 1, mem: 5000 },
  { id: "small", weight: 1, mem: 3000 },
];

test("priority: while a step with priority waits for memory, what gets free is kept for it", async () => {
  const h = harness(chainSteps(), { memBudget: 14000 });
  await h.settle();
  // build 2000 + corpus 9000 + small 3000; tests (5000) doesn't fit.
  assert.deepEqual(h.running(), ["build", "corpus", "small"]);
  await h.end("build");
  // 12000 in use: neither part fits, and `tests`, ready long before them, doesn't take the 2000 that got free
  // (nor would it fit); nothing starts.
  assert.deepEqual(h.running(), ["corpus", "small"]);
  await h.end("small");
  // 9000 in use, 5000 free: `tests` would fit, but the parts are saved for.
  assert.deepEqual(h.running(), ["corpus"]);
  await h.end("corpus");
  // Both parts (12000) start; `tests` waits for one of them.
  assert.deepEqual(h.running(), ["part1", "part2"]);
  await h.end("part1");
  assert.deepEqual(h.running(), ["part2", "tests"]);
  await h.end("part2");
  await h.end("tests");
  await h.result;
  assert.deepEqual(h.started, ["build", "corpus", "small", "part1", "part2", "tests"]);
  assert.equal(h.skipped.size, 0);
});

test("priority, control: the same steps without priority let the smaller step pass the parts", async () => {
  const h = harness(chainSteps().map(({ priority, ...s }) => s), { memBudget: 14000 });
  await h.settle();
  await h.end("build");
  await h.end("small");
  assert.deepEqual(h.running(), ["corpus", "tests"]);
  for (const id of ["corpus", "tests", "part1", "part2"]) await h.end(id);
  await h.result;
});

test("priority: a step with priority starts before ready steps without, also for the cores and a lock", async () => {
  const h = harness(
    [
      { id: "ui", weight: 2, locks: [["dist", "w"]] },
      { id: "tests", weight: 2 },
      { id: "appbuild", weight: 2, priority: 1, locks: [["dist", "w"]] },
    ],
    { jobs: 2 },
  );
  await h.settle();
  assert.deepEqual(h.running(), ["appbuild"]);
  await h.end("appbuild");
  assert.deepEqual(h.running(), ["ui"]);
  await h.end("ui");
  await h.end("tests");
  await h.result;
});

test("priority: a step with priority that waits for a lock or a prerequisite holds nobody back", async () => {
  const h = harness(
    [
      { id: "holder", weight: 1, mem: 1000, locks: [["dist", "w"]] },
      { id: "first", weight: 1, mem: 1000, priority: 1, after: ["holder"] },
      { id: "locked", weight: 1, mem: 1000, priority: 1, locks: [["dist", "w"]] },
      { id: "other", weight: 1, mem: 1000 },
    ],
    { memBudget: 10000 },
  );
  await h.settle();
  // `locked` (priority) is first in the queue and takes the lock; `holder` waits for it, `first` for `holder`.
  assert.deepEqual(h.running(), ["locked", "other"]);
  await h.end("locked");
  assert.deepEqual(h.running(), ["other", "holder"]);
  for (const id of ["other", "holder", "first"]) await h.end(id);
  await h.result;
  assert.equal(h.skipped.size, 0);
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
