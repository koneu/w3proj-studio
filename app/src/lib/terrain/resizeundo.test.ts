import assert from "node:assert/strict";
import { test } from "node:test";
import { beginResize, changedFiles, resizeCandidates, resizeHistory, ResizeHistory, resizeLoss, restoreFiles, type FileIO, type Files } from "./resizeundo";
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
const never = async (): Promise<boolean> => { throw new Error("must not ask"); };

test("candidates: the map's own files at its root, the editor's file and the overrides; nothing deeper or foreign", () => {
  const got = resizeCandidates(["map/war3map.w3i.json", "map/War3mapUnits.doo", "map/war3mapMap.blp", "map/war3mapImported/x.mdx", "map/units.txt", "src/war3map.j", "map\\war3map.shd"], "map/war3map.w3e").sort();
  assert.deepEqual(got, [".w3proj/pathing.json", "map/War3mapUnits.doo", "map/war3map.shd", "map/war3map.w3e", "map/war3map.w3i.json", "map/war3mapMap.blp"].sort());
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
  const done = await history.undo(m.io, "P", never);
  assert.equal(done?.editor, "w3e");
  assert.deepEqual([...m.files.keys()].sort(), ["doo", "gone", "w3e"], "the created file is removed, the deleted one is back");
  assert.equal(text(m.files.get("w3e")), "1");
  assert.equal(text(m.files.get("doo")), "2,2");
  assert.equal(text(m.files.get("gone")), "7");
  assert.equal(history.nextUndo("P"), null);
  assert.ok(await history.redo(m.io, "P", never));
  assert.deepEqual([...m.files.keys()].sort(), ["doo", "made", "w3e"]);
  assert.equal(text(m.files.get("w3e")), "1,1,1");
  assert.equal(text(m.files.get("made")), "5");
  assert.equal(history.nextRedo("P"), null);
  assert.ok(history.nextUndo("P"));
});

test("nothing to undo or redo, or another project's steps: nothing is touched", async () => {
  const { m, history } = resized();
  assert.equal(await history.undo(m.io, "OTHER", never), null);
  assert.equal(await history.redo(m.io, "P", never), null);
  assert.equal(text(m.files.get("w3e")), "1,1,1");
  assert.equal(await new ResizeHistory().undo(m.io, "P", never), null);
});

test("files changed since the resize are asked about; no leaves everything as it is, yes overwrites", async () => {
  const { m, history } = resized();
  m.files.set("doo", bytes(2, 9));
  let asked: string[] = [];
  assert.equal(await history.undo(m.io, "P", async (c) => { asked = c; return false; }), null);
  assert.deepEqual(asked, ["doo"]);
  assert.equal(text(m.files.get("doo")), "2,9");
  assert.equal(text(m.files.get("w3e")), "1,1,1");
  assert.ok(history.nextUndo("P"), "still undoable after a no");
  assert.ok(await history.undo(m.io, "P", async () => true));
  assert.equal(text(m.files.get("doo")), "2,2");
});

test("a write that fails halfway puts back what was there, and the step stays", async () => {
  const { m, history } = resized();
  const io: FileIO = { ...m.io, write: async (p, b) => { if (p === "doo" && b.length === 2) throw new Error("disk full"); m.files.set(p, b); } };
  await assert.rejects(() => history.undo(io, "P", never), /disk full/);
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
  await h.undo(m.io, "P", never);
  assert.equal(h.nextRedo("P")?.title, "2");
  h.record(rec("3"));
  assert.equal(h.nextRedo("P"), null, "redo is gone");
  assert.equal(h.nextUndo("P")?.title, "3");
  h.record(rec("4"));
  await h.undo(m.io, "P", async () => true);
  await h.undo(m.io, "P", async () => true);
  assert.equal(h.nextUndo("P"), null, "only two steps are kept");
  h.clear();
  assert.equal(h.nextRedo("P"), null);

  // The undone step is replaced, not kept behind the new one.
  const g = new ResizeHistory(5);
  g.record(rec("1")); g.record(rec("2"));
  await g.undo(m.io, "P", async () => true);
  g.record(rec("3"));
  assert.equal((await g.undo(m.io, "P", async () => true))?.title, "3");
  assert.equal((await g.undo(m.io, "P", async () => true))?.title, "1");
});

function fakeWorkspace(initial: Record<string, number[]>) {
  const m = memory(initial);
  return {
    m,
    ws: {
      project: () => ({ root: "P" }) as never,
      files: () => [...m.files.keys()].map((path) => ({ path, size: 0, modified: 0 })),
      readBytes: async (p: string) => { const b = m.files.get(p); if (!b) throw new Error("missing"); return b; },
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

test("what a shrink loses is named: tiles of ground and objects outside", () => {
  const t = terrain(64, 64); // 64 x 64 tiles, from -4096 to 4096
  assert.deepEqual(resizeLoss(t, [0, 0, 0, 0], []), []);
  assert.deepEqual(resizeLoss(t, [32, 0, 0, 32], [{ position: [9999, 0] }]), [], "growing loses nothing, whatever lies about");
  const objects = [{ position: [-4000, 0, 0] }, { position: [-3000, 0, 0] }, { position: [3000, 4000, 0] }, { position: [0, 0, 0] }];
  // Cut 32 tiles from the left: 32 x 64 tiles go, and x < -4096 + 32 * 128 = 0 is outside.
  const left = resizeLoss(t, [-32, 0, 0, 0], objects);
  assert.equal(left.length, 2);
  assert.match(left[0], /^2048 tiles of terrain/);
  assert.match(left[1], /^2 objects /);
  assert.match(resizeLoss(t, [-32, 0, -32, 0], [])[0], /^3072 tiles/, "an L-shaped cut: 4096 minus 32 x 32 kept");
  assert.equal(resizeLoss(t, [0, -32, 0, 0], [{ position: [-100, 0] }]).length, 1, "one object inside: no object line");
  assert.equal(resizeLoss(t, [-32, 0, 0, 0], [{ id: "sloc", position: [-3000, 0] }, { id: "hfoo", position: [-3000, 0] }])[1], "1 object (doodads, units, items) outside the new map", "a start location is moved, not lost");
  assert.equal(resizeLoss(t, [-32, 0, 0, 0], [{ position: [-4096, 0] }])[1], "1 object (doodads, units, items) outside the new map");
});
