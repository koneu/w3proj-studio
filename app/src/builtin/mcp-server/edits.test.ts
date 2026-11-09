import assert from "node:assert/strict";
import { test } from "node:test";
import { editablePath, EditLog, type EditIO } from "./edits";
import type { W3Api } from "../../extensions/api";
import { checkpointIfOn, forgetCheckpointsOffWarning } from "../../lib/checkpoint";
import { commandNotFound } from "../../lib/commanderror";

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

test("a group is one entry and one undo, whatever it changed", async () => {
  const { log, files } = setup({ "map/a": "1", "map/b": "1" });
  await log.edit("Before", put("map/a", "2"));
  await log.beginGroup("Forest");
  await log.edit("Trees", put("map/a", "3"));
  await log.edit("Paint", put("map/b", "2"));
  await log.edit("More trees", put("map/a", "4"));
  assert.deepEqual(await log.endGroup(), { title: "Forest", files: 2 });
  assert.deepEqual(log.list().map((e) => e.title), ["Before", "Forest"]);
  assert.equal(await log.undo(), "Forest");
  assert.deepEqual([files.get("map/a"), files.get("map/b")], ["2", "1"]);
  assert.equal(await log.undo(), "Before");
});

test("a group's follow-up work runs each time, and backwards on undo", async () => {
  const { log } = setup({ "map/a": "1" });
  const seen: string[] = [];
  await log.beginGroup("G");
  await log.edit("One", put("map/a", "2"), async (u) => { seen.push(`one ${u}`); });
  await log.edit("Two", put("map/a", "3"), async (u) => { seen.push(`two ${u}`); });
  await log.endGroup();
  await log.undo();
  assert.deepEqual(seen, ["one false", "two false", "two true", "one true"]);
});

test("an empty group leaves nothing, and ending none is harmless", async () => {
  const { log } = setup();
  await log.beginGroup("Nothing");
  assert.deepEqual(await log.endGroup(), { title: "Nothing", files: 0 });
  assert.equal(log.list().length, 0);
  assert.equal(await log.endGroup(), null);
});

test("undo closes an open group, and a failed edit doesn't end it", async () => {
  const { log, files } = setup({ "map/a": "1" });
  await log.beginGroup("G");
  await log.edit("One", put("map/a", "2"));
  await assert.rejects(log.edit("Bad", async () => { throw new Error("no"); }));
  await log.edit("Two", put("map/a", "3"));
  assert.equal(log.list().length, 1);
  await log.undo();
  assert.equal(files.get("map/a"), "1");
  await log.edit("After", put("map/a", "5"));
  assert.deepEqual(log.list().map((e) => e.title), ["After"]);
});

test("what was done stays listed after an undo, marked", async () => {
  const { log } = setup({ "map/a": "1" });
  await log.edit("One", put("map/a", "2"));
  await log.beginGroup("Forest");
  await log.edit("In it", put("map/a", "3"));
  await log.endGroup();
  await log.undo();
  assert.deepEqual(log.history(), [{ title: "Forest", undone: true }, { title: "One", undone: false }].map((e) => ({ id: e.title === "One" ? 1 : 2, ...e })));
  assert.equal(log.list().length, 1);
  log.reset();
  assert.equal(log.history().length, 0);
});

test("old edits drop off", async () => {
  const { log } = setup({ "map/a": "0" });
  for (let i = 1; i <= 35; i++) await log.edit(`E${i}`, put("map/a", String(i)));
  assert.equal(log.list().length, 30);
  assert.equal(log.list()[0].title, "E6");
});

test("with the Checkpoints extension off, AI edits go on and the user is told once that no checkpoint is made", async () => {
  forgetCheckpointsOffWarning();
  const warned: string[] = [];
  // As the MCP server wires it: its checkpoint is checkpointIfOn.
  const w3 = {
    commands: { execute: async (id: string) => { throw new Error(commandNotFound(id)); } },
    window: { showWarning: async (m: string) => { warned.push(m); } },
  } as unknown as W3Api;
  for (const project of ["one", "two"]) {
    const files = new Map([["map/a", "old"]]);
    const log = new EditLog({
      read: async (p) => files.get(p) ?? null, write: async (p, t) => { if (t !== null) files.set(p, t); }, unsaved: () => [],
      checkpoint: () => checkpointIfOn(w3, "The first AI edit of this project").then(() => undefined), log: () => {},
    });
    assert.equal(await log.edit("Change a", put("map/a", `new ${project}`)), true);
    assert.equal(files.get("map/a"), `new ${project}`);
  }
  assert.equal(warned.length, 1, "once per session, not per project");
  assert.match(warned[0], /AI edit of this project went on without a checkpoint/);
  forgetCheckpointsOffWarning();
});

/** A project with a map script made from the triggers (map/war3map.wtg.json), as the Map Script extension does it: a
 *  save of the triggers makes a run due (`pending`), which replaces the script when it's the one written last (the
 *  stamp holds its hash) or when `force` (the user chose Replace). `flush`: the due run, as the save's timer would. */
function scripted(start: Record<string, string>) {
  const files = new Map(Object.entries(start));
  const state = { pending: false, force: false, settles: 0, logged: [] as string[] };
  const J = "map/war3map.j", STAMP = ".w3proj/generated-script", WTG = "map/war3map.wtg.json";
  const made = (wtg: string | undefined) => `script of ${wtg}`;
  const hash = (t: string | undefined) => `#${t}`;
  const flush = () => {
    if (!state.pending) return;
    state.pending = false;
    if (!state.force && files.get(STAMP) !== hash(files.get(J))) return;
    files.set(J, made(files.get(WTG)));
    files.set(STAMP, hash(files.get(J)));
  };
  const io: EditIO = {
    read: async (p) => files.get(p) ?? null,
    write: async (p, t) => {
      if (t === null) files.delete(p); else files.set(p, t);
      if (p === WTG) state.pending = true;
    },
    unsaved: () => [],
    checkpoint: async () => {},
    log: (l) => state.logged.push(l),
    derived: (changed) => (changed.includes(WTG) ? [J, "map/war3map.lua", STAMP] : []),
    settle: async () => { state.settles++; flush(); },
  };
  return { log: new EditLog(io), files, state, flush, made, hash, J, STAMP, WTG };
}

test("undo puts back the map script the edit's regeneration replaced, and its stamp", async () => {
  const s = scripted({ "map/war3map.wtg.json": "a", "map/war3map.j": "written by hand", ".w3proj/generated-script": "#other" });
  // The edit's regeneration replaces it (as after "Replace the script").
  s.state.force = true;
  await s.log.edit("Triggers", put(s.WTG, "b"));
  s.flush();
  assert.equal(s.files.get(s.J), s.made("b"), "control: the edit replaced the script");
  s.state.force = false;
  assert.equal(await s.log.undo(), "Triggers");
  s.flush();
  assert.equal(s.files.get(s.WTG), "a");
  assert.equal(s.files.get(s.J), "written by hand");
  assert.equal(s.files.get(s.STAMP), "#other");
});

test("a script changed after the edit isn't put back over; the rest of the edit is undone", async () => {
  const s = scripted({ "map/war3map.wtg.json": "a", "map/war3map.j": "script of a", ".w3proj/generated-script": "#script of a" });
  await s.log.edit("Triggers", put(s.WTG, "b"));
  s.flush();
  assert.equal(s.files.get(s.J), s.made("b"));
  assert.deepEqual(s.log.list()[0].files.map((f) => f.path), [s.WTG], "the script isn't listed as the edit's file");
  s.files.set(s.J, "changed by hand later");
  assert.equal(await s.log.undo(), "Triggers");
  s.flush();
  assert.equal(s.files.get(s.WTG), "a");
  assert.equal(s.files.get(s.J), "changed by hand later");
  assert.ok(s.state.logged.some((l) => l.includes("map/war3map.j") && l.includes("changed")), s.state.logged.join(" | "));
});

test("a group puts back the script as it was before its first edit; edits of other files don't wait for the script", async () => {
  const s = scripted({ "map/war3map.wtg.json": "a", "map/war3map.j": "mine", ".w3proj/generated-script": "#x", "map/other.txt": "1" });
  await s.log.edit("Other", put("map/other.txt", "2"));
  assert.equal(s.state.settles, 0, "nothing the script is made from changed");
  s.state.force = true;
  await s.log.beginGroup("G");
  await s.log.edit("One", put(s.WTG, "b"));
  s.flush();
  await s.log.edit("Two", put(s.WTG, "c"));
  s.flush();
  await s.log.endGroup();
  s.state.force = false;
  assert.equal(s.files.get(s.J), s.made("c"));
  await s.log.undo();
  s.flush();
  assert.deepEqual([s.files.get(s.WTG), s.files.get(s.J), s.files.get(s.STAMP)], ["a", "mine", "#x"]);
});
