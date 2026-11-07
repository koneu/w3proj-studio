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

/** `existing`: checkpoint files already in C:\one\build\checkpoints. `keep`: the setting. */
/** `busy`: the map keeps changing and a checkpoint is due at every look (interval 0). */
function fakeApp(opts: { existing?: string[]; keep?: number; failDelete?: boolean; busy?: boolean } = {}) {
  let current: ProjectInfo | null = project("C:\\one");
  const files: FileInfo[] = [{ path: "map/war3map.w3e", size: 10, modified: Date.now() + (opts.busy ? 3_600_000 : 0) }];
  const log: string[] = [];
  const commands = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  /** Checkpoint files on disk, by full path. */
  const disk = new Set((opts.existing ?? []).map((n) => `C:\\one\\build\\checkpoints\\${n}`));
  /** project_pack calls wait on these when set, in order. */
  const packGates: Gate[] = [];
  /** listFolder waits on this when set. */
  let listGate: Gate | null = null;
  /** Runs while the editors close for a restore (the user opening another project, say). */
  let duringClose: () => void = () => {};
  /** Runs while the map files are being replaced from the checkpoint. */
  let duringSync: () => Promise<void> = async () => {};
  /** What the restore picks. */
  let pick = "";
  let tick: (() => void) | null = null;
  const none = { dispose() {} };
  const w3 = {
    output: { channel: () => ({ append: (s: string) => log.push(`out ${s}`) }) },
    workspace: {
      project: () => current,
      files: () => files,
      listFolder: async (folder: string) => {
        const g = listGate;
        if (g) await g.promise;
        return [...disk].filter((p) => p.startsWith(`${folder}\\`)).map((p) => p.slice(folder.length + 1));
      },
    },
    settings: { get: (key: string) => (key === "checkpoints.keep" ? opts.keep : key === "checkpoints.intervalMinutes" && opts.busy ? 0 : undefined) },
    backend: {
      invoke: async (cmd: string, a: { root: string; output?: string; path?: string }) => {
        if (cmd === "project_pack") {
          log.push(`pack start ${a.output}`);
          const g = packGates.shift();
          if (g) await g.promise;
          disk.add(a.output!);
          log.push(`pack done ${a.output}`);
          return null;
        }
        if (cmd === "fs_delete" && opts.failDelete) throw new Error("access denied");
        if (cmd === "fs_delete") disk.delete(a.path!);
        log.push(`${cmd} ${a.path}`);
        return null;
      },
    },
    commands: {
      execute: async (id: string, arg?: unknown) => {
        log.push(`command ${id}`);
        if (id !== "w3.project.syncFromMap") return;
        log.push(`sync ${disk.has(String(arg)) ? "from" : "FROM MISSING"} ${String(arg)}`);
        await duringSync();
        if (!disk.has(String(arg))) log.push(`sync lost ${String(arg)}`);
      },
      register: (id: string, fn: (...a: unknown[]) => Promise<unknown>) => { commands.set(id, fn); return none; },
    },
    mcp: { registerTool: (name: string, fn: (args: Record<string, unknown>) => Promise<unknown>) => { tools.set(name, fn); return none; } },
    editors: {
      saveAll: async () => {}, unsavedPaths: () => [],
      closeAll: async () => { duringClose(); }, closeAllAsking: async () => { duringClose(); return true; },
    },
    window: {
      showInfo: async () => undefined, showWarning: async () => "Restore", confirm: async () => true,
      quickPick: async (items: { value: string }[]) => items.find((i) => i.value === pick),
    },
  } as unknown as W3Api;
  const ctx = { subscriptions: [] as { dispose(): void }[] } as unknown as ExtensionContext;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval;
  try { activate(w3, ctx); } finally { globalThis.setInterval = realSetInterval; }
  return {
    log, commands, tools, packGates, disk,
    setList: (g: Gate | null) => { listGate = g; },
    setPick: (name: string) => { pick = name; },
    onClose: (f: () => void) => { duringClose = f; },
    onSync: (f: () => Promise<void>) => { duringSync = f; },
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

const OLDEST = "Map 2020-01-01 10-00-00.w3x", NEWER = "Map 2020-01-02 10-00-00.w3x";
const FOLDER = "C:\\one\\build\\checkpoints";
const syncs = (log: string[]) => log.filter((l) => l.startsWith("sync "));

test("restoring the oldest kept checkpoint: the checkpoint made first doesn't prune it away before it's read", async () => {
  for (const how of ["command", "tool"] as const) {
    const app = fakeApp({ existing: [OLDEST, NEWER], keep: 2 });
    app.setPick(OLDEST);
    if (how === "command") await app.commands.get("w3.checkpoints.restore")!();
    else await app.tools.get("restore_checkpoint")!({ name: OLDEST });
    assert.deepEqual(syncs(app.log), [`sync from ${FOLDER}\\${OLDEST}`], how);
    assert.equal(packs(app.log, "done").length, 1, `${how}: what was there is kept first`);
    app.dispose();
  }
});

test("with keep = 1, restoring a checkpoint that isn't the newest still finds it", async () => {
  const app = fakeApp({ existing: [OLDEST], keep: 1 });
  app.setPick(OLDEST);
  await app.commands.get("w3.checkpoints.restore")!();
  assert.deepEqual(syncs(app.log), [`sync from ${FOLDER}\\${OLDEST}`]);
  app.dispose();
});

test("an automatic checkpoint during a restore doesn't prune the chosen one either", async () => {
  const app = fakeApp({ existing: [OLDEST, NEWER], keep: 2, busy: true });
  app.setPick(OLDEST);
  // While the files are replaced, an automatic checkpoint comes due and is made.
  app.onSync(async () => {
    app.tick();
    // Within the restore's second it waits for the next one.
    for (let i = 0; i < 150 && packs(app.log, "done").length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  });
  await app.commands.get("w3.checkpoints.restore")!();
  assert.equal(packs(app.log, "done").length, 2, "the automatic one was made meanwhile");
  assert.deepEqual(syncs(app.log), [`sync from ${FOLDER}\\${OLDEST}`]);
  assert.ok(app.disk.has(`${FOLDER}\\${OLDEST}`), "still there after the restore");
  app.dispose();
});

test("a project opened while the editors closed for a restore isn't restored into, nor checkpointed", async () => {
  for (const how of ["command", "tool"] as const) {
    const app = fakeApp({ existing: [OLDEST, NEWER], keep: 10 });
    app.setPick(OLDEST);
    app.onClose(() => app.open(project("C:\\two")));
    const run = how === "command" ? app.commands.get("w3.checkpoints.restore")!() : app.tools.get("restore_checkpoint")!({ name: OLDEST });
    await assert.rejects(run, /another project/i, how);
    assert.deepEqual(syncs(app.log), [], `${how}: nothing synced`);
    assert.deepEqual(packs(app.log, "start"), [], `${how}: nothing packed`);
    app.dispose();
  }
});

test("an old checkpoint that can't be deleted doesn't fail the new one; it's said in the output", async () => {
  const app = fakeApp({ existing: [OLDEST, NEWER], keep: 1, failDelete: true });
  await app.commands.get("w3.checkpoints.create")!({ quiet: true });
  assert.equal(packs(app.log, "done").length, 1);
  assert.ok(app.log.some((l) => l.startsWith("out ") && l.includes(OLDEST) && /access denied/.test(l)), app.log.join("\n"));
  app.dispose();
});

test("a timer that fires early can't give two checkpoints the same name", async () => {
  const app = fakeApp();
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => real(fn, 0)) as unknown as typeof setTimeout;
  try {
    const create = app.commands.get("w3.checkpoints.create")!;
    await Promise.all([create({ quiet: true }), create({ quiet: true }), create({ quiet: true })]);
  } finally { globalThis.setTimeout = real; }
  const done = packs(app.log, "done");
  assert.equal(done.length, 3);
  assert.equal(new Set(done).size, 3, done.join("\n"));
  app.dispose();
});
