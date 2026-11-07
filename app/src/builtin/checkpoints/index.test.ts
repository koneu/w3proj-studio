// The checkpoint extension through its own commands and timer, on a made-up app: a checkpoint a
// command asks for exists before it returns, also while an automatic one is being made, and an
// automatic one never lands in a project opened while it was looking at the old one.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, FileInfo, ProjectInfo, W3Api } from "../../extensions/api";
import { activate } from "./index";

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open = () => {};
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};
const turn = () => new Promise<void>((r) => setTimeout(r, 0));

/** A project at `root` whose packed map is `<root>\build\Map.w3x`. */
const project = (root: string) => ({ root, default_output: `${root}\\build\\Map.w3x` }) as unknown as ProjectInfo;

function fakeApp() {
  let current: ProjectInfo | null = project("C:\\one");
  const files: FileInfo[] = [{ path: "map/war3map.w3e", size: 10, modified: Date.now() }];
  const log: string[] = [];
  const commands = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  /** project_pack calls wait on these when set, in order. */
  const packGates: Gate[] = [];
  /** listFolder waits on this when set. */
  let listGate: Gate | null = null;
  let tick: (() => void) | null = null;
  const none = { dispose() {} };
  const w3 = {
    output: { channel: () => ({ append: (s: string) => log.push(`out ${s}`) }) },
    workspace: {
      project: () => current,
      files: () => files,
      listFolder: async () => { const g = listGate; if (g) await g.promise; return [] as string[]; },
    },
    settings: { get: () => undefined },
    backend: {
      invoke: async (cmd: string, a: { root: string; output?: string; path?: string }) => {
        if (cmd === "project_pack") {
          log.push(`pack start ${a.output}`);
          const g = packGates.shift();
          if (g) await g.promise;
          log.push(`pack done ${a.output}`);
          return null;
        }
        log.push(`${cmd} ${a.path}`);
        return null;
      },
    },
    commands: {
      execute: async (id: string) => { log.push(`command ${id}`); },
      register: (id: string, fn: (...a: unknown[]) => Promise<unknown>) => { commands.set(id, fn); return none; },
    },
    mcp: { registerTool: () => none },
    editors: { saveAll: async () => {}, unsavedPaths: () => [] },
    window: { showInfo: async () => undefined, showWarning: async () => undefined },
  } as unknown as W3Api;
  const ctx = { subscriptions: [] as { dispose(): void }[] } as unknown as ExtensionContext;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval;
  try { activate(w3, ctx); } finally { globalThis.setInterval = realSetInterval; }
  return {
    log, commands, packGates,
    setList: (g: Gate | null) => { listGate = g; },
    open: (p: ProjectInfo | null) => { current = p; },
    tick: () => tick!(),
    dispose: () => ctx.subscriptions.forEach((s) => s.dispose()),
  };
}

const packs = (log: string[], what: "start" | "done") => log.filter((l) => l.startsWith(`pack ${what}`));

test("a checkpoint asked for while an automatic one runs is made after it, before the command returns", async () => {
  const app = fakeApp();
  const auto = gate();
  app.packGates.push(auto);
  app.tick();
  for (let i = 0; i < 5 && !packs(app.log, "start").length; i++) await turn();
  assert.equal(packs(app.log, "start").length, 1, "the automatic checkpoint is running");

  let returned = false;
  const asked = app.commands.get("w3.checkpoints.create")!({ quiet: true }).then(() => { returned = true; });
  for (let i = 0; i < 5; i++) await turn();
  assert.equal(returned, false, "the command waits while the automatic one is still packing");

  auto.open();
  await asked;
  assert.equal(packs(app.log, "done").length, 2, "a fresh checkpoint of its own, after the running one");
  const [first, second] = packs(app.log, "start");
  assert.ok(app.log.indexOf(second) > app.log.indexOf(packs(app.log, "done")[0]), "started after the automatic one finished");
  assert.notEqual(first.slice("pack start ".length), second.slice("pack start ".length), "its own file, not the automatic one's");
  app.dispose();
});

test("two commands asking at once each get their own checkpoint", async () => {
  const app = fakeApp();
  const create = app.commands.get("w3.checkpoints.create")!;
  await Promise.all([create({ quiet: true }), create({ quiet: true })]);
  const done = packs(app.log, "done");
  assert.equal(done.length, 2);
  assert.equal(new Set(done).size, 2, "different files");
  app.dispose();
});

test("an automatic checkpoint started for one project never packs the project opened during its look", async () => {
  const app = fakeApp();
  const list = gate();
  app.setList(list);
  app.tick();
  await turn();
  app.open(project("C:\\two"));
  app.setList(null);
  list.open();
  for (let i = 0; i < 10; i++) await turn();
  assert.deepEqual(packs(app.log, "start").filter((l) => l.includes("C:\\two")), [], "nothing packed into the new project");
  app.dispose();
});

test("control: with nothing in the way, the automatic checkpoint packs its project", async () => {
  const app = fakeApp();
  app.tick();
  for (let i = 0; i < 10 && !packs(app.log, "done").length; i++) await turn();
  assert.equal(packs(app.log, "done").length, 1);
  assert.match(packs(app.log, "done")[0], /^pack done C:\\one\\build\\checkpoints\\Map \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.w3x$/);
  app.dispose();
});
