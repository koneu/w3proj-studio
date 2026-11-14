import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "../../lib/formats/wts";
import { WtsSession, fileIsMissing, mapFolderGone, mapFolderStop, findPackedMap, isNotFoundError, recreatedMessage, attempt, isDirtyNow, runSave } from "./wtssession";

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

/** A saves string 1 twice; during the second save's write it undoes string 1 back past the first save. */
async function undoneDuringTheWrite() {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); const s1 = a.snapshot(); await a.save(d.read, d.write);
  a.set(1, "TWO"); const s2 = a.snapshot();
  a.set(2, "X"); a.snapshot();
  await a.save(d.read, async (t) => { a.restore(s1); await d.write(t); });
  return { d, a, s1, s2 };
}

test("undone during the write, then saved by another editor: the next save is refused, not written over theirs", async () => {
  const { d, a, s2 } = await undoneDuringTheWrite();
  assert.equal(get(d.text, 1), "TWO", "the write carried the text from before the undo");
  assert.equal(a.table.get(1), "ONE");
  assert.equal(a.dirty, true);
  d.b(1, "B1");
  const before = d.text;
  await assert.rejects(a.save(d.read, d.write), /string 1 .*undone while the last save was writing.*another editor/s);
  assert.equal(d.text, before, "nothing written");
  assert.equal(a.dirty, true, "the editor stays dirty");
  assert.equal(a.table.get(1), "ONE");
  // Undo or redo once more settles it: then the other editor's text is kept, as for any undo past a save.
  a.restore(s2);
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "B1");
});

test("undone during the write: typing the string again makes it a normal edit, and no other editor's text means no refusal", async () => {
  const typed = await undoneDuringTheWrite();
  typed.d.b(1, "B1");
  typed.a.set(1, "MINE");
  await typed.a.save(typed.d.read, typed.d.write);
  assert.equal(get(typed.d.text, 1), "MINE", "typed since: the last save wins");
  const alone = await undoneDuringTheWrite();
  await alone.a.save(alone.d.read, alone.d.write);
  assert.equal(get(alone.d.text, 1), "ONE", "nobody else saved it: the undo is written");
  assert.equal(alone.a.dirty, false);
});

test("a failed write doesn't leave an undo made during it marked as racing", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); const s1 = a.snapshot(); await a.save(d.read, d.write);
  a.set(1, "TWO"); a.snapshot();
  await assert.rejects(a.save(d.read, async () => { a.restore(s1); throw new Error("disk full"); }));
  d.b(1, "B1");
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "B1", "an ordinary undo past the save: the other editor's text stays");
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

test("saving stops when whether the map folder is there can't be checked: never taken for present", async () => {
  const cant = () => Promise.reject("map can't be checked: Permission denied (os error 13)");
  for (const x of [{ isNew: false, hasWts: true }, { isNew: true, hasWts: false }]) {
    assert.match((await mapFolderStop(cant, x)) ?? "", /couldn't be checked \(map can't be checked: Permission denied/, JSON.stringify(x));
  }
  assert.match((await mapFolderStop(async () => false, { isNew: false, hasWts: false })) ?? "", /map folder is missing/);
  // Control: a folder that is there, or a new file in a project that never had one, saves.
  assert.equal(await mapFolderStop(async () => true, { isNew: false, hasWts: true }), null);
  assert.equal(await mapFolderStop(async () => false, { isNew: true, hasWts: false }), null);
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

// --- gaps found in review: each test names the branch of WtsSession it pins ---

const crlf = (s: string) => s.replace(/\n/g, "\r\n");

test("set ignores a number the file doesn't have and a text that is already there", () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(99, "x");
  assert.equal(a.table.has(99), false);
  a.set(1, "one");
  assert.equal(a.dirty, false);
  assert.deepEqual(a.snapshot(), { v: 0, s: {} }, "neither string became the editor's");
});

test("a snapshot holds the editor's own strings and the save count, not the whole file", async () => {
  const d = disk(), a = new WtsSession(d.text);
  assert.deepEqual(a.snapshot(), { v: 0, s: {} });
  a.set(2, "TWO");
  assert.deepEqual(a.snapshot(), { v: 0, s: { 2: "TWO" } });
  await a.save(d.read, d.write);
  assert.equal(a.snapshot().v, 1, "a save counts");
  await a.save(d.read, d.write); // clean: no save
  assert.equal(a.snapshot().v, 1);
});

test("a save with nothing to merge in writes nothing, even though the editor was dirty", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); a.snapshot();
  d.b(1, "ONE"); // another editor saved the very same text
  let writes = 0;
  const r = await a.save(d.read, async (t) => { writes++; await d.write(t); });
  assert.equal(writes, 0, "the file already is what it should be");
  assert.equal(r.shown, false);
  assert.equal(r.recreated, false);
  assert.equal(a.dirty, false, "and the session still takes it as saved");
  assert.equal(a.snapshot().v, 1);
});

test("a save tells when another editor's text replaced one the editor never touched", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); a.snapshot();
  d.b(2, "B2"); // string 2 is not the editor's
  const r = await a.save(d.read, d.write);
  assert.equal(r.shown, true, "the editor shows string 2, which changed");
  assert.equal(a.table.get(2), "B2");
  assert.equal(get(d.text, 1), "ONE");
  // control: nothing changed elsewhere, nothing shown
  const d2 = disk(), a2 = new WtsSession(d2.text);
  a2.set(1, "ONE");
  assert.equal((await a2.save(d2.read, d2.write)).shown, false);
});

test("a string typed during the write stays the editor's: not handed over, not reported as shown", async () => {
  const d = disk(), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "ONE"); a.snapshot(); await a.save(d.read, d.write);
  d.b(1, "B1");
  a.restore(s0); // string 1 goes back past the save; B's text is to be kept
  a.set(2, "TWO"); a.snapshot(); // something to write
  const r = await a.save(d.read, async (t) => { a.set(1, "LATE"); await d.write(t); });
  assert.equal(get(d.text, 1), "B1", "the write carried B's text");
  assert.equal(get(d.text, 2), "TWO");
  assert.equal(r.shown, false, "string 1 was typed, so what the editor shows is its own");
  assert.equal(a.table.get(1), "LATE");
  assert.equal(a.dirty, true);
  a.restore(s0);
  assert.equal(a.table.get(1), "one", "string 1 is still the editor's, so undo reaches it");
  // control: without typing during the write, string 1 is B's and undo leaves it alone
  const d2 = disk(), b = new WtsSession(d2.text);
  const t0 = b.snapshot();
  b.set(1, "ONE"); b.snapshot(); await b.save(d2.read, d2.write);
  d2.b(1, "B1");
  b.restore(t0);
  b.set(2, "TWO"); b.snapshot();
  assert.equal((await b.save(d2.read, d2.write)).shown, true);
  b.restore(t0);
  assert.equal(b.table.get(1), "B1");
});

test("a save in a CRLF file keeps its line endings, including in a multi-line string, and ends clean", async () => {
  const d = disk(crlf(wts("one", "two"))), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "x\ny"); a.snapshot();
  const r = await a.save(d.read, d.write);
  assert.equal(d.text, crlf(wts("x\ny", "two")), "every line ending is CRLF, nothing else changed");
  assert.equal(r.shown, false, "x\r\ny is the same text as x\ny");
  assert.equal(a.dirty, false);
  a.restore(s0);
  assert.equal(a.dirty, true);
  await a.save(d.read, d.write);
  assert.equal(d.text, crlf(wts("one", "two")));
  assert.equal(a.dirty, false);
});

test("a CRLF file where the other editor saved the same text in the other line ending writes nothing", async () => {
  const d = disk(crlf(wts("one", "two"))), a = new WtsSession(d.text);
  a.set(1, "x\ny"); a.snapshot();
  d.text = crlf(wts("x\ny", "two"));
  let writes = 0;
  await a.save(d.read, async () => { writes++; });
  assert.equal(writes, 0);
  assert.equal(a.dirty, false);
});

test("the retry waits retryMs, reads again, and asks about the second error too", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); a.snapshot();
  const asked: unknown[] = [];
  let reads = 0, writes = 0;
  const t0 = Date.now();
  const r = await a.save(
    async () => { reads++; throw `gone ${reads} (os error 2)`; },
    async () => { writes++; },
    async (e) => { asked.push(e); return isNotFoundError(e); },
    60,
  );
  assert.ok(Date.now() - t0 >= 50, "waited before the second read");
  assert.equal(reads, 2);
  assert.equal(writes, 1);
  assert.equal(r.recreated, true);
  assert.deepEqual(asked, ["gone 1 (os error 2)", "gone 2 (os error 2)"]);
});

test("a first read that is not 'missing' is not retried", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); a.snapshot();
  let reads = 0;
  await assert.rejects(a.save(async () => { reads++; throw "locked (os error 32)"; }, async () => {}, async (e) => isNotFoundError(e), 0), /os error 32/);
  assert.equal(reads, 1);
});

test("a retry that fails for another reason stops the save: nothing written, session unchanged", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); const snap = a.snapshot();
  let reads = 0, writes = 0;
  await assert.rejects(
    a.save(async () => { throw reads++ === 0 ? "gone (os error 2)" : "locked (os error 32)"; }, async () => { writes++; }, async (e) => isNotFoundError(e), 0),
    /os error 32/,
  );
  assert.equal(reads, 2);
  assert.equal(writes, 0);
  assert.equal(a.dirty, true);
  assert.deepEqual(a.snapshot(), snap);
});

test("a recreate writes the editor's whole table, counts as a save, and a string typed during it stays dirty", async () => {
  const a = new WtsSession(wts("one", "two"));
  a.set(1, "ONE"); a.snapshot();
  let written = "";
  const r = await a.save(gone, async (t) => { written = t; a.set(2, "late"); }, yes, 0);
  assert.equal(written, wts("ONE", "two"));
  assert.equal(r.shown, false);
  assert.equal(r.recreated, true);
  assert.equal(a.snapshot().v, 1);
  assert.equal(a.table.get(2), "late");
  assert.equal(a.dirty, true, "string 2 is not in the recreated file yet");
});

test("undo to the entry the session started with puts back every string the editor changed", () => {
  const a = new WtsSession(wts("one", "two"));
  const s0 = a.snapshot();
  a.set(1, "x"); a.set(2, "y"); a.snapshot();
  a.restore(s0);
  assert.equal(a.table.get(1), "one");
  assert.equal(a.table.get(2), "two");
  assert.equal(a.dirty, false);
});

test("typing a string again after undoing it makes it a normal edit: the last save wins", async () => {
  const d = disk(), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "ONE"); a.snapshot(); await a.save(d.read, d.write);
  a.restore(s0); // undone: another editor's later text would be kept
  d.b(1, "B1");
  a.set(1, "X"); a.snapshot(); // typed since
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "X");
});

test("restoring to what the string already is changes nothing, not even whether it counts as undone", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "X"); const sX = a.snapshot(); await a.save(d.read, d.write);
  a.set(1, "Y"); a.snapshot(); await a.save(d.read, d.write);
  a.set(1, "X"); a.snapshot(); // typed: not undone
  d.b(1, "B1");
  a.restore(sX); // an entry from before the saves, but it is already what the string is
  assert.equal(a.table.get(1), "X");
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "X", "a typed text, last save wins");
});

test("undoing to an entry from before a save keeps another editor's later text", async () => {
  const d = disk(), a = new WtsSession(d.text);
  a.set(1, "ONE"); const s1 = a.snapshot(); await a.save(d.read, d.write);
  a.set(1, "TWO"); a.snapshot(); await a.save(d.read, d.write);
  d.b(1, "B1");
  a.restore(s1);
  assert.equal(a.table.get(1), "ONE");
  const r = await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "B1");
  assert.equal(r.shown, true);
});

test("dirty ignores line endings inside a multi-line string", () => {
  const a = new WtsSession(crlf(wts("a\nb", "two")));
  a.set(1, "a\nb"); // the same text, as the editor holds it
  assert.equal(a.dirty, false);
  a.set(1, "a\nc");
  assert.equal(a.dirty, true);
});

test("a string the other editor's file no longer has is not brought back by an undo", async () => {
  const d = disk(), a = new WtsSession(d.text);
  const s0 = a.snapshot();
  a.set(1, "ONE"); a.snapshot(); await a.save(d.read, d.write);
  d.text = "STRING 2\n{\ntwo\n}\n"; // string 1 is gone from the file
  a.restore(s0);
  a.set(2, "TWO"); a.snapshot();
  const r = await a.save(d.read, d.write);
  assert.equal(get(d.text, 2), "TWO");
  assert.equal(new StringTable(d.text).has(1), false);
  assert.equal(r.shown, true, "the editor's string 1 is no longer there");
});

test("another editor's line-ending-only rewrite of a string is not 'their text': the undo still applies", async () => {
  const d = disk(crlf(wts("a\nb", "two"))), a = new WtsSession(d.text);
  a.set(1, "X"); const sX = a.snapshot(); await a.save(d.read, d.write);
  a.set(1, "a\nb"); a.snapshot(); await a.save(d.read, d.write);
  d.text = d.text.replace(/\r\n/g, "\n"); // same strings, other line endings
  a.restore(sX);
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "X");
});

// --- Two editors on one war3map.wts, interleaved ---
// A is this session (the Object Editor); B is any other writer of the file: another session, the text editor, an
// outside program. Neither may lose or change a string the other saved, nor bring back one the other deleted.

const three = (a: string, b: string, c: string) => `STRING 1\n{\n${a}\n}\n\nSTRING 2\n{\n${b}\n}\n\nSTRING 3\n{\n${c}\n}\n`;
const nums = (text: string) => [...new StringTable(text).entries()].map(([n]) => n);
/** B deletes a string block from the file as it is now. */
const deleteString = (text: string, n: number) => text.replace(new RegExp(`STRING ${n}\\n\\{\\n[^}]*\\}\\n\\n?`), "");

test("two sessions: undo past a save while the other deleted the string leaves it deleted, and keeps the other's strings", async () => {
  const d = disk(three("one", "two", "three"));
  const a = new WtsSession(d.text), b = new WtsSession(d.text);
  const a0 = a.snapshot();
  a.set(1, "A1"); const a1 = a.snapshot(); await a.save(d.read, d.write);
  a.set(2, "A2"); a.snapshot(); // unsaved: A's tab stays open with its history (a clean one would be opened again)
  b.set(3, "B3"); b.snapshot(); await b.save(d.read, d.write);
  d.text = deleteString(d.text, 1); // B (the text editor, say) deletes string 1, which A saved
  assert.deepEqual(nums(d.text), [2, 3], "control: string 1 is gone");
  a.restore(a1); a.restore(a0); // A undoes past its save: string 1 back to "one", string 2 back too
  assert.equal(a.table.get(1), "one");
  const r = await a.save(d.read, d.write);
  assert.deepEqual(nums(d.text), [2, 3], "string 1 not brought back");
  assert.deepEqual([get(d.text, 2), get(d.text, 3)], ["two", "B3"], "A's undo of string 2 and B's string 3 both there");
  assert.equal(r.shown, true, "A shows string 1 no longer");
  assert.equal(a.table.has(1), false);
  assert.equal(a.dirty, false);
  // Redo all the way: string 1 stays gone, string 2 is A's again.
  a.restore(a1); a.restore(a.snapshot());
  a.set(2, "A2"); a.snapshot();
  await a.save(d.read, d.write);
  assert.deepEqual(nums(d.text), [2, 3]);
  assert.deepEqual([get(d.text, 2), get(d.text, 3)], ["A2", "B3"]);
  // B, which still has string 1 in its table, saves something else: string 1 stays gone for B too.
  b.set(2, "B2"); b.snapshot();
  await b.save(d.read, d.write);
  assert.deepEqual(nums(d.text), [2, 3]);
  assert.equal(get(d.text, 2), "B2");
});

test("undo past a save, then the other deleted the string before A saved: still not brought back", async () => {
  const d = disk(three("one", "two", "three")), a = new WtsSession(d.text);
  const a0 = a.snapshot();
  a.set(1, "A1"); a.snapshot(); await a.save(d.read, d.write);
  a.set(3, "A3"); a.snapshot();
  a.restore(a0); // undone first ...
  d.text = deleteString(d.text, 1); // ... deleted after
  await a.save(d.read, d.write);
  assert.deepEqual(nums(d.text), [2, 3]);
  assert.equal(get(d.text, 3), "three");
});

test("undone while a save was writing, and the other deleted the string meanwhile: no refusal, nothing brought back", async () => {
  const d = disk(three("one", "two", "three")), a = new WtsSession(d.text);
  a.set(1, "A1"); const a1 = a.snapshot(); await a.save(d.read, d.write);
  a.set(1, "A1b"); a.snapshot();
  await a.save(d.read, async (t) => { a.restore(a1); await d.write(t); }); // the undo races the save (racy)
  d.text = deleteString(d.text, 1);
  await a.save(d.read, d.write);
  assert.deepEqual(nums(d.text), [2, 3]);
  assert.equal(a.dirty, false);
});

/** A write that fails after the file was cut short, as `std::fs::write` leaves it when the disk fills up: the file was
 *  emptied when it was opened, and only the first `kept` characters of the new text arrived. */
const tornWrite = (d: { text: string }, kept: (t: string) => number) => async (t: string) => {
  d.text = t.slice(0, kept(t));
  throw new Error("Auf dem Datenträger ist nicht genügend Speicherplatz vorhanden. (os error 112)");
};

test("a write that fails halfway (disk full): the retry writes every string again, none is lost", async () => {
  for (const cut of [0, 9, 30, 40]) { // empty, inside string 1, between blocks, inside string 3
    const d = disk(three("one", "two", "three")), a = new WtsSession(d.text);
    a.set(2, "A2"); a.snapshot();
    await assert.rejects(a.save(d.read, tornWrite(d, () => cut)), /os error 112/);
    assert.notDeepEqual(nums(d.text), [1, 2, 3], `control (cut at ${cut}): the failed write left the file short`);
    assert.equal(a.dirty, true);
    await a.save(d.read, d.write);
    assert.equal(d.text, three("one", "A2", "three"), `cut at ${cut}: the whole file after the retry`);
    assert.equal(a.dirty, false);
  }
});

test("a write that fails halfway keeps A unsaved even after A undoes its edit, and the save repairs the file", async () => {
  const d = disk(three("one", "two", "three")), a = new WtsSession(d.text);
  const a0 = a.snapshot();
  a.set(2, "A2"); a.snapshot();
  await assert.rejects(a.save(d.read, tornWrite(d, (t) => t.length - 12)));
  a.restore(a0); // nothing of A's to write any more, but the file on disk is short
  assert.equal(a.dirty, true, "unsaved: only a save puts the file right");
  await a.save(d.read, d.write);
  assert.equal(d.text, three("one", "two", "three"));
  assert.equal(a.dirty, false);
  // Edits after the repair save as usual.
  a.set(3, "A3"); a.snapshot();
  await a.save(d.read, d.write);
  assert.equal(d.text, three("one", "two", "A3"));
});

test("a recreate whose write fails halfway is written whole by the retry", async () => {
  const d = disk(""), a = new WtsSession(three("one", "two", "three"));
  a.set(1, "A1"); a.snapshot();
  let missing = true;
  const read = async () => { if (missing) throw "os error 2"; return d.text; };
  await assert.rejects(a.save(read, async (t) => { missing = false; await tornWrite(d, () => 20)(t); }, yes, 0));
  await a.save(read, d.write, yes, 0);
  assert.equal(d.text, three("A1", "two", "three"));
});

test("a write that fails halfway, then the other editor saves the short file: what the other wrote is kept", async () => {
  const d = disk(three("one", "two", "three")), a = new WtsSession(d.text);
  a.set(1, "A1"); a.snapshot();
  await assert.rejects(a.save(d.read, tornWrite(d, (t) => t.indexOf("STRING 3"))));
  d.text = text_set(d.text, 2, "B2"); // B saved its string onto the short file: it is B's file now
  await a.save(d.read, d.write);
  assert.equal(get(d.text, 1), "A1");
  assert.equal(get(d.text, 2), "B2", "B's text stays");
});

test("a write refused before anything was written (locked, denied) changes nothing, and the retry saves normally", async () => {
  for (const error of ["Der Prozess kann nicht auf die Datei zugreifen. (os error 32)", "Zugriff verweigert (os error 5)"]) {
    const d = disk(three("one", "two", "three")), a = new WtsSession(d.text);
    a.set(1, "A1"); const snap = a.snapshot();
    const before = d.text;
    await assert.rejects(a.save(d.read, async () => { throw error; }));
    assert.equal(d.text, before);
    assert.deepEqual(a.snapshot(), snap);
    assert.equal(a.dirty, true);
    d.text = text_set(d.text, 3, "B3"); // another editor saves meanwhile
    await a.save(d.read, d.write);
    assert.equal(d.text, three("A1", "two", "B3"));
  }
});
