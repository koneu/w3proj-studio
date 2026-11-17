// The "Locale string tables not in the import list" check: the World Editor drops a _Locales/x.w3mod/war3map.wts that
// war3map.imp doesn't list when it saves the map, so one the list doesn't name is a warning with a list-it fix.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { builtinChecks } from "./checks";

const imp = (...paths: string[]) => JSON.stringify({ format: "w3proj.imports/1", version: 1, files: paths.map((path) => ({ flags: 21, path })) });

function fake(extra: Record<string, string>) {
  const files = new Map<string, string>(Object.entries({ "map/war3map.w3i.json": "{}", ...extra }));
  const log: string[] = [];
  const w3 = {
    workspace: {
      project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }),
      files: () => [...files.keys()].sort().map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `/p/${p}`,
      readText: async (p: string) => { const t = files.get(p); if (t === undefined) throw new Error(`no ${p}`); return t; },
      readBytes: async (p: string) => { const t = files.get(p); if (t === undefined) throw new Error(`no ${p}`); return new TextEncoder().encode(t); },
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "fs_exists") return files.has(String(args.path).slice(3));
        throw new Error(`${command}: not in this test`);
      },
    },
    settings: { get: () => undefined },
    commands: { execute: async (id: string, ...args: unknown[]) => { log.push(`${id} ${JSON.stringify(args)}`); } },
  } as unknown as W3Api;
  const check = builtinChecks(w3).find((c) => c.id === "unlistedLocaleTexts")!;
  return { log, run: () => check.run() };
}

test("a locale string table the import list doesn't name is a warning with an add fix", async () => {
  const f = fake({ "map/war3map.imp.json": imp("war3mapImported\\a.blp"), "map/_Locales/deDE.w3mod/war3map.wts": "" });
  const found = await f.run();
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.match(found[0].message, /^_Locales\\deDE\.w3mod\\war3map\.wts isn't in the import list: the World Editor drops it/);
  await found[0].fixes![0].run();
  assert.deepEqual(f.log, ['w3.imports.add [["_Locales\\\\deDE.w3mod\\\\war3map.wts"]]']);
});

test("a listed table (in any case) gives no warning", async () => {
  const f = fake({ "map/war3map.imp.json": imp("_locales\\DEDE.w3mod\\war3map.wts"), "map/_Locales/deDE.w3mod/war3map.wts": "" });
  assert.deepEqual(await f.run(), []);
});

test("no _Locales folder gives no warning", async () => {
  assert.deepEqual(await fake({ "map/war3map.imp.json": imp() }).run(), []);
});

test("an import list that can't be read fails the check", async () => {
  const f = fake({ "map/war3map.imp.json": "{nope", "map/_Locales/deDE.w3mod/war3map.wts": "" });
  await assert.rejects(f.run(), /war3map\.imp\.json is there but can't be read/);
});

test("a table stored as one escaped file name is found, unlisted: warning and fix name the backslash path", async () => {
  const f = fake({ "map/war3map.imp.json": imp("war3mapImported\\a.blp"), "map/_Locales%2FdeDE.w3mod%2Fwar3map.wts": "" });
  const found = await f.run();
  assert.equal(found.length, 1);
  assert.match(found[0].message, /^_Locales\\deDE\.w3mod\\war3map\.wts isn't in the import list/);
  await found[0].fixes![0].run();
  assert.deepEqual(f.log, ['w3.imports.add [["_Locales\\\\deDE.w3mod\\\\war3map.wts"]]']);
});

test("a table stored as one escaped file name and listed gives no warning", async () => {
  const f = fake({ "map/war3map.imp.json": imp("_Locales\\deDE.w3mod\\war3map.wts"), "map/_Locales%2FdeDE.w3mod%2Fwar3map.wts": "" });
  assert.deepEqual(await f.run(), []);
});
