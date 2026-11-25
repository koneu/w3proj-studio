// A kept vJASS script is never compiled by JassHelper on an open or a save (user decision 2026-11-22): only the
// explicit requests (here build_script) and pack run it. Counted on the language's compile function.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { SCRIPT_LANGUAGES_SERVICE, type ScriptLanguagesService } from "../../extensions/services";
import { activate } from "./index";
import { readFixture } from "../../lib/testhelpers/testutil";

const ROOT = "/maps/Kept";
const KEPT = "//globals from MyLibrary:\nglobals\nendglobals\n";

function project() {
  const files: Record<string, string> = {
    "map/war3map.w3i.json": readFixture("mini-map", "map", "war3map.w3i.json"),
    "map/war3map.j": KEPT,
  };
  const written = new Map<string, string>();
  const commands = new Map<string, (...a: unknown[]) => unknown>();
  const tools = new Map<string, () => Promise<unknown>>();
  const saved: ((path: string) => void)[] = [];
  let service: ScriptLanguagesService | undefined;
  const none = { dispose() {} };
  const notFound = (p: string) => new Error(`${p}: No such file or directory (os error 2)`);
  const read = async (p: string) => {
    if (written.has(p)) return written.get(p)!;
    if (!(p in files)) throw notFound(p);
    return files[p];
  };
  const w3 = {
    output: { channel: () => ({ append() {} }) },
    services: { provide: (id: string, s: unknown) => { if (id === SCRIPT_LANGUAGES_SERVICE) service = s as ScriptLanguagesService; return none; } },
    settings: { get: (key: string) => (key === "script.generateOnSave" ? true : undefined) },
    game: { readText: async () => "", read: async (p: string) => { throw notFound(p); } },
    window: { showInfo: async () => undefined, showWarning: async () => undefined, showError: async () => undefined, notify: async () => undefined },
    editors: { isDirty: () => false, registerProvider: () => none, open: async () => {} },
    commands: {
      register: (id: string, f: (...a: unknown[]) => unknown) => { commands.set(id, f); return none; },
      execute: async (id: string, ...a: unknown[]) => commands.get(id)?.(...a),
    },
    mcp: { registerTool: (name: string, f: () => Promise<unknown>) => { tools.set(name, f); return none; } },
    workspace: {
      project: () => ({ root: ROOT, name: "Kept", manifest: {}, default_output: "" }),
      files: () => Object.keys(files).map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `${ROOT}/${p}`,
      readText: read,
      readBytes: async (p: string) => new TextEncoder().encode(await read(p)),
      writeText: async (p: string, t: string) => { written.set(p, t); },
      writeBytes: async (p: string, b: Uint8Array) => { written.set(p, new TextDecoder().decode(b)); },
      onDidChange: () => none,
      onDidSave: (f: (path: string) => void) => { saved.push(f); return none; },
      readTriggers: async () => null,
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "script_state") return { mode: "kept" };
        if (command === "fs_exists") return (args.path as string) in files;
        if (command === "codec_canonicalize") return args.text;
        if (command === "codec_decode") throw notFound(String(args.path));
        throw new Error(`unexpected ${command}`);
      },
    },
  };
  const ctx: ExtensionContext = { extensionId: "w3.mapScript", extensionPath: null, subscriptions: [] };
  activate(w3 as unknown as W3Api, ctx);
  let compiles = 0;
  service!.register({ id: "vjass", title: "vJASS (JassHelper)", detect: ({ script }) => script.includes("//globals from"), compile: async ({ script }) => { compiles++; return script; } });
  return {
    compiles: () => compiles,
    save: async (path: string) => { for (const f of saved) f(path); await commands.get("w3.script.settle")!(); },
    build: () => tools.get("build_script")!(),
  };
}

test("a save never runs JassHelper for a kept vJASS script; build_script does", async () => {
  const p = project();
  await p.save("map/war3mapUnits.doo.json");
  await p.save("map/war3map.w3i.json");
  assert.equal(p.compiles(), 0);
  await p.build().catch(() => {});
  assert.equal(p.compiles(), 1, "control: an explicit request compiles");
});
