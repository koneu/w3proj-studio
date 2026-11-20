// The "Imports stored under another extension" check: (12)WormWar lists war3mapPreview.tga and its sounds as .flac and
// holds a .dds and .ogg files; the World Editor's save drops them (we-compare corpus-saves-wormwar), Studio packs them.
// Each such entry is a warning; what Studio packs doesn't change (the pack says the same: crates/w3proj
// tests/pack_warnings.rs).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { builtinChecks } from "./checks";
import { otherExtensionImports } from "../../lib/imports";

const imp = (...entries: [number, string][]) => JSON.stringify({ format: "w3proj.imports/1", version: 1, files: entries.map(([flags, path]) => ({ flags, path })) });

function fake(extra: Record<string, string>) {
  const files = new Map<string, string>(Object.entries({ "map/war3map.w3i.json": "{}", ...extra }));
  const w3 = {
    workspace: {
      project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }),
      files: () => [...files.keys()].sort().map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `/p/${p}`,
      readText: async (p: string) => { const t = files.get(p); if (t === undefined) throw new Error(`no ${p}`); if (t === "\u0000") throw new Error(`can't read ${p}`); return t; },
      readBytes: async (p: string) => { const t = files.get(p); if (t === undefined) throw new Error(`no ${p}`); return new TextEncoder().encode(t); },
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "fs_exists") return files.has(String(args.path).slice(3));
        if (command === "codec_decode") throw new Error(`no ${String(args.path)}`);
        throw new Error(`${command}: not in this test`);
      },
    },
    settings: { get: () => undefined },
  } as unknown as W3Api;
  const check = builtinChecks(w3).find((c) => c.id === "otherExtensionImports")!;
  return { run: () => check.run() };
}

const WORMWAR = {
  "map/war3mapImported/Song.ogg": "",
  "map/war3mapPreview.dds": "",
  "map/war3mapImported/Fine.mdx": "",
  "map/war3mapImported/Tune.wav": "",
  "map/war3mapMap.blp": "",
};

test("an entry whose file is stored under another extension is a warning, one per entry", async () => {
  const found = await fake({
    ...WORMWAR,
    "map/war3map.imp.json": imp([13, "war3mapImported\\Fine.mdx"], [13, "war3mapImported\\Song.flac"], [29, "war3mapPreview.tga"], [8, "Tune.mp3"]),
  }).run();
  assert.deepEqual(found.map((p) => p.message), [
    "war3mapImported\\Song.flac is listed, but the map holds it as war3mapImported\\Song.ogg: Studio packs the file, the World Editor's save drops it without a warning",
    "war3mapPreview.tga is listed, but the map holds it as war3mapPreview.dds: Studio packs the file, the World Editor's save drops it without a warning",
    "Tune.mp3 is listed, but the map holds it as war3mapImported\\Tune.wav: Studio packs the file, the World Editor's save drops it without a warning",
  ]);
  assert.ok(found.every((p) => p.severity === "warning" && p.location === "war3map.imp" && !p.fixes));
});

// Blizzard's own maps list .mdl models held as .mdx and war3mapMap.blp as war3mapmap.tga (ForgottenHollow,
// SilverpineSprint, Dalaran): not the swaps the editor's save was seen to drop, so no warning.
test("the control: files under their own names (any case, a / path, the standard path's folder), none at all, no list, unmeasured swaps", async () => {
  const found = await fake({
    ...WORMWAR,
    "map/war3map.imp.json": imp([13, "war3mapimported\\song.OGG"], [13, "war3mapImported/Fine.mdx"], [8, "Tune.wav"], [13, "war3mapImported\\Gone.mdx"], [13, ""],
      [13, "war3mapImported\\Fine.mdl"], [29, "war3mapmap.tga"], [13, "war3mapImported\\Song.mdx"]),
  }).run();
  assert.deepEqual(found, []);
  assert.deepEqual(await fake(WORMWAR).run(), []);
});

test("a list that is there but can't be read fails the check", async () => {
  await assert.rejects(fake({ ...WORMWAR, "map/war3map.imp.json": "{ not json" }).run());
});

test("otherExtensionImports: names without an extension and files outside map/ aren't matched", () => {
  assert.deepEqual(otherExtensionImports(["map/war3mapImported/Song.ogg", "maps/x/map/a.blp"], [{ flags: 13, path: "war3mapImported\\Song" }, { flags: 13, path: "a.tga" }], "war3mapImported"), []);
  assert.deepEqual(otherExtensionImports(["map/war3mapImported/Song.ogg"], [{ flags: 13, path: "war3mapImported\\Song.flac" }], "war3mapImported"),
    [{ entry: "war3mapImported\\Song.flac", file: "map/war3mapImported/Song.ogg" }]);
});
