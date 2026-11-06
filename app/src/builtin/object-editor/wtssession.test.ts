import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "../../lib/formats/wts";
import { WtsSession } from "./wtssession";

// The editor only changes strings that are already in the file (it needs the number to be in the
// table), so it never adds a string and numbers can't collide: neither is covered here.

const wts = (a: string, b: string) => `STRING 1\n{\n${a}\n}\n\nSTRING 2\n{\n${b}\n}\n`;
const get = (text: string, n: number) => new StringTable(text).get(n);

/** The disk, and editor B writing to it as another editor would. */
function disk(text = wts("one", "two")) {
  const d = {
    text,
    read: async () => d.text,
    write: async (t: string) => { d.text = t; },
    b(n: number, v: string) { d.text = text_set(d.text, n, v); },
  };
  return d;
}
function text_set(text: string, n: number, v: string) {
  const t = new StringTable(text);
  t.set(n, v);
  return t.serialize();
}

/** The previous logic, kept here only as a control: history entries hold the whole file. */
class OldSession {
  table: StringTable;
  saved: string;
  constructor(text: string) { this.saved = text; this.table = new StringTable(text); }
  set(n: number, v: string) { this.table.set(n, v); }
  snapshot() { return this.table.serialize(); }
  restore(s: string) { this.table = new StringTable(s); }
  get dirty() { return this.table.serialize() !== this.saved; }
  async save(read: () => Promise<string>, write: (t: string) => Promise<void>) {
    if (!this.dirty) return;
    const current = await read();
    const merged = StringTable.merge(this.saved, this.table, current);
    if (merged !== current) await write(merged);
    this.saved = merged;
    this.table = new StringTable(merged);
  }
}

interface Editor<S> {
  set(n: number, v: string): void;
  snapshot(): S;
  restore(s: S): void;
  save(d: ReturnType<typeof disk>): Promise<void>;
  table: StringTable;
}
const real = (text: string): Editor<unknown> => {
  const a = new WtsSession(text);
  return { set: (n, v) => a.set(n, v), snapshot: () => a.snapshot(), restore: (s) => a.restore(s as never), save: (d) => a.save(d.read, d.write), get table() { return a.table; } };
};
const old = (text: string): Editor<unknown> => {
  const a = new OldSession(text);
  return { set: (n, v) => a.set(n, v), snapshot: () => a.snapshot(), restore: (s) => a.restore(s as string), save: (d) => a.save(d.read, d.write), get table() { return a.table; } };
};
/** Control: a save that writes the editor's whole table over the file. */
const wholeFile = (text: string): Editor<unknown> => {
  const a = new WtsSession(text);
  return { set: (n, v) => a.set(n, v), snapshot: () => a.snapshot(), restore: (s) => a.restore(s as never), save: async (d) => { await d.write(a.table.serialize()); }, get table() { return a.table; } };
};

/** A edits string 1 and saves; A edits string 2; B saves string 1; A saves; A undoes to before
 *  its edit of string 2 and saves again. B's string must survive; then redo. */
async function otherEditorSavedAnOwnedString(make: (t: string) => Editor<unknown>) {
  const d = disk(), a = make(d.text);
  a.set(1, "ONE"); const s1 = a.snapshot(); await a.save(d);
  a.set(2, "TWO"); const s2 = a.snapshot();
  d.b(1, "B1");
  await a.save(d);
  a.restore(s1); await a.save(d);
  const afterUndo = [get(d.text, 1), get(d.text, 2)];
  a.restore(s2); await a.save(d);
  return { afterUndo, afterRedo: [get(d.text, 1), get(d.text, 2)] };
}

/** A edits string 1 and saves; B changes both strings and saves; A undoes past its save and saves. */
async function otherEditorChangedASavedString(make: (t: string) => Editor<unknown>) {
  const d = disk(), a = make(d.text);
  const s0 = a.snapshot();
  a.set(1, "ONE"); const s1 = a.snapshot(); await a.save(d);
  d.b(1, "B1"); d.b(2, "B2");
  a.restore(s0); await a.save(d);
  const afterUndo = [get(d.text, 1), get(d.text, 2)];
  a.restore(s1); await a.save(d);
  return { afterUndo, afterRedo: [get(d.text, 1), get(d.text, 2)] };
}

test("undo keeps a string another editor saved after the editor's own save of it", async () => {
  const r = await otherEditorSavedAnOwnedString(real);
  assert.deepEqual(r.afterUndo, ["B1", "two"], "B's string stays, A's later change is undone");
  assert.deepEqual(r.afterRedo, ["B1", "TWO"]);
});

test("control: the old whole-file history loses the other editor's string in that case", async () => {
  const r = await otherEditorSavedAnOwnedString(old);
  assert.notEqual(r.afterUndo[0], "B1");
});

test("undo past a save keeps strings another editor changed since", async () => {
  const r = await otherEditorChangedASavedString(real);
  assert.deepEqual(r.afterUndo, ["B1", "B2"]);
  assert.deepEqual(r.afterRedo, ["B1", "B2"]);
});

test("control: the old history and a whole-file save both lose them", async () => {
  assert.notDeepEqual((await otherEditorChangedASavedString(old)).afterUndo, ["B1", "B2"]);
  assert.notDeepEqual((await otherEditorChangedASavedString(wholeFile)).afterUndo, ["B1", "B2"]);
});

test("a string typed again after another editor took it is the editor's again", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); const s1 = a.snapshot(); await a.save(d.read, d.write);
  a.set(2, "TWO"); a.snapshot();
  d.b(1, "B1");
  await a.save(d.read, d.write);
  a.set(1, "X"); a.snapshot();
  a.restore(s1); // an entry from before the other editor's save: its text for string 1 is stale
  assert.equal(a.table.get(1), "B1");
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "B1");
});

test("undo and redo fully restore the editor's own strings; dirty follows", async () => {
  const d = disk(), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "x"); const s1 = a.snapshot();
  a.set(2, "y"); const s2 = a.snapshot();
  assert.equal(a.dirty, true);
  a.restore(s1);
  assert.equal(a.table.get(2), "two");
  assert.equal(a.table.get(1), "x");
  a.restore(s0);
  assert.equal(a.dirty, false);
  a.restore(s2);
  await a.save(d.read, d.write);
  assert.equal(d.text, wts("x", "y"));
  assert.equal(a.dirty, false);
});

test("dirty ignores line ending differences after a full undo", () => {
  const a = new WtsSession("STRING 1\r\n{\r\none\r\n}\n\nSTRING 2\n{\ntwo\n}\n");
  const s0 = a.snapshot();
  a.set(1, "x"); a.snapshot();
  assert.equal(a.dirty, true);
  a.restore(s0);
  assert.equal(a.dirty, false);
});

test("a save whose read fails writes nothing and stays dirty", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); a.snapshot();
  let writes = 0;
  await assert.rejects(a.save(async () => { throw new Error("locked"); }, async () => { writes++; }), /locked/);
  assert.equal(writes, 0);
  assert.equal(a.dirty, true);
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "ONE");
});

test("saving without a change neither reads nor writes", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "x"); a.snapshot();
  a.set(1, "one"); a.snapshot();
  assert.equal(a.dirty, false);
  await a.save(async () => { throw new Error("read"); }, async () => { throw new Error("write"); });
});
