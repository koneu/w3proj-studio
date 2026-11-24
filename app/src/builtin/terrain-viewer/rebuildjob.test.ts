import { test } from "node:test";
import assert from "node:assert/strict";
import { RebuildJobs } from "./rebuildjob";

type From = { n: number };

/** A rig: the project, the open editor and the terrain file are fields a test changes; the derives are logged. */
function rig(over: { open?: () => Promise<void>; saved?: () => Promise<void> } = {}) {
  const s = { project: "A" as string | null, editor: "A" as string | null, path: "w.w3e" as string | null, log: [] as string[] };
  const jobs = new RebuildJobs<From>({
    project: () => s.project,
    editorRoot: () => s.editor,
    terrainPath: () => s.path,
    deriveOpen: async (from) => { s.log.push(`open ${from.n}`); await over.open?.(); },
    deriveSaved: async (key, path, from) => { s.log.push(`saved ${key} ${path} ${from.n}`); await over.saved?.(); },
    delayMs: 60_000,
  });
  return { s, jobs };
}

test("a settle runs the due rebuild once, from the state before the first edit", async () => {
  const { s, jobs } = rig();
  jobs.soon(() => ({ n: 1 }));
  jobs.soon(() => ({ n: 2 }));
  assert.equal(jobs.pending, true);
  await jobs.settle();
  assert.deepEqual(s.log, ["open 1"]);
  assert.equal(jobs.pending, false);
  await jobs.settle();
  assert.deepEqual(s.log, ["open 1"], "nothing due: nothing runs");
});

test("a failed rebuild is not due again: later settles don't wait for it or run it again", async () => {
  let fail = true;
  const { s, jobs } = rig({ open: async () => { if (fail) throw new Error("disk full"); } });
  jobs.soon(() => ({ n: 1 }));
  await assert.rejects(jobs.settle(), /disk full/);
  assert.equal(jobs.pending, false, "the failure cleared the pending job");
  fail = false;
  await jobs.settle();
  await jobs.settle();
  assert.deepEqual(s.log, ["open 1"], "later settles find nothing to run");
  // A new edit makes a new job that works again.
  jobs.soon(() => ({ n: 2 }));
  await jobs.settle();
  assert.deepEqual(s.log, ["open 1", "open 2"]);
});

test("a rebuild that fails in the timer does not stop the next one", async () => {
  const { s, jobs } = rig({ open: async () => { throw new Error("x"); } });
  jobs.soon(() => ({ n: 1 }));
  await assert.rejects(jobs.settle());
  const t0 = Date.now();
  await jobs.settle();
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(s.log, ["open 1"]);
});

test("editor closed since the edit: the files are made from the saved ones; a failure clears the job too", async () => {
  let fail = true;
  const { s, jobs } = rig({ saved: async () => { if (fail) throw new Error("unreadable"); } });
  s.editor = null;
  jobs.soon(() => ({ n: 1 }));
  await assert.rejects(jobs.settle(), /unreadable/);
  assert.deepEqual(s.log, ["saved A w.w3e 1"]);
  assert.equal(jobs.pending, false);
  fail = false;
  await jobs.settle();
  assert.deepEqual(s.log, ["saved A w.w3e 1"]);
});

test("editor closed and the project has no terrain file: nothing runs and the job stays for a reopened editor", async () => {
  const { s, jobs } = rig();
  s.editor = null;
  s.path = null;
  jobs.soon(() => ({ n: 1 }));
  await jobs.settle();
  assert.deepEqual(s.log, []);
  assert.equal(jobs.pending, true);
  s.editor = "A";
  await jobs.settle();
  assert.deepEqual(s.log, ["open 1"]);
});

test("another project opened meanwhile: its settle runs nothing of the old one's, and a new edit replaces the job", async () => {
  const { s, jobs } = rig();
  jobs.soon(() => ({ n: 1 }));
  s.project = "B";
  s.editor = "B";
  await jobs.settle();
  assert.deepEqual(s.log, [], "the old project's job is not run in the new one");
  jobs.soon(() => ({ n: 2 }));
  await jobs.settle();
  assert.deepEqual(s.log, ["open 2"], "an edit in the new project makes its own job");
});

test("the editor of another project (still closing) is not used, and the job is kept", async () => {
  const { s, jobs } = rig();
  jobs.soon(() => ({ n: 1 }));
  s.editor = "B";
  await jobs.settle();
  assert.deepEqual(s.log, []);
  assert.equal(jobs.pending, true);
});

test("a project switch while a rebuild waits for its turn: the queued run finds the other project and does nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { s, jobs } = rig({ open: () => gate });
  jobs.soon(() => ({ n: 1 }));
  const first = jobs.settle();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(s.log, ["open 1"], "the first run is under way");
  jobs.soon(() => ({ n: 2 }));
  const second = jobs.settle();
  s.project = "B";
  s.editor = "B";
  release();
  await Promise.all([first, second]);
  assert.deepEqual(s.log, ["open 1"], "the second run saw the switch");
});

test("reopen after a resize (drop) discards the job; take hands it to the caller once", async () => {
  const { s, jobs } = rig();
  jobs.soon(() => ({ n: 1 }));
  jobs.drop();
  await jobs.settle();
  assert.deepEqual(s.log, []);
  jobs.soon(() => ({ n: 2 }));
  assert.equal(jobs.take("B"), null, "another project's key takes nothing");
  assert.deepEqual(jobs.take("A"), { n: 2 });
  assert.equal(jobs.take("A"), null);
  await jobs.settle();
  assert.deepEqual(s.log, []);
});

test("the timer runs the rebuild after the delay, once", async () => {
  const s = { log: 0 };
  const jobs = new RebuildJobs<From>({
    project: () => "A", editorRoot: () => "A", terrainPath: () => "w.w3e",
    deriveOpen: async () => { s.log++; }, deriveSaved: async () => {}, delayMs: 5,
  });
  jobs.soon(() => ({ n: 1 }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.log, 1);
  await jobs.settle();
  assert.equal(s.log, 1);
});
