// A sync from a map through the extension's own command, on a made-up app: the tabs, the file list and the script it
// touches after the backend unpacks are the open project's, so none of that happens once another project is open.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { activate } from "./index";

const ONE = "/home/u/maps/One";
const TWO = "/home/u/maps/Two";
const MAP = "/home/u/maps/One/build/One.edit.w3x";

/** `during`: what happens while the backend unpacks (or the deletion question waits, with `wouldDelete`). */
function fakeApp(opts: { during?: (switchTo: (root: string) => void) => void; wouldDelete?: boolean; strays?: string[] } = {}) {
  let current: { root: string; name: string; default_output: string } | null = { root: ONE, name: "One", default_output: `${ONE}/One.w3x` };
  const switchTo = (root: string) => { current = { root, name: root, default_output: `${root}/x.w3x` }; };
  const log: string[] = [];
  const commands = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const listeners = new Map<string, (e: unknown) => unknown>();
  const none = { dispose() {} };
  let asked = false;
  const w3 = {
    output: { channel: () => ({ append: (s: string) => log.push(`out ${s}`), show: () => {}, clear: () => {} }) },
    statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
    workspace: {
      project: () => current,
      files: () => [],
      onDidChange: () => none,
      refresh: async () => { log.push(`refresh ${current?.root}`); },
      open: async () => {},
      close: () => {},
    },
    settings: { get: (_k: string, d?: unknown) => d },
    backend: {
      invoke: async (cmd: string, a: { dir?: string; refuseDeletes?: boolean }) => {
        if (cmd === "project_strays") return [];
        if (cmd === "project_unpack") {
          log.push(`unpack into ${a.dir}`);
          if (opts.wouldDelete && a.refuseDeletes) throw "WOULD_DELETE: [\"map/gone.txt\"]";
          if (!opts.wouldDelete) opts.during?.(switchTo);
          return { files: [], unnamed: [], errors: [], written: 3, deleted: 1, unchanged: 0, strays: opts.strays };
        }
        throw new Error(cmd);
      },
      listen: async (name: string, fn: (e: unknown) => unknown) => { listeners.set(name, fn); return none; },
    },
    commands: {
      execute: async (id: string) => { log.push(`command ${id} on ${current?.root}`); },
      register: (id: string, fn: (...a: unknown[]) => Promise<unknown>) => { commands.set(id, fn); return none; },
    },
    editors: {
      closeAll: async () => { log.push(`closeAll on ${current?.root}`); },
      restore: async () => { log.push(`restore on ${current?.root}`); },
    },
    window: {
      withProgress: (_t: string, fn: () => Promise<unknown>) => fn(),
      showInfo: async (m: string) => { log.push(`info ${m}`); return m.startsWith("The World Editor saved") ? "Sync" : undefined; },
      showWarning: async (m: string, ...actions: string[]) => {
        log.push(`warn ${m}`);
        asked = true;
        opts.during?.(switchTo);
        return actions[0];
      },
      showError: async (m: string) => { log.push(`error ${m}`); },
    },
  } as unknown as W3Api;
  const ctx = { subscriptions: [] as { dispose(): void }[] } as unknown as ExtensionContext;
  activate(w3, ctx);
  const sync = (file = MAP) => commands.get("w3.project.syncFromMap")!(file);
  return { log, sync, switchTo, listeners, asked: () => asked };
}

/** What the sync did to the app (not what it said). */
const acts = (log: string[]) => log.filter((l) => /^(closeAll|refresh|restore|command w3\.script|info Project)/.test(l));

test("a sync into the open project closes, refreshes and restores its tabs and adopts its script", async () => {
  const app = fakeApp();
  await app.sync();
  assert.deepEqual(acts(app.log), [`closeAll on ${ONE}`, `refresh ${ONE}`, `restore on ${ONE}`, `command w3.script.adopt on ${ONE}`, "info Project synced: 3 files updated, 1 removed."]);
});

test("a project opened while the backend unpacks keeps its tabs, file list and script", async () => {
  const app = fakeApp({ during: (to) => to(TWO) });
  await app.sync();
  assert.deepEqual(app.log.filter((l) => l.startsWith("unpack")), [`unpack into ${ONE}`], "the map went into its own project");
  assert.deepEqual(acts(app.log), [], app.log.join(" | "));
  assert.ok(app.log.some((l) => l.startsWith("out the sync from") && l.includes(`for ${ONE}, which is no longer the open project`)), app.log.join(" | "));
});

test("a project opened while the deletion question waits gets nothing written into the old one", async () => {
  const app = fakeApp({ wouldDelete: true, during: (to) => to(TWO) });
  await app.sync();
  assert.ok(app.asked(), "the question was asked");
  assert.deepEqual(app.log.filter((l) => l.startsWith("unpack")), [`unpack into ${ONE}`], "only the asking unpack ran");
  assert.deepEqual(acts(app.log), []);
});

test("a World Editor save of a project switched away from during its question isn't synced into the new one", async () => {
  const app = fakeApp();
  await new Promise((r) => setTimeout(r, 0)); // the listener is registered
  const listener = app.listeners.get("w3://map-saved")!;
  // Control: answered with the project still open, the save is synced into it.
  await listener({ map: MAP, root: ONE });
  assert.deepEqual(app.log.filter((l) => l.startsWith("unpack")), [`unpack into ${ONE}`], app.log.join(" | "));
  app.log.length = 0;
  // The question about syncing it answered after another project opened.
  const saved = listener({ map: MAP, root: ONE });
  app.switchTo(TWO);
  await saved;
  assert.deepEqual(app.log.filter((l) => l.startsWith("unpack")), [], app.log.join(" | "));
  assert.deepEqual(acts(app.log), []);
});
