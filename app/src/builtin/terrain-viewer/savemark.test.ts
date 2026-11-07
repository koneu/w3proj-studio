import test from "node:test";
import assert from "node:assert/strict";
import { SaveMark, Stale, saveSnapshot, serial } from "./savemark";

test("an edit made while a save is in flight stays dirty", () => {
  const m = new SaveMark();
  m.begin(2);
  assert.equal(m.isDirty(3), true);
  m.finish(); // the save ends after a third edit
  assert.equal(m.isDirty(3), true);
  assert.equal(m.isDirty(2), false);
});

test("a save with no edit meanwhile leaves it clean", () => {
  const m = new SaveMark();
  m.begin(4);
  m.finish();
  assert.equal(m.isDirty(4), false);
});

test("undo past the saved position, then a new edit, is not the saved state", () => {
  const m = new SaveMark();
  m.begin(3);
  m.finish();
  m.truncated(2);
  assert.equal(m.isDirty(3), true);
});

test("the same during a save: the dropped step was the one being written", () => {
  const m = new SaveMark();
  m.begin(3);
  m.truncated(2);
  m.finish();
  assert.equal(m.isDirty(3), true);
  assert.equal(m.isDirty(2), true);
});

test("undo and redo across a save follow the saved position", () => {
  const m = new SaveMark();
  m.begin(3);
  m.finish();
  assert.equal(m.isDirty(2), true);
  assert.equal(m.isDirty(3), false);
  m.truncated(3);
  assert.equal(m.isDirty(4), true);
});

test("a reload resets the mark", () => {
  const m = new SaveMark();
  m.begin(5);
  m.finish();
  m.reset();
  assert.equal(m.isDirty(0), false);
});

test("pending: the step a running save took can't be joined; after it ends, it can", () => {
  const m = new SaveMark();
  assert.equal(m.pending(3), false);
  m.begin(3);
  assert.equal(m.pending(3), true);
  assert.equal(m.pending(4), false);
  m.finish();
  assert.equal(m.pending(3), false);
  m.begin(3);
  m.abort();
  assert.equal(m.pending(3), false);
});

/** A little document: edits are numbers pushed to a list; "disk" is what a write got. */
function doc() {
  const list: number[] = [], mark = new SaveMark();
  const disk: number[][] = [];
  let slow: (() => void) | null = null, dirtyNow = true;
  const save = () => saveSnapshot(mark, {
    at: () => list.length,
    take: () => [...list],
    write: async (t) => { await new Promise<void>((r) => { slow = r; }); disk.push(t); },
    saved: () => { dirtyNow = mark.isDirty(list.length); },
  });
  return { list, mark, disk, save, finishWrite: () => slow!(), dirty: () => dirtyNow };
}

test("saveSnapshot: writes what was taken up front, and an edit during the write stays unsaved", async () => {
  const d = doc();
  d.list.push(1, 2);
  const saving = d.save();
  d.list.push(3); // while the write waits
  d.finishWrite();
  await saving;
  assert.deepEqual(d.disk, [[1, 2]]);
  assert.equal(d.dirty(), true);
  assert.equal(d.mark.isDirty(2), false);
});

test("saveSnapshot: a failed write records nothing", async () => {
  const mark = new SaveMark();
  await assert.rejects(saveSnapshot(mark, { at: () => 2, take: () => 0, write: async () => { throw new Error("disk"); }, saved: () => { assert.fail("saved"); } }), /disk/);
  assert.equal(mark.isDirty(2), true);
  assert.equal(mark.pending(2), false);
});

test("serial: a second call waits for the first and takes a fresh snapshot", async () => {
  const d = doc();
  d.list.push(1);
  const run = serial(async () => { await d.save(); });
  const a = run();
  const b = run();
  await new Promise((r) => setTimeout(r, 5));
  d.list.push(2); // after the first took, before the second took
  d.finishWrite();
  await a;
  await new Promise((r) => setTimeout(r, 5));
  d.finishWrite();
  await b;
  assert.deepEqual(d.disk, [[1], [1, 2]]);
  assert.equal(d.mark.isDirty(2), false);
});

test("serial: a failed save doesn't block the next", async () => {
  let n = 0;
  const run = serial(async () => { if (n++ === 0) throw new Error("first"); });
  await assert.rejects(run(), /first/);
  await run();
  assert.equal(n, 2);
});

test("serial: control, the same two calls not chained start together", async () => {
  const order: string[] = [], releases: (() => void)[] = [];
  const work = async () => { order.push("start"); await new Promise<void>((r) => releases.push(r)); order.push("end"); };
  const a = work(), b = work();
  assert.deepEqual(order, ["start", "start"]);
  releases.forEach((r) => r());
  await Promise.all([a, b]);
  const run = serial(work);
  order.length = 0; releases.length = 0;
  const c = run(), e = run();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ["start"]);
  releases[0](); await c;
  await new Promise((r) => setTimeout(r, 5));
  releases[1](); await e;
  assert.deepEqual(order, ["start", "end", "start", "end"]);
});

test("Stale: an edit after the snapshot survives the draw's clean-up", () => {
  const s = new Stale();
  s.set();
  const taken = s.take(); // the save's snapshot
  s.set(); // an edit before the draw ends
  s.clear(taken);
  assert.equal(s.isSet(), true);
});

test("Stale: no edit since the snapshot, a finished draw cleans it; a failed draw leaves it", () => {
  const s = new Stale();
  s.set();
  s.clear(s.take());
  assert.equal(s.isSet(), false);
  s.set();
  s.take(); // the draw failed: clear is never called
  assert.equal(s.isSet(), true);
});

test("Stale: an edit during the draw, then a later clean from a newer snapshot, cleans", () => {
  const s = new Stale();
  s.set();
  const first = s.take();
  s.set();
  s.clear(first);
  s.clear(s.take());
  assert.equal(s.isSet(), false);
});
