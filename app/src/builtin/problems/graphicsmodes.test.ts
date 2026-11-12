// The "Graphics modes" check with the map's own versions per mode: Classic reads only a plain import, Reforged the
// `_HD.w3mod\` version first. A model the map holds only for Reforged is invisible in Classic on a map that supports
// Classic (placed objects with it, and the import itself), and a Reforged version on a map without Reforged is never
// shown.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Problem } from "../../extensions/services";
import { builtinChecks } from "./checks";
import { artSetOf, mapModeHas, modesWithout } from "./lookup";

test("the art set of a map file, and which graphics mode reads which of the map's copies", () => {
  assert.equal(artSetOf("_HD.w3mod\\Units\\a.mdx"), "_hd");
  assert.equal(artSetOf("_Locales\\deDE.w3mod\\_de.w3mod\\a.mdx"), "_de");
  assert.equal(artSetOf("_teen.w3mod\\a.blp"), "_teen");
  assert.equal(artSetOf("Units\\_HD.w3mod\\a.mdx"), "");
  assert.equal(artSetOf("a.mdx"), "");
  const plain = new Set([""]), hd = new Set(["_hd"]), de = new Set(["_de"]), teen = new Set(["_teen"]);
  for (const layer of [null, "_hd", "_de"]) assert.ok(mapModeHas(plain, layer), `the plain copy in ${layer}`);
  assert.deepEqual([null, "_hd", "_de"].map((l) => mapModeHas(hd, l)), [false, true, true], "a Reforged version: both Reforged modes");
  assert.deepEqual([null, "_hd", "_de"].map((l) => mapModeHas(de, l)), [false, false, true]);
  assert.deepEqual([null, "_hd", "_de"].map((l) => mapModeHas(teen, l)), [false, false, false]);
  assert.equal(mapModeHas(undefined, null), false);
});

test("the modes without a model: the map's copies by mode, then the game's Classic files, then the mode's folder", () => {
  const modes = [{ name: "Classic", layer: null }, { name: "HD", layer: "_hd" }, { name: "DE", layer: "_de" }];
  const names = (m: { name: string }[]) => m.map((x) => x.name);
  assert.deepEqual(names(modesWithout(modes, (l) => l === "_hd" || l === "_de", () => false)), ["Classic"]);
  assert.deepEqual(names(modesWithout(modes, () => true, () => false)), []);
  assert.deepEqual(names(modesWithout(modes, () => false, (l) => l === null)), [], "the game's Classic file stands in for every mode");
  assert.deepEqual(names(modesWithout(modes, () => false, (l) => l === "_hd")), ["Classic", "DE"]);
});

/** A map project (not a chapter) with these JSON documents and files in its map folder; the game has no files. */
function project(docs: Record<string, unknown>, files: string[]) {
  const text: Record<string, string> = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, JSON.stringify(v)]));
  const none = { dispose() {} };
  const executed: unknown[][] = [];
  const w3 = {
    workspace: {
      project: () => ({ root: "/proj", name: "p", manifest: {}, default_output: "" }),
      files: () => [...Object.keys(text), ...files].map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `/proj/${p}`,
      readText: async (p: string) => { if (p in text) return text[p]; throw new Error(`no ${p}`); },
      readBytes: async (p: string) => { throw new Error(`no ${p}`); },
      onDidChange: () => none,
    },
    backend: { invoke: async (command: string) => { if (command === "fs_exists") return false; throw new Error(`${command}: not in this test`); } },
    game: {
      list: async () => [], read: async (p: string) => { throw new Error(`no ${p}`); }, readText: async (p: string) => { throw new Error(`no ${p}`); },
      resolve: async () => null, resolveMany: async (paths: string[]) => paths.map(() => null),
    },
    settings: { get: () => undefined },
    commands: { register: () => none, execute: async (...args: unknown[]) => { executed.push(args); } },
    window: { showError() {}, showInfo() {} },
  } as unknown as W3Api;
  const check = builtinChecks(w3).find((c) => c.id === "classicModels")!;
  return { run: () => check.run() as Promise<Problem[]>, executed };
}

const HERO = "war3mapImported\\Hero.mdx";
/** A custom footman with an imported model, placed once; `modes`: the map's supported graphics modes. */
const heroMap = (modes: number, imports: { flags: number; path: string }[], files: string[]) => project({
  "map/war3map.w3i.json": { supportedModes: modes },
  "map/war3map.w3u.json": { custom: [{ base: "hfoo", id: "h000", mods: [{ field: "umdl", value: "war3mapImported\\Hero.mdl" }] }] },
  "map/war3mapUnits.doo.json": { units: [{ id: "h000", position: [128, 256, 0] }] },
  "map/war3map.imp.json": { files: imports },
}, files);

test("a placed unit whose model the map holds only for Reforged is invisible in Classic, with Add Classic Version… as a fix", async () => {
  const p = heroMap(3, [{ flags: 13, path: `_HD.w3mod\\${HERO}` }], ["map/_HD.w3mod/war3mapImported/Hero.mdx"]);
  const found = await p.run();
  assert.equal(found.length, 1, JSON.stringify(found.map((f) => f.message)));
  assert.match(found[0].message, /^h000 \(h000\): no model in Classic graphics, invisible there; placed 1×/);
  assert.match(found[0].message, /only the Reforged version, _HD\.w3mod\\war3mapImported\\Hero\.mdx/);
  const fix = found[0].fixes?.find((f) => f.label === "Add Classic Version…");
  assert.ok(fix, `fixes: ${found[0].fixes?.map((f) => f.label)}`);
  await fix.run();
  assert.deepEqual(p.executed, [["w3.imports.addVersion", `_HD.w3mod\\${HERO}`]]);
});

test("control: the same model with its Classic version too, or on a map without Classic, is no problem", async () => {
  const pair = heroMap(3, [{ flags: 21, path: HERO }, { flags: 13, path: `_HD.w3mod\\${HERO}` }], ["map/war3mapImported/Hero.mdx", "map/_HD.w3mod/war3mapImported/Hero.mdx"]);
  assert.deepEqual((await pair.run()).map((f) => f.message), []);
  const reforgedMap = heroMap(2, [{ flags: 13, path: `_HD.w3mod\\${HERO}` }], ["map/_HD.w3mod/war3mapImported/Hero.mdx"]);
  assert.deepEqual((await reforgedMap.run()).map((f) => f.message), []);
  // A plain import alone serves every mode.
  const plain = heroMap(7, [{ flags: 21, path: HERO }], ["map/war3mapImported/Hero.mdx"]);
  assert.deepEqual((await plain.run()).map((f) => f.message), []);
});

test("an unplaced model imported for Reforged only is warned of on a map with Classic; a Reforged version on a Classic-only map too", async () => {
  const files = ["map/_HD.w3mod/war3mapImported/Night.mdx", "map/_HD.w3mod/war3mapImported/Night.dds"];
  const imports = [{ flags: 13, path: "_HD.w3mod\\war3mapImported\\Night.mdx" }, { flags: 13, path: "_HD.w3mod\\war3mapImported\\Night.dds" }];
  const both = project({ "map/war3map.w3i.json": { supportedModes: 3 }, "map/war3map.imp.json": { files: imports } }, files);
  const found = await both.run();
  // The texture alone isn't: the Reforged model it belongs to is what Classic lacks.
  assert.deepEqual(found.map((f) => f.message), ["war3mapImported\\Night.mdx: imported for Reforged only (_HD.w3mod\\war3mapImported\\Night.mdx); Classic graphics have no model there, so what uses it is invisible in Classic"]);
  assert.deepEqual(found[0].fixes?.map((f) => f.label), ["Add Classic Version…"]);
  const classicOnly = project({ "map/war3map.w3i.json": { supportedModes: 1 }, "map/war3map.imp.json": { files: imports } }, files);
  assert.deepEqual((await classicOnly.run()).map((f) => f.message), ["_HD.w3mod\\war3mapImported\\Night.mdx: a Reforged version, but the map supports only Classic graphics: packed, never shown"]);
  // Control: Reforged only on a Reforged map, and a pair, are fine.
  const reforged = project({ "map/war3map.w3i.json": { supportedModes: 2 }, "map/war3map.imp.json": { files: imports } }, files);
  assert.deepEqual((await reforged.run()).map((f) => f.message), []);
  const pair = project({ "map/war3map.w3i.json": { supportedModes: 3 }, "map/war3map.imp.json": { files: [...imports, { flags: 21, path: "war3mapImported\\Night.mdx" }] } },
    [...files, "map/war3mapImported/Night.mdx"]);
  assert.deepEqual((await pair.run()).map((f) => f.message), []);
});
