// The fixes of a placed type's missing model, per graphics mode, on a made-up game whose doodad skin table splits the
// model per art set as the real one does: the Exterior Wall EW00 names RuinsWall0\RuinsWall0 for Classic (no folder
// has it) and RuinTomb\…\ExteriorWall for HD and DE (both Reforged sets have it). Convert is offered from the set
// that holds the model the type reads in that set's art; "Replace with a Reforged game model…" wherever no mode that
// has a model would lose it. A type's own model found nowhere ("Files used by object data") gets both Replace fixes.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Problem } from "../../extensions/services";
import { builtinChecks, offersReforgedReplace, reforgedChoices } from "./checks";
import { conversionPlans, variationFiles } from "./reforged";

/** SLK text of a table: the first row is the header. */
function slk(rows: string[][]) {
  const out = ["ID;PWXL;N;E"];
  rows.forEach((row, y) => row.forEach((v, x) => { if (v !== "") out.push(`C;X${x + 1};Y${y + 1};K${/^-?\d+(\.\d+)?$/.test(v) ? v : `"${v}"`}`); }));
  return [...out, "E"].join("\r\n");
}
const META = ["ID", "field", "slk", "index", "repeat", "data", "category", "displayName", "sort", "type"];

const WALL_HD = "Doodads/RuinTomb/Structures/ExteriorWall/ExteriorWall.mdx";
/** The game's text files (by game path with "/"), and the model files stored per folder. */
const TEXT: Record<string, string> = {
  "Doodads/DoodadMetaData.slk": slk([META,
    ["dfil", "file", "Profile", "-1", "0", "0", "art", "", "1", "model"],
    ["dvar", "numVar", "Profile", "-1", "0", "0", "art", "", "2", "int"],
  ]),
  "Doodads/Doodads.slk": slk([["doodID", "comment"], ["EW00", "Exterior Wall"], ["HDGO", "HD Gone"], ["DEGO", "DE Gone"], ["LRef", "Reforged Only"]]),
  "Doodads/DoodadSkins.txt": [
    // Classic's model is in no folder; the HD and DE art is in both Reforged sets.
    "[EW00]", "numVar=1", "file=Doodads\\Ruins\\Terrain\\RuinsWall0\\RuinsWall0", "file:hd=Doodads\\RuinTomb\\Structures\\ExteriorWall\\ExteriorWall",
    // Classic's model is there; the HD one (which DE reads too: no file:de) is in no folder.
    "[HDGO]", "numVar=1", "file=Doodads\\Plain\\Rock", "file:hd=Doodads\\Gone\\HdRock",
    // Only the DE art names a model no folder has.
    "[DEGO]", "numVar=1", "file=Doodads\\Plain\\Rock", "file:de=Doodads\\Gone\\DeRock",
    // One path for every mode, stored only in the Reforged sets (two variations).
    "[LRef]", "numVar=2", "file=Doodads\\Reforged\\Bridge",
  ].join("\n"),
};
const LIST = [
  ...Object.keys(TEXT).map((p) => `War3.w3mod:${p}`),
  `War3.w3mod:_HD.w3mod:${WALL_HD}`, `War3.w3mod:_DE.w3mod:${WALL_HD}`,
  "War3.w3mod:Doodads/Plain/Rock.mdx",
  "War3.w3mod:_HD.w3mod:Doodads/Reforged/Bridge0.mdx", "War3.w3mod:_HD.w3mod:Doodads/Reforged/Bridge1.mdx",
  "War3.w3mod:_DE.w3mod:Doodads/Reforged/Bridge0.mdx", "War3.w3mod:_DE.w3mod:Doodads/Reforged/Bridge1.mdx",
  "War3.w3mod:_HD.w3mod:Units/Other/HdOnly.mdx",
];
const gamePath = (p: string) => p.replace(/^War3\.w3mod:/i, "").replace(/\\/g, "/");

/** A map project placing each of `ids` once, supporting the graphics modes `modes`; `w3d`: its doodad object data. */
function project(modes: number, ids: string[], w3d?: unknown) {
  const docs: Record<string, unknown> = {
    "map/war3map.w3i.json": { supportedModes: modes },
    "map/war3map.doo.json": { doodads: ids.map((id, i) => ({ id, variation: 0, position: [i * 128, 0, 0] })) },
    ...(w3d ? { "map/war3map.w3d.json": w3d } : {}),
  };
  const text: Record<string, string> = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, JSON.stringify(v)]));
  const none = { dispose() {} };
  const w3 = {
    workspace: {
      project: () => ({ root: "/proj", name: "p", manifest: {}, default_output: "" }),
      files: () => Object.keys(text).map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `/proj/${p}`,
      readText: async (p: string) => { if (p in text) return text[p]; throw new Error(`no ${p}`); },
      readBytes: async (p: string) => { throw new Error(`no ${p}`); },
      onDidChange: () => none,
    },
    backend: { invoke: async (command: string) => { if (command === "fs_exists") return false; throw new Error(`${command}: not in this test`); } },
    game: {
      list: async () => LIST,
      read: async (p: string) => { throw new Error(`no ${p}`); },
      readText: async (p: string) => { const t = TEXT[gamePath(p)]; if (t === undefined) throw new Error(`not found: ${p}`); return t; },
      resolve: async (p: string) => (LIST.some((f) => gamePath(f).toLowerCase() === gamePath(p).toLowerCase()) ? p : null),
      resolveMany: async (paths: string[]) => paths.map((p) => (LIST.some((f) => gamePath(f).toLowerCase() === gamePath(p).toLowerCase()) ? p : null)),
    },
    settings: { get: () => undefined },
    commands: { register: () => none, execute: async () => {} },
    window: { showError() {}, showInfo() {} },
  } as unknown as W3Api;
  const checks = builtinChecks(w3);
  const run = (id: string) => checks.find((c) => c.id === id)!.run() as Promise<Problem[]>;
  return { graphics: () => run("classicModels"), objectPaths: () => run("objectPaths") };
}

const labels = (p: Problem | undefined) => p?.fixes?.map((f) => f.label) ?? [];

test("Classic only lacks the model, the Reforged sets hold the type's own HD art: Convert from either, and both Replace fixes", async () => {
  const [p, ...rest] = await project(3, ["EW00", "EW00"]).graphics();
  assert.equal(rest.length, 0, JSON.stringify(rest.map((r) => r.message)));
  assert.match(p.message, /^Exterior Wall \(EW00\): no model in Classic graphics, invisible there; placed 2×/);
  assert.match(p.message, /Classic can be made from the DE model Doodads\\RuinTomb\\Structures\\ExteriorWall\\ExteriorWall\.mdx \(or the HD one\)/);
  assert.deepEqual(labels(p), ["Convert from DE to a Classic model", "Convert from HD to a Classic model", "Replace with a Classic game model…", "Replace with a Reforged game model…", "Remove the 2 placed"]);
  // Classic stays without a model after a Reforged one: the title says so.
  assert.match(p.fixes!.find((f) => f.label.startsWith("Replace with a Reforged"))!.title!, /Classic graphics can't load a Reforged model/);
  // On a Classic-only map there's no Reforged mode to pick for.
  assert.deepEqual(labels((await project(1, ["EW00"]).graphics())[0]), ["Convert from DE to a Classic model", "Convert from HD to a Classic model", "Replace with a Classic game model…", "Remove the 1 placed"]);
});

test("HD lacks the model, Classic has it: no conversion, no Reforged replacement (Classic would lose its model)", async () => {
  const [p] = await project(3, ["HDGO"]).graphics();
  assert.match(p.message, /^HD Gone \(HDGO\): no model in Reforged \(HD\) graphics/);
  assert.deepEqual(labels(p), ["Replace with a Classic game model…", "Remove the 1 placed"]);
  // Without Classic, the Reforged replacement is offered: no mode loses a model.
  const [q] = await project(2, ["HDGO"]).graphics();
  assert.deepEqual(labels(q), ["Replace with a Classic game model…", "Replace with a Reforged game model…", "Remove the 1 placed"]);
});

test("DE (3.0) alone lacks the model: the Reforged replacement only without Classic", async () => {
  const [p] = await project(5, ["DEGO"]).graphics();
  assert.match(p.message, /^DE Gone \(DEGO\): no model in Reforged \(DE\) graphics/);
  assert.deepEqual(labels(p), ["Replace with a Classic game model…", "Remove the 1 placed"]);
  const [q] = await project(4, ["DEGO"]).graphics();
  assert.deepEqual(labels(q), ["Replace with a Classic game model…", "Replace with a Reforged game model…", "Remove the 1 placed"]);
});

test("a model the Reforged sets hold at the type's one path: Convert and Import as before", async () => {
  const [p] = await project(3, ["LRef"]).graphics();
  assert.deepEqual(labels(p), ["Convert from DE to a Classic model", "Convert from HD to a Classic model", "Replace with a Classic game model…", "Replace with a Reforged game model…", "Remove the 1 placed"]);
  // Control: a map with HD only finds it, nothing to report.
  assert.deepEqual((await project(2, ["LRef"]).graphics()).map((x) => x.message), []);
});

test("a model in no folder at all: no conversion; both Replace fixes, in Graphics modes and in Files used by object data", async () => {
  const w3d = { original: [{ base: "LRef", mods: [{ field: "dfil", value: "war3mapImported\\Lost.mdl" }, { field: "dvar", value: 1 }] }] };
  const p = project(7, ["LRef"], w3d);
  const [g] = await p.graphics();
  assert.match(g.message, /no model in Classic, Reforged \(HD\), Reforged \(DE\) graphics/);
  assert.deepEqual(labels(g), ["Replace with a Classic game model…", "Replace with a Reforged game model…", "Remove the 1 placed"]);
  const missing = (await p.objectPaths()).filter((x) => /Lost/.test(x.message));
  assert.equal(missing.length, 1, JSON.stringify(missing.map((x) => x.message)));
  assert.deepEqual(labels(missing[0]), ["Replace with a Classic game model…", "Replace with a Reforged game model…"]);
  // Classic-only: just the Classic one.
  const classic = (await project(1, ["LRef"], w3d).objectPaths()).filter((x) => /Lost/.test(x.message));
  assert.deepEqual(labels(classic[0]), ["Replace with a Classic game model…"]);
});

test("conversionPlans: the set's own art first, then the missing model; split over both sets → DE", () => {
  const has = new Set(["hd:a/x.mdx", "de:a/x.mdx", "hd:b/y0.mdx", "hd:b/y1.mdx", "de:c/z0.mdx", "hd:c/z1.mdx"]);
  const f = (s: string, k: string) => has.has(`${s}:${k}`);
  const x = { model: "A\\X", variations: 1 }, y = { model: "B\\Y.mdl", variations: 2 }, z = { model: "C\\Z", variations: 2 }, gone = { model: "Q", variations: 1 };
  assert.deepEqual(conversionPlans({ de: [gone, x], hd: [x] }, f), [{ source: "de", ...x }, { source: "hd", ...x }]);
  assert.deepEqual(conversionPlans({ de: [y], hd: [y] }, f), [{ source: "hd", ...y }]);
  assert.deepEqual(conversionPlans({ de: [z], hd: [z] }, f), [{ source: "de", ...z }]);
  assert.deepEqual(conversionPlans({ de: [gone], hd: [gone] }, f), []);
  assert.deepEqual(variationFiles(y), ["B\\Y0.mdx", "B\\Y1.mdx"]);
});

test("reforgedChoices: models every supported Reforged mode loads, per set; offersReforgedReplace", () => {
  const stored = new Map<string | null, Set<string>>([[null, new Set(["c.mdx"])], ["_hd", new Set(["h.mdx", "both.mdx"])], ["_de", new Set(["both.mdx", "d.mdx"])]]);
  const sets = { hd: new Set(["h.mdx", "both.mdx"]), de: new Set(["both.mdx", "d.mdx"]) };
  const HD = { layer: "_hd" }, DE = { layer: "_de" }, SD = { layer: null };
  assert.deepEqual(reforgedChoices([SD, HD], stored, sets), [{ source: "hd", models: ["h.mdx", "both.mdx"] }]);
  assert.deepEqual(reforgedChoices([HD, DE], stored, sets), [{ source: "hd", models: ["both.mdx"] }, { source: "de", models: ["both.mdx"] }]);
  assert.deepEqual(reforgedChoices([SD], stored, sets), []);
  assert.equal(offersReforgedReplace([SD, HD], true), true);
  assert.equal(offersReforgedReplace([SD, HD], false), false);
  assert.equal(offersReforgedReplace([HD], false), true);
  assert.equal(offersReforgedReplace([SD], true), false);
});
