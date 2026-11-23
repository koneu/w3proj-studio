// A map that has no script (var-code.w3x: made without one, its triggers raw or in map/triggers/) gets one in its
// pack, and Regenerate Map Script… makes one for it: the pack used to hold no war3map.j at all (verify 2026-11-22,
// vc-vardode). A script that is there but can't be read is not "no script": nothing is written over it.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { activate } from "./index";
import { readFixture } from "../../lib/testhelpers/testutil";

const ROOT = "/maps/NoScript";

function project(mode: "kept" | null, extra: Record<string, string | Error> = {}) {
  const files: Record<string, string | Error> = { "map/war3map.w3i.json": readFixture("mini-map", "map", "war3map.w3i.json"), ...extra };
  const written = new Map<string, string>();
  const commands = new Map<string, (...a: unknown[]) => unknown>();
  const warnings: string[] = [];
  const none = { dispose() {} };
  const notFound = (p: string) => new Error(`${p}: No such file or directory (os error 2)`);
  const read = async (p: string) => {
    if (written.has(p)) return written.get(p)!;
    const f = files[p];
    if (f === undefined) throw notFound(p);
    if (f instanceof Error) throw f;
    return f;
  };
  const w3 = {
    output: { channel: () => ({ append() {} }) },
    services: { provide: () => none },
    // Off: the pack makes a missing script whatever the saves do.
    settings: { get: () => undefined },
    game: { readText: async () => "", read: async (p: string) => { throw notFound(p); } },
    // Never answered: a question would leave the command waiting (as the we-compare eval left it).
    window: { showInfo: async () => undefined, showWarning: (m: string) => { warnings.push(m); return new Promise(() => {}); }, showError: async () => undefined, notify: async () => undefined },
    editors: { isDirty: () => false, registerProvider: () => none, open: async () => {} },
    commands: {
      register: (id: string, f: (...a: unknown[]) => unknown) => { commands.set(id, f); return none; },
      execute: async (id: string, ...a: unknown[]) => commands.get(id)?.(...a),
    },
    mcp: { registerTool: () => none },
    workspace: {
      project: () => ({ root: ROOT, name: "NoScript", manifest: {}, default_output: "" }),
      files: () => Object.keys(files).map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `${ROOT}/${p}`,
      readText: read,
      readBytes: async (p: string) => new TextEncoder().encode(await read(p)),
      writeText: async (p: string, t: string) => { written.set(p, t); },
      onDidChange: () => none,
      onDidSave: () => none,
      readTriggers: async () => null,
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "script_state") return { mode };
        if (command === "fs_exists") return (args.path as string) in files;
        if (command === "codec_canonicalize") return args.text;
        if (command === "codec_decode") throw notFound(String(args.path));
        throw new Error(`unexpected ${command}`);
      },
    },
  };
  const ctx: ExtensionContext = { extensionId: "w3.mapScript", extensionPath: null, subscriptions: [] };
  activate(w3 as unknown as W3Api, ctx);
  const run = (id: string, ...a: unknown[]) => Promise.race([
    Promise.resolve(commands.get(id)!(...a)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${id} is still waiting (a question nobody answers?)`)), 5000)),
  ]);
  return { written, warnings, run };
}

for (const mode of ["kept", null] as const) {
  test(`packing a map without a script (triggers ${mode === "kept" ? "in map/triggers/" : "raw"}) writes war3map.j`, async () => {
    const p = project(mode);
    await p.run("w3.script.forPack");
    assert.match(p.written.get("map/war3map.j") ?? "", /function main takes nothing returns nothing/);
  });
}

test("packing writes nothing over a script that is there, readable or not", async () => {
  const kept = project("kept", { "map/war3map.j": "// someone's own\n" });
  await kept.run("w3.script.forPack");
  assert.equal(kept.written.has("map/war3map.j"), false);
  const unreadable = project("kept", { "map/war3map.j": new Error("map/war3map.j: Permission denied (os error 13)") });
  await unreadable.run("w3.script.forPack");
  assert.equal(unreadable.written.has("map/war3map.j"), false);
  const lua = project(null, { "map/war3map.lua": "-- a Lua script\n" });
  await lua.run("w3.script.forPack");
  assert.equal(lua.written.size, 0, "a Lua script is the map's script too");
});

test("Regenerate Map Script… on a map without a script and raw triggers writes war3map.j", async () => {
  const p = project(null);
  const r = await p.run("w3.script.regenerate") as { written: boolean } | null;
  assert.equal(r?.written, true);
  assert.match(p.written.get("map/war3map.j") ?? "", /function main takes nothing returns nothing/);
});

test("Regenerate Map Script… with raw triggers still refuses over a script that is there", async () => {
  const p = project(null, { "map/war3map.j": "// someone's own\n" });
  await assert.rejects(p.run("w3.script.regenerate"), /aren't in map\/triggers\//);
  assert.equal(p.written.has("map/war3map.j"), false);
});
