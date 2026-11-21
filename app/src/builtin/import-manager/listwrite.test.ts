import assert from "node:assert/strict";
import { test } from "node:test";
import { listWriter } from "./listwrite";

/** A list, a disk whose writes are held until released one by one, and the tab's dirty flag. */
function setup() {
  const list = { files: [] as string[] };
  const landed: string[] = [];
  const held: (() => void)[] = [];
  let dirty = false;
  const write = listWriter({
    snapshot: () => JSON.stringify(list.files),
    persist: (text) => new Promise<void>((resolve) => held.push(() => { landed.push(text); resolve(); })),
    setDirty: (d) => { dirty = d; },
  });
  // [Refactored] Replaced setTimeout(r, 0) with setImmediate(r) to avoid timer clamping across 9 ticks.
  const tick = () => new Promise<void>((r) => setImmediate(r));
  /** Lets the oldest held write land. */
  const release = async () => { await tick(); assert.ok(held.length, "a write is waiting"); held.shift()!(); await tick(); };
  return { list, landed, held, write, release, tick, dirty: () => dirty };
}

test("two overlapping writes land in order, the last list state last", async () => {
  const s = setup();
  s.list.files.push("A");
  const a = s.write();
  s.list.files.push("B");
  const b = s.write();
  await s.tick();
  // One at a time: the second waits for the first.
  assert.equal(s.held.length, 1);
  await s.release();
  await s.release();
  await Promise.all([a, b]);
  assert.deepEqual(s.landed.at(-1), JSON.stringify(["A", "B"]));
  assert.equal(s.dirty(), false);
});

test("an edit during a write keeps the tab dirty until a write holds it", async () => {
  const s = setup();
  s.list.files.push("A");
  const a = s.write();
  assert.equal(s.dirty(), true, "dirty while the write runs");
  await s.tick();
  // Changed while the first write is on its way (its write follows).
  s.list.files.push("B");
  await s.release();
  await a;
  assert.equal(s.dirty(), true, "the first write doesn't hold B");
  const b = s.write();
  await s.release();
  await b;
  assert.equal(s.dirty(), false);
  assert.deepEqual(s.landed, [JSON.stringify(["A"]), JSON.stringify(["A", "B"])]);
});

test("a failed write rejects its caller, keeps the tab dirty and doesn't stop the next", async () => {
  const list = { files: ["A"] };
  let dirty = false, fail = true;
  const landed: string[] = [];
  const write = listWriter({
    snapshot: () => JSON.stringify(list.files),
    persist: async (text) => { if (fail) { fail = false; throw new Error("disk full"); } landed.push(text); },
    setDirty: (d) => { dirty = d; },
  });
  await assert.rejects(write(), /disk full/);
  assert.equal(dirty, true);
  await write();
  assert.equal(dirty, false);
  assert.deepEqual(landed, [JSON.stringify(["A"])]);
});

test("after a failed write save() writes the list again; a clean tab's save writes nothing", async () => {
  const list = { files: ["A"] };
  let dirty = false, fail = true, writes = 0;
  const write = listWriter({
    snapshot: () => JSON.stringify(list.files),
    persist: async () => { writes++; if (fail) throw new Error("disk full"); },
    setDirty: (d) => { dirty = d; },
  });
  await assert.rejects(write(), /disk full/);
  assert.equal(dirty, true);
  fail = false;
  await write.save();
  assert.equal(writes, 2);
  assert.equal(dirty, false);
  await write.save();
  assert.equal(writes, 2, "clean: no write");
});
