import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_SUBTERRAINS, withAllSubterrainsOpen, type OpenAllApi } from "./openall";
import type { OpenState } from "./openset";

/** A split project of `names` with `open` open, as the backend tells it; the open command changes it. */
function fake(names: string[], open: string[] | "all", opts: { split?: boolean; unsaved?: string[]; failOpen?: "all" | "names"; error?: string } = {}) {
  const s = { names: [...names], open: open === "all" ? [...names] : [...open] };
  const log: string[] = [];
  const state = (): OpenState => ({
    partial: s.open.length < s.names.length, source: s.open.length < s.names.length ? "file" : "default", corners: [65, 65], halo: 2,
    subterrains: s.names.map((n) => ({ name: n, x: 0, y: 0, w: 1, h: 1, open: s.open.includes(n), halo: false, bytes: 1 })),
    mask: "", error: opts.error ?? null,
  });
  const w3: OpenAllApi = {
    workspace: { project: () => ({ root: "/p" }) as ReturnType<OpenAllApi["workspace"]["project"]>, files: () => (opts.split === false ? [] : [{ path: "map/terrain/terrain.json" }]) as ReturnType<OpenAllApi["workspace"]["files"]> },
    editors: { unsavedPaths: () => opts.unsaved ?? [] },
    commands: {
      execute: (async (id: string, arg: { all?: boolean; names?: string[]; quiet?: boolean }) => {
        assert.equal(id, OPEN_SUBTERRAINS);
        assert.equal(arg.quiet, true, "the caller tells of a failure");
        log.push(arg.all ? "open all" : `open ${arg.names!.join(",")}`);
        if ((arg.all && opts.failOpen === "all") || (arg.names && opts.failOpen === "names")) throw new Error("unsaved changes");
        s.open = arg.all ? [...s.names] : [...arg.names!];
      }) as OpenAllApi["commands"]["execute"],
    },
    backend: { invoke: (async (cmd: string) => { assert.equal(cmd, "terrain_open_state"); return opts.split === false ? null : state(); }) as OpenAllApi["backend"]["invoke"] },
    window: {
      showWarning: async (m: string) => { log.push(`warn ${m}`); return undefined; },
      showInfo: async (m: string) => { log.push(`info ${m}`); return undefined; },
    },
  };
  return { w3, s, log };
}

test("with subterrains closed the task runs with all open, and the chosen ones are opened again", async () => {
  const { w3, s, log } = fake(["nw", "ne", "sw", "se"], ["ne", "sw"]);
  const seen = await withAllSubterrainsOpen(w3, "Map Size", async () => [...s.open]);
  assert.deepEqual(seen, ["nw", "ne", "sw", "se"]);
  assert.deepEqual(s.open, ["ne", "sw"]);
  assert.deepEqual(log, ["open all", "open ne,sw"]);
});

test("a failing task still closes them again; its error passes on", async () => {
  const { w3, s, log } = fake(["nw", "ne"], ["ne"]);
  await assert.rejects(withAllSubterrainsOpen(w3, "Map Size", async () => { throw new Error("refused"); }), /refused/);
  assert.deepEqual(s.open, ["ne"]);
  assert.deepEqual(log, ["open all", "open ne"]);
});

test("a subterrain the task removed is left out; none left keeps all open and says so", async () => {
  const a = fake(["nw", "ne", "se"], ["ne", "se"]);
  await withAllSubterrainsOpen(a.w3, "Map Size", async () => { a.s.names = ["nw", "ne"]; a.s.open = ["nw", "ne"]; });
  assert.deepEqual(a.s.open, ["ne"]);
  const b = fake(["nw", "ne"], ["ne"]);
  await withAllSubterrainsOpen(b.w3, "Map Size", async () => { b.s.names = ["nw"]; b.s.open = ["nw"]; });
  assert.deepEqual(b.s.open, ["nw"]);
  assert.match(b.log.at(-1)!, /^info Map Size: the subterrains that were open \(ne\) are no longer in the layout/);
});

test("all open, a flat project: the task runs as it is, nothing opened or closed", async () => {
  for (const f of [fake(["nw", "ne"], "all"), fake([], "all", { split: false })]) {
    assert.equal(await withAllSubterrainsOpen(f.w3, "Map Size", async () => 7), 7);
    assert.deepEqual(f.log, []);
  }
});

test("refused before anything opens: unsaved changes, a damaged choice, the open failing", async () => {
  let ran = false;
  const task = async () => { ran = true; };
  const unsaved = fake(["nw", "ne"], ["ne"], { unsaved: ["map/war3map.w3i.json"] });
  await assert.rejects(withAllSubterrainsOpen(unsaved.w3, "Map Size", task), /map\/war3map\.w3i\.json has unsaved changes: save or discard them first\. Nothing was changed\./);
  const damaged = fake(["nw", "ne"], ["ne"], { error: "it isn't JSON" });
  await assert.rejects(withAllSubterrainsOpen(damaged.w3, "Map Size", task), /it isn't JSON/);
  const failing = fake(["nw", "ne"], ["ne"], { failOpen: "all" });
  await assert.rejects(withAllSubterrainsOpen(failing.w3, "Map Size", task), /couldn't be opened for it \(unsaved changes\)\. Nothing was changed\./);
  assert.equal(ran, false);
  for (const f of [unsaved, damaged]) assert.deepEqual(f.log, []);
  assert.deepEqual(failing.s.open, ["ne"]);
});

test("closing them again failing leaves all open with a warning; the task's result stands", async () => {
  const { w3, s, log } = fake(["nw", "ne"], ["ne"], { failOpen: "names" });
  assert.equal(await withAllSubterrainsOpen(w3, "Undo Resize", async () => "done"), "done");
  assert.deepEqual(s.open, ["nw", "ne"]);
  assert.match(log.at(-1)!, /^warn Undo Resize: every subterrain stays open; the ones that were open \(ne\) couldn't be chosen again: unsaved changes/);
});
