import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "../../lib/formats/wts";
import { WtsSession, fileIsMissing, mapFolderGone, findPackedMap, isNotFoundError, recreatedMessage, attempt, isDirtyNow, runSave } from "./wtssession";

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
  save(d: ReturnType<typeof disk>): Promise<unknown>;
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
/** Control: a save without the merge, writing the editor's whole table over the file. Not in the shipped class. */
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
  assert.deepEqual(r.afterUndo, ["ONE", "two"], "B1 is gone: A put its old text back (and A's later change is undone)");
});

test("undo past a save keeps strings another editor changed since", async () => {
  const r = await otherEditorChangedASavedString(real);
  assert.deepEqual(r.afterUndo, ["B1", "B2"]);
  assert.deepEqual(r.afterRedo, ["B1", "B2"]);
});

test("control: the old history loses string 1, a save without the merge loses both", async () => {
  assert.deepEqual((await otherEditorChangedASavedString(old)).afterUndo, ["one", "B2"]);
  assert.deepEqual((await otherEditorChangedASavedString(wholeFile)).afterUndo, ["one", "two"]);
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

test("a failed write leaves the session as it was, so the retry still protects the other editor", async () => {
  const d = disk(), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "ONE"); const s1 = a.snapshot(); await a.save(d.read, d.write);
  a.set(2, "TWO"); a.snapshot();
  d.b(1, "B1");
  a.restore(s0);
  a.set(2, "T3"); a.snapshot();
  await assert.rejects(a.save(d.read, async () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(a.table.get(1), "one", "nothing was changed by the failed save");
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "B1");
  assert.equal(get(d.text, 2), "T3");
  a.restore(s1); // undo/redo to the entry from before: string 1 is the other editor's now
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "B1");
});

test("redo of a fresh, unsaved edit stays an edit even if another editor saved the string", async () => {
  const d = disk(), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "ONE"); const s1 = a.snapshot();
  d.b(1, "B1");
  a.restore(s0);
  a.restore(s1);
  const changed = (await a.save(d.read, d.write)).shown;
  assert.equal(get(d.text, 1), "ONE");
  assert.equal(a.table.get(1), "ONE");
  assert.equal(changed, false, "what the editor shows is what was saved");
});

test("a save tells when it changed a text the editor shows", async () => {
  const d = disk(), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "ONE"); a.snapshot(); await a.save(d.read, d.write);
  d.b(1, "B1");
  a.restore(s0);
  assert.equal((await a.save(d.read, d.write)).shown, true);
  assert.equal(a.table.get(1), "B1");
});

test("a string typed while the save is writing is kept, and the editor stays dirty", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); a.snapshot();
  await a.save(d.read, async (t) => { a.set(2, "late"); a.snapshot(); await d.write(t); });
  assert.equal(a.table.get(2), "late");
  assert.equal(a.dirty, true);
  assert.equal(get(d.text, 2), "two");
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 2), "late");
  assert.equal(a.dirty, false);
});

// --- war3map.wts gone missing ---

const gone = async (): Promise<string> => { throw "Das System kann die angegebene Datei nicht finden. (os error 2)"; };
const locked = async (): Promise<string> => { throw "Der Prozess kann nicht auf die Datei zugreifen. (os error 32)"; };
const yes = async () => true;
const no = async () => false;

test("a missing file is recreated from the editor's table, and the editor goes clean", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); a.snapshot();
  let written = "";
  const r = await a.save(gone, async (t) => { written = t; }, yes, 0);
  assert.equal(get(written, 1), "ONE");
  assert.equal(get(written, 2), "two");
  assert.equal(r.recreated, true);
  assert.equal(a.dirty, false);
});

test("a read that fails and then succeeds does not recreate: the normal merge is used", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); a.snapshot();
  d.b(2, "B2"); // another editor's newer text
  let reads = 0;
  const flaky = async () => { if (reads++ === 0) throw "os error 2"; return d.text; };
  const r = await a.save(flaky, d.write, yes, 0);
  assert.equal(reads, 2);
  assert.equal(r.recreated, false);
  assert.equal(get(d.text, 1), "ONE");
  assert.equal(get(d.text, 2), "B2");
});

test("after a recreate, undo past the save still works and the next save writes it", async () => {
  const d = disk(), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "ONE"); a.snapshot();
  const r = await a.save(gone, d.write, yes, 0);
  assert.equal(r.recreated, true);
  assert.equal(d.text.includes("ONE"), true);
  a.restore(s0);
  assert.equal(a.table.get(1), "one");
  assert.equal(a.dirty, true);
  assert.equal((await a.save(d.read, d.write)).recreated, false);
  assert.equal(get(d.text, 1), "one");
});

test("a read that fails for another reason stops the save: nothing written, session unchanged", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); const snap = a.snapshot();
  let writes = 0;
  await assert.rejects(a.save(locked, async () => { writes++; }, no, 0), /os error 32/);
  assert.equal(writes, 0);
  assert.equal(a.dirty, true);
  assert.equal(a.table.get(1), "ONE");
  assert.deepEqual(a.snapshot(), snap);
});

test("a retry after a non-missing failure saves normally", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); a.snapshot();
  await assert.rejects(a.save(locked, d.write, no, 0));
  const r = await a.save(d.read, d.write, no, 0);
  assert.equal(get(d.text, 1), "ONE");
  assert.equal(a.dirty, false);
  assert.equal(r.recreated, false);
});

test("a failed write while recreating leaves the session as it was", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); a.snapshot();
  await assert.rejects(a.save(gone, async () => { throw "disk full"; }, yes, 0), /disk full/);
  assert.equal(a.dirty, true);
});

test("without a missing check, a failed read always stops the save", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); a.snapshot();
  await assert.rejects(a.save(gone, async () => {}), /os error 2/);
});

test("the outcome belongs to its own save: a second save does not reset it", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); a.snapshot();
  const first = await a.save(gone, async () => {}, yes, 0);
  await a.save(gone, async () => {}, yes, 0); // clean: nothing to do
  assert.equal(first.recreated, true);
});

test("only os errors 2 and 3 are 'not found', whatever the language", () => {
  assert.equal(isNotFoundError("Das System kann die angegebene Datei nicht finden. (os error 2)"), true);
  assert.equal(isNotFoundError("Das System kann den angegebenen Pfad nicht finden. (os error 3)"), true);
  assert.equal(isNotFoundError("Zugriff verweigert. (os error 5)"), false);
  assert.equal(isNotFoundError("in use (os error 32)"), false);
  assert.equal(isNotFoundError("os error 22"), false);
  assert.equal(isNotFoundError(new Error("NOT_UTF8")), false);
});

test("the file counts as missing only if the read said so, the refresh worked, it is not listed, and the rest of map/ is there", () => {
  const base = { error: "(os error 2)", refreshed: true, listed: false, otherMapFiles: true };
  assert.equal(fileIsMissing(base), true);
  assert.equal(fileIsMissing({ ...base, error: "(os error 5)" }), false);
  assert.equal(fileIsMissing({ ...base, refreshed: false }), false);
  assert.equal(fileIsMissing({ ...base, listed: true }), false);
  assert.equal(fileIsMissing({ ...base, otherMapFiles: false }), false);
});

test("the warning names the packed map when there is one, and leaves the sentence out otherwise", () => {
  const withMap = recreatedMessage("C:/p/build/m.w3x");
  assert.match(withMap, /war3map\.wts was missing and has been recreated/);
  assert.match(withMap, /added or changed elsewhere/);
  assert.match(withMap, /may hold the old strings/);
  assert.match(withMap, /C:\/p\/build\/m\.w3x/);
  const none = recreatedMessage(null);
  assert.match(none, /recreated/);
  assert.doesNotMatch(none, /\.w3x|old strings/);
});

test("the packed map is the build output if it exists, else the newest checkpoint", () => {
  const out = "C:/p/build/m.w3x", cp = "C:/p/build/checkpoints/m 2026-03-01 10-00-00.w3x";
  assert.equal(findPackedMap(out, true, cp), out);
  assert.equal(findPackedMap(out, false, cp), cp);
  assert.equal(findPackedMap(out, false, null), null);
});

test("saving stops when the map folder is gone, unless the file is new in a project that never had one", () => {
  assert.equal(mapFolderGone({ folderExists: false, isNew: false, hasWts: true }), true);
  assert.equal(mapFolderGone({ folderExists: false, isNew: false, hasWts: false }), true);
  assert.equal(mapFolderGone({ folderExists: false, isNew: true, hasWts: true }), true);
  assert.equal(mapFolderGone({ folderExists: false, isNew: true, hasWts: false }), false);
  assert.equal(mapFolderGone({ folderExists: true, isNew: true, hasWts: true }), false);
  assert.equal(mapFolderGone({ folderExists: true, isNew: false, hasWts: true }), false);
});

test("runSave: an edit typed during the awaits stays dirty; saved is the text taken up front", async () => {
  let doc = "v1";
  let saved = "";
  const log: string[] = [];
  await runSave({
    serialize: () => doc,
    canonicalize: async (t) => { log.push("canon"); return `canonical(${t})`; },
    write: async (t) => { log.push(`write ${t}`); },
    afterWrite: async () => { log.push("wts"); doc = "v2"; }, // typed while the strings are saved
    setSaved: (t) => { log.push("setSaved"); saved = t; },
    followUps: async () => { log.push("followUps"); },
  });
  assert.equal(saved, "v1");
  assert.equal(isDirtyNow(doc, saved, false), true);
  assert.deepEqual(log, ["canon", "write canonical(v1)", "wts", "setSaved", "followUps"]);
});

test("runSave: with no edit during the save the editor ends clean; unsaved strings keep it dirty", async () => {
  let saved = "";
  await runSave({
    serialize: () => "v1", canonicalize: async (t) => t, write: async () => {},
    afterWrite: async () => {}, setSaved: (t) => { saved = t; }, followUps: async () => {},
  });
  assert.equal(isDirtyNow("v1", saved, false), false);
  assert.equal(isDirtyNow("v1", saved, true), true);
});

test("runSave: a failing follow-up still leaves saved recorded", async () => {
  let saved = "";
  await assert.rejects(runSave({
    serialize: () => "v1", canonicalize: async (t) => t, write: async () => {},
    afterWrite: async () => {}, setSaved: (t) => { saved = t; }, followUps: async () => { throw new Error("render"); },
  }));
  assert.equal(saved, "v1");
});

test("attempt only reports failures of the work it wraps", async () => {
  assert.deepEqual(await attempt(async () => 5), { ok: true, value: 5 });
  const bad = await attempt(async () => { throw new Error("boom"); });
  assert.equal(bad.ok, false);
  assert.match(String((bad as { error: unknown }).error), /boom/);
});
