import assert from "node:assert/strict";
import { test } from "node:test";
import { editablePath, EditLog, type EditIO } from "./edits";

function setup(start: Record<string, string> = {}) {
  const files = new Map(Object.entries(start));
  const state = { unsaved: [] as string[], checkpoints: 0, failCheckpoint: false, failWrite: "", logged: [] as string[] };
  const io: EditIO = {
    read: async (p) => files.get(p) ?? null,
    write: async (p, t) => {
      if (p === state.failWrite && t !== null && t.startsWith("new")) throw new Error("disk full");
      if (t === null) files.delete(p); else files.set(p, t);
    },
    unsaved: () => state.unsaved,
    checkpoint: async () => { state.checkpoints++; if (state.failCheckpoint) throw new Error("pack failed"); },
    log: (l) => state.logged.push(l),
  };
  return { log: new EditLog(io), files, state };
}
const put = (path: string, text: string) => async () => [{ path, text }];

test("an edit changes the file and can be undone", async () => {
  const { log, files } = setup({ "map/a": "old" });
  assert.equal(await log.edit("Change a", put("map/a", "new")), true);
  assert.equal(files.get("map/a"), "new");
  assert.equal(await log.undo(), "Change a");
  assert.equal(files.get("map/a"), "old");
  assert.equal(await log.undo(), null);
});

test("undoing an edit that made a file removes it", async () => {
  const { log, files } = setup();
  await log.edit("Make b", put("map/b", "new"));
  await log.undo();
  assert.equal(files.has("map/b"), false);
});

test("edits undo newest first, and several files as one", async () => {
  const { log, files } = setup({ "map/a": "1", "map/b": "1" });
  await log.edit("First", put("map/a", "2"));
  await log.edit("Second", async () => [{ path: "map/a", text: "3" }, { path: "map/b", text: "2" }]);
  assert.equal(await log.undo(), "Second");
  assert.deepEqual([files.get("map/a"), files.get("map/b")], ["2", "1"]);
  assert.equal(await log.undo(), "First");
  assert.equal(files.get("map/a"), "1");
});

test("nothing is written while something is unsaved", async () => {
  const { log, files, state } = setup({ "map/a": "old" });
  await log.edit("One", put("map/a", "new"));
  state.unsaved = ["map/war3map.w3e.txt"];
  await assert.rejects(log.edit("Two", put("map/a", "newer")), /war3map\.w3e\.txt has unsaved changes/);
  await assert.rejects(log.undo(), /unsaved changes/);
  assert.equal(files.get("map/a"), "new");
});

test("only map/ can be written, and only inside the project", async () => {
  const { log, files } = setup();
  for (const bad of [".w3proj/extensions/x/index.js", "w3proj.toml", "map/../w3proj.toml", "C:\\x", "../x"]) {
    await assert.rejects(log.edit("Bad", put(bad, "x")), Error, bad);
  }
  await assert.rejects(log.edit("Bad read", async (read) => { await read(".w3proj/x"); return []; }), /stay inside map/);
  assert.equal(files.size, 0);
  assert.equal(editablePath("map\\war3map.j"), "map/war3map.j");
});

test("a checkpoint comes before the first edit only; if it fails the edit still happens, and says so", async () => {
  const { log, state, files } = setup({ "map/a": "1" });
  state.failCheckpoint = true;
  await log.edit("One", put("map/a", "2"));
  await log.edit("Two", put("map/a", "3"));
  assert.equal(state.checkpoints, 1);
  assert.equal(files.get("map/a"), "3");
  assert.ok(state.logged.some((l) => l.includes("pack failed")));
  log.reset();
  state.failCheckpoint = false;
  await log.edit("Other project", put("map/a", "4"));
  assert.equal(state.checkpoints, 2);
  assert.equal(log.list().length, 1);
});

test("an edit changing nothing leaves no trace", async () => {
  const { log, state } = setup({ "map/a": "same" });
  assert.equal(await log.edit("Nothing", put("map/a", "same")), false);
  assert.equal(log.list().length, 0);
  assert.equal(state.checkpoints, 0);
});

test("a failed write puts back what was already written", async () => {
  const { log, files, state } = setup({ "map/a": "old a", "map/b": "old b" });
  state.failWrite = "map/b";
  await assert.rejects(log.edit("Both", async () => [{ path: "map/a", text: "new a" }, { path: "map/b", text: "new b" }]), /disk full/);
  assert.deepEqual([files.get("map/a"), files.get("map/b")], ["old a", "old b"]);
  assert.equal(log.list().length, 0);
});

test("undo refuses when the file changed since", async () => {
  const { log, files } = setup({ "map/a": "old" });
  await log.edit("Change", put("map/a", "new"));
  files.set("map/a", "the user's own edit");
  await assert.rejects(log.undo(), /changed after "Change"/);
  assert.equal(files.get("map/a"), "the user's own edit");
  assert.equal(log.list().length, 1);
});

test("parallel edits happen one after the other, each seeing the last", async () => {
  const { log, files } = setup({ "map/n": "0" });
  const add = (read: (p: string) => Promise<string | null>) => read("map/n").then((t) => [{ path: "map/n", text: String(Number(t) + 1) }]);
  await Promise.all([log.edit("a", add), log.edit("b", add), log.edit("c", add)]);
  assert.equal(files.get("map/n"), "3");
});

test("a failing edit doesn't stop the next one", async () => {
  const { log, files } = setup({ "map/a": "1" });
  await assert.rejects(log.edit("Bad", async () => { throw new Error("no such object"); }), /no such object/);
  await log.edit("Good", put("map/a", "2"));
  assert.equal(files.get("map/a"), "2");
});

test("follow-up work runs after an edit and after its undo, and can't take either back", async () => {
  const { log, files, state } = setup({ "map/a": "old" });
  const seen: [boolean, string | undefined][] = [];
  await log.edit("Change", put("map/a", "new"), async (undoing) => { seen.push([undoing, files.get("map/a")]); throw new Error("no minimap"); });
  await log.undo();
  assert.deepEqual(seen, [[false, "new"], [true, "old"]]);
  assert.equal(files.get("map/a"), "old");
  assert.ok(state.logged.some((l) => l.includes("no minimap")));
  await log.edit("Nothing", put("map/a", "old"), async () => { seen.push([false, "ran"]); });
  assert.equal(seen.length, 2, "nothing changed, nothing follows");
});

test("old edits drop off", async () => {
  const { log } = setup({ "map/a": "0" });
  for (let i = 1; i <= 35; i++) await log.edit(`E${i}`, put("map/a", String(i)));
  assert.equal(log.list().length, 30);
  assert.equal(log.list()[0].title, "E6");
});
