import assert from "node:assert/strict";
import { test } from "node:test";
import { beginResize, changedFiles, isNotFound, recordBytes, resizeCandidates, resizeHistory, ResizeHistory, resizeLoss, restoreFiles, settleWithin, warnsAboutUnsaved, workspaceIO, type FileIO, type Files } from "./resizeundo";
import type { Terrain } from "./w3e";

const bytes = (...n: number[]) => new Uint8Array(n);
const text = (b: Uint8Array | null | undefined) => (b ? [...b].join(",") : null);

/** A project folder in memory. */
function memory(initial: Record<string, number[]>) {
  const files = new Map<string, Uint8Array>(Object.entries(initial).map(([p, b]) => [p, bytes(...b)]));
  const io: FileIO = {
    read: async (p) => files.get(p) ?? null,
    write: async (p, b) => { files.set(p, b); },
    remove: async (p) => { if (!files.delete(p)) throw new Error("no such file"); },
  };
  return { files, io };
}
const undo = (h: ResizeHistory, ...a: Parameters<ResizeHistory["undo"]>) => h.exclusive(() => h.undo(...a));
const redo = (h: ResizeHistory, ...a: Parameters<ResizeHistory["redo"]>) => h.exclusive(() => h.redo(...a));
const never = async (): Promise<boolean> => { throw new Error("must not ask"); };

test("candidates: the map's own files at its root, the editor's file and the overrides; nothing deeper or foreign", () => {
  const got = resizeCandidates(["map/war3map.w3i.json", "map/War3mapUnits.doo", "map/war3mapMap.blp", "map/war3mapImported/x.mdx", "map/units.txt", "src/war3map.j", "map\\war3map.shd"], "map/war3map.w3e").sort();
  assert.deepEqual(got, [".w3proj/generated-script", ".w3proj/pathing.json", "map/War3mapUnits.doo", "map/war3map.shd", "map/war3map.w3e", "map/war3map.w3i.json", "map/war3mapMap.blp"].sort());
});

test("changedFiles keeps only what differs; a file on one side counts as missing on the other", () => {
  const before: Files = new Map([["a", bytes(1)], ["b", bytes(2)], ["c", null]]);
  const after: Files = new Map([["a", bytes(1)], ["b", bytes(3)], ["c", bytes(9)], ["d", null]]);
  const r = changedFiles(before, after);
  assert.deepEqual([...r.before.keys()], ["b", "c"]);
  assert.equal(text(r.before.get("b")), "2");
  assert.equal(r.before.get("c"), null);
  assert.equal(text(r.after.get("c")), "9");
});

function resized() {
  const m = memory({ w3e: [1], doo: [2, 2], gone: [7] });
  const before: Files = new Map([["w3e", bytes(1)], ["doo", bytes(2, 2)], ["gone", bytes(7)], ["made", null]]);
  // The resize: w3e rewritten, doo shrunk, 'gone' deleted, 'made' created.
  m.files.set("w3e", bytes(1, 1, 1)); m.files.set("doo", bytes(2)); m.files.delete("gone"); m.files.set("made", bytes(5));
  const after: Files = new Map([["w3e", bytes(1, 1, 1)], ["doo", bytes(2)], ["gone", null], ["made", bytes(5)]]);
  const kept = changedFiles(before, after);
  const history = new ResizeHistory();
  history.record({ root: "P", editor: "w3e", title: "Resize map", before: kept.before, after: kept.after });
  return { m, history };
}

test("undo puts every file back byte for byte, redo applies the resize again", async () => {
  const { m, history } = resized();
  const done = await undo(history, m.io, "P", never);
  assert.equal(done?.editor, "w3e");
  assert.deepEqual([...m.files.keys()].sort(), ["doo", "gone", "w3e"], "the created file is removed, the deleted one is back");
  assert.equal(text(m.files.get("w3e")), "1");
  assert.equal(text(m.files.get("doo")), "2,2");
  assert.equal(text(m.files.get("gone")), "7");
  assert.equal(history.nextUndo("P"), null);
  assert.ok(await redo(history, m.io, "P", never));
  assert.deepEqual([...m.files.keys()].sort(), ["doo", "made", "w3e"]);
  assert.equal(text(m.files.get("w3e")), "1,1,1");
  assert.equal(text(m.files.get("made")), "5");
  assert.equal(history.nextRedo("P"), null);
  assert.ok(history.nextUndo("P"));
});

test("nothing to undo or redo, or another project's steps: nothing is touched", async () => {
  const { m, history } = resized();
  assert.equal(await undo(history, m.io, "OTHER", never), null);
  assert.equal(await redo(history, m.io, "P", never), null);
  assert.equal(text(m.files.get("w3e")), "1,1,1");
  assert.equal(await undo(new ResizeHistory(), m.io, "P", never), null);
});

test("files changed since the resize are asked about; no leaves everything as it is, yes overwrites", async () => {
  const { m, history } = resized();
  m.files.set("doo", bytes(2, 9));
  let asked: string[] = [];
  assert.equal(await undo(history, m.io, "P", async (c) => { asked = c; return false; }), null);
  assert.deepEqual(asked, ["doo"]);
  assert.equal(text(m.files.get("doo")), "2,9");
  assert.equal(text(m.files.get("w3e")), "1,1,1");
  assert.ok(history.nextUndo("P"), "still undoable after a no");
  assert.ok(await undo(history, m.io, "P", async () => true));
  assert.equal(text(m.files.get("doo")), "2,2");
});

test("a write that fails halfway puts back what was there, and the step stays", async () => {
  const { m, history } = resized();
  const io: FileIO = { ...m.io, write: async (p, b) => { if (p === "doo" && b.length === 2) throw new Error("disk full"); m.files.set(p, b); } };
  await assert.rejects(() => undo(history, io, "P", never), /disk full/);
  assert.equal(text(m.files.get("w3e")), "1,1,1", "the file written before the failure is back to the resized one");
  assert.equal(text(m.files.get("doo")), "2");
  assert.equal(m.files.has("made"), true);
  assert.equal(m.files.has("gone"), false);
  assert.ok(history.nextUndo("P"), "still the step to undo");
});

test("a new resize after an undo drops the redo; the history keeps the newest few", async () => {
  const h = new ResizeHistory(2);
  const rec = (title: string) => ({ root: "P", editor: "e", title, before: new Map([["a", bytes(1)]]) as Files, after: new Map([["a", bytes(2)]]) as Files });
  const m = memory({ a: [2] });
  h.record(rec("1")); h.record(rec("2"));
  await undo(h, m.io, "P", never);
  assert.equal(h.nextRedo("P")?.title, "2");
  h.record(rec("3"));
  assert.equal(h.nextRedo("P"), null, "redo is gone");
  assert.equal(h.nextUndo("P")?.title, "3");
  h.record(rec("4"));
  await undo(h, m.io, "P", async () => true);
  await undo(h, m.io, "P", async () => true);
  assert.equal(h.nextUndo("P"), null, "only two steps are kept");
  h.clear();
  assert.equal(h.nextRedo("P"), null);

  // The undone step is replaced, not kept behind the new one.
  const g = new ResizeHistory(5);
  g.record(rec("1")); g.record(rec("2"));
  await undo(g, m.io, "P", async () => true);
  g.record(rec("3"));
  assert.equal((await undo(g, m.io, "P", async () => true))?.title, "3");
  assert.equal((await undo(g, m.io, "P", async () => true))?.title, "1");
});

function fakeWorkspace(initial: Record<string, number[]>, unreadable = "") {
  const m = memory(initial);
  return {
    m,
    ws: {
      project: () => ({ root: "P" }) as never,
      files: () => [...m.files.keys()].map((path) => ({ path, size: 0, modified: 0 })),
      readBytes: async (p: string) => { if (p === unreadable) throw new Error("Access is denied. (os error 5)"); const b = m.files.get(p); if (!b) throw new Error("The system cannot find the file specified. (os error 2)"); return b; },
      writeBytes: (p: string, b: Uint8Array) => m.io.write(p, b),
      delete: (p: string) => m.io.remove(p),
      refresh: async () => {},
    },
  };
}

test("a resize session records the files it changed, and abort restores them", async () => {
  resizeHistory.clear();
  const { m, ws } = fakeWorkspace({ "map/war3map.w3e": [1], "map/war3map.doo": [2], "map/war3map.j": [3], "map/readme.txt": [4] });
  const session = await beginResize(ws, "map/war3map.w3e", "Resize map");
  m.files.set("map/war3map.w3e", bytes(1, 1)); m.files.set("map/war3map.wpm", bytes(8)); m.files.set(".w3proj/pathing.json", bytes(6));
  m.files.set("map/readme.txt", bytes(5));
  await session.finish();
  const rec = resizeHistory.nextUndo("P");
  assert.ok(rec);
  // The script and the doodads weren't touched; the readme isn't the map's.
  assert.deepEqual([...rec.before.keys()].sort(), [".w3proj/pathing.json", "map/war3map.w3e", "map/war3map.wpm"]);
  resizeHistory.clear();

  const second = await beginResize(ws, "map/war3map.w3e", "Resize map");
  m.files.set("map/war3map.doo", bytes(2, 2)); m.files.delete("map/war3map.wpm");
  await second.abort();
  assert.equal(text(m.files.get("map/war3map.doo")), "2");
  assert.equal(text(m.files.get("map/war3map.wpm")), "8");
  assert.equal(resizeHistory.nextUndo("P"), null, "a failed resize isn't a step");
});

test("restoreFiles with nothing to restore changes nothing", async () => {
  const m = memory({ a: [1] });
  await restoreFiles(m.io, new Map());
  assert.equal(text(m.files.get("a")), "1");
});

function terrain(w: number, h: number): Terrain {
  return { width: w + 1, height: h + 1, offsetX: -w * 64, offsetY: -h * 64, corners: [] } as unknown as Terrain;
}

test("what a resize loses is named: tiles of ground and the objects it removes", () => {
  const t = terrain(64, 64); // 64 x 64 tiles, from -4096 to 4096
  assert.deepEqual(resizeLoss(t, [0, 0, 0, 0], 0), []);
  assert.deepEqual(resizeLoss(t, [32, 0, 0, 32], 0), [], "growing loses no ground");
  // Cut 32 tiles from the left: 32 x 64 tiles go.
  const left = resizeLoss(t, [-32, 0, 0, 0], 2);
  assert.equal(left.length, 2);
  assert.match(left[0], /^2048 tiles of terrain/);
  assert.equal(left[1], "2 objects (doodads on or past the new edge, units and items outside the playable area)");
  assert.match(resizeLoss(t, [-32, 0, -32, 0], 0)[0], /^3072 tiles/, "an L-shaped cut: 4096 minus 32 x 32 kept");
  assert.equal(resizeLoss(t, [0, -32, 0, 0], 0).length, 1, "nothing removed: no object line");
  assert.deepEqual(resizeLoss(t, [32, 0, 0, 0], 1), ["1 object (doodads on or past the new edge, units and items outside the playable area)"],
    "growing can remove a unit that the new border leaves outside the playable area");
});

test("undo and redo run one at a time: two started together neither lose a step nor take the same one twice", async () => {
  const { m, history } = resized();
  // Slow reads: the second call would run in the middle of the first one without the lock.
  const slow: FileIO = { ...m.io, read: async (p) => { await new Promise((r) => setTimeout(r, 5)); return m.io.read(p); } };
  const a = undo(history, slow, "P", never);
  const b = undo(history, slow, "P", never);
  const [x, y] = await Promise.all([a, b]);
  assert.ok(x, "the first undoes the step");
  assert.equal(y, null, "the second finds nothing left to undo");
  assert.equal(text(m.files.get("w3e")), "1");
  const c = redo(history, slow, "P", never);
  const d = undo(history, slow, "P", never);
  await Promise.all([c, d]);
  assert.equal(text(m.files.get("w3e")), "1", "redo, then undo, in the order asked");
  assert.ok(history.nextRedo("P"), "the step is left to redo, not lost");
});

test("undo outside exclusive is refused, and a step changed while the question was open is not applied", async () => {
  const { m, history } = resized();
  await assert.rejects(() => history.undo(m.io, "P", never), /exclusive/);
  await assert.rejects(() => history.redo(m.io, "P", never), /exclusive/);
  m.files.set("doo", bytes(2, 9));
  // While it asks, the history is cleared, as another project's opening does.
  const r = await undo(history, m.io, "P", async () => { history.clear(); return true; });
  assert.equal(r, null);
  assert.equal(text(m.files.get("w3e")), "1,1,1", "nothing was written");
});

test("a task in exclusive that fails doesn't block the next", async () => {
  const h = new ResizeHistory();
  await assert.rejects(() => h.exclusive(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await h.exclusive(async () => 7), 7);
});

test("the history is also capped by bytes; the newest step stays whatever its size", () => {
  const big = (n: number, title: string) => ({ root: "P", editor: "e", title, before: new Map([["a", new Uint8Array(n)]]) as Files, after: new Map([["a", new Uint8Array(n).fill(1)]]) as Files });
  assert.equal(recordBytes(big(10, "x")), 20);
  const h = new ResizeHistory(10, 100);
  h.record(big(20, "1")); h.record(big(20, "2"));
  assert.deepEqual(h.steps.map((r) => r.title), ["1", "2"], "40 bytes fit");
  h.record(big(30, "3"));
  assert.deepEqual(h.steps.map((r) => r.title), ["2", "3"], "100 bytes: the oldest goes");
  h.record(big(200, "4"));
  assert.deepEqual(h.steps.map((r) => r.title), ["4"], "one step over the cap stays");
  assert.equal(h.nextUndo("P")?.title, "4");
});

test("not-found is told from unreadable by the backend's error; unreadable is never stored as missing", async () => {
  assert.ok(isNotFound("The system cannot find the file specified. (os error 2)"));
  assert.ok(isNotFound(new Error("Das System kann den angegebenen Pfad nicht finden. (os error 3)")));
  assert.ok(!isNotFound("Access is denied. (os error 5)"));
  assert.ok(!isNotFound("file list says no"));
  const { ws } = fakeWorkspace({ "map/war3map.w3e": [1] }, ".w3proj/pathing.json");
  const io = workspaceIO(ws);
  assert.equal(await io.read("map/missing.bin"), null);
  assert.equal(text(await io.read("map/war3map.w3e")), "1");
  await assert.rejects(() => io.read(".w3proj/pathing.json"), /Access is denied/);
  // So a resize can't even start on a file that can't be read, and nothing is recorded or deleted.
  resizeHistory.clear();
  await assert.rejects(() => beginResize(ws, "map/war3map.w3e", "Resize map"), /Access is denied/);
  assert.equal(resizeHistory.nextUndo("P"), null);
});

test("redo also checks its step after the question, and the lock is let go after a failed task", async () => {
  const { m, history } = resized();
  await undo(history, m.io, "P", never);
  m.files.set("w3e", bytes(4));
  const r = await redo(history, m.io, "P", async () => { history.clear(); return true; });
  assert.equal(r, null);
  assert.equal(text(m.files.get("w3e")), "4", "nothing was written");
  await assert.rejects(() => history.exclusive(async () => { throw new Error("boom"); }), /boom/);
  await assert.rejects(() => history.undo(m.io, "P", never), /exclusive/, "outside again after the failed task");
});

test("work due before a resize that never ends fails with a message instead of holding it for ever", async () => {
  await settleWithin(async () => {}, 1000);
  await settleWithin(async () => { throw new Error("a rebuild's own failure is shown by the rebuild"); }, 1000);
  await assert.rejects(() => settleWithin(() => new Promise(() => {}), 20), /still being rebuilt after 0 s\. Nothing was changed/);
});

test("the quiet Ctrl+Z path stays silent about the editor's own unsaved changes only", () => {
  assert.equal(warnsAboutUnsaved([], "e", true), false);
  assert.equal(warnsAboutUnsaved(["e"], "e", true), false, "its own changes: silent");
  assert.equal(warnsAboutUnsaved(["e"], "e", false), true, "the command says it");
  assert.equal(warnsAboutUnsaved(["e", "other"], "e", true), true, "another document too: said");
  assert.equal(warnsAboutUnsaved(["other"], "e", true), true);
});

test("a file another program holds open, or a bad name, is there: it reads as an error, never as missing", async () => {
  for (const n of [32, 33, 22, 267, 20, 21, 23, 24]) {
    const io = workspaceIO({ ...fakeWorkspace({}).ws, readBytes: async () => { throw `Der Prozess kann nicht auf die Datei zugreifen. (os error ${n})`; } });
    await assert.rejects(() => io.read("map/war3map.w3e"), (e) => String(e).endsWith(`(os error ${n})`), `os error ${n}`);
  }
  // A plain string rejection of error 2 is still "missing".
  const io = workspaceIO({ ...fakeWorkspace({}).ws, readBytes: async () => { throw "The system cannot find the file specified. (os error 2)"; } });
  assert.equal(await io.read("map/war3map.w3e"), null);
});

test("the session keeps what was on screen when the resize started, for the undo to leave alone", async () => {
  resizeHistory.clear();
  const { m, ws } = fakeWorkspace({ "map/war3map.w3e": [1] });
  const old = {};
  const session = await beginResize(ws, "map/war3map.w3e", "Resize map", new Set([old]));
  m.files.set("map/war3map.w3e", bytes(2));
  await session.finish();
  assert.ok(resizeHistory.nextUndo("P")?.shownBefore?.has(old));
  resizeHistory.clear();
});
