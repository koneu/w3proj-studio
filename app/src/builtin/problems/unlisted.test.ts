// The "Files not in the import list" check: files of the map folder that the import list doesn't name are reported,
// with the game file they replace and the object data that uses them, and their fixes go through the Import Manager's
// command or delete the file after a question and a checkpoint. A list that can't be read fails the check instead of
// passing every file for unlisted.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Problem } from "../../extensions/services";
import { builtinChecks } from "./checks";

/** SLK text of a table: the first row is the header. */
function slk(rows: string[][]) {
  const out = ["ID;PWXL;N;E"];
  rows.forEach((row, y) => row.forEach((v, x) => { if (v !== "") out.push(`C;X${x + 1};Y${y + 1};K"${v}"`); }));
  return [...out, "E"].join("\r\n");
}

/** A made-up game: unit metadata with a model field, and the stored files below. */
const GAME: Record<string, string> = {
  "Units\\UnitMetaData.slk": slk([["ID", "field", "slk", "category", "displayName", "sort", "type", "useUnit"], ["umdl", "file", "Profile", "art", "Model File", "1", "model", "1"]]),
  "Units\\UnitData.slk": slk([["unitID"], ["hfoo"]]),
  "Units\\UnitBalance.slk": slk([["unitBalanceID"]]),
  "Units\\UnitUI.slk": slk([["unitUIID"]]),
  "Units\\UnitWeapons.slk": slk([["unitWeaponID"]]),
  "Units\\UnitAbilities.slk": slk([["unitAbilID"]]),
};
const STORED = new Set(["buildings\\human\\townhall\\townhall.mdx"]);

const IMP = JSON.stringify({ format: "w3proj.imports/1", version: 1, files: [{ flags: 21, path: "war3mapImported\\Listed.blp" }, { flags: 5, path: "Short.blp" }] });

/** The map: its own files, two listed imports (one as a "standard path" entry), a model the object data names in
 *  another case than it is stored, a game model replaced, and its HD version. */
const FILES: Record<string, string> = {
  "map/war3map.w3i.json": "{}",
  "map/war3mapMap.blp": "",
  "map/war3mapSkin.w3u.json": JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: [] }),
  "map/war3map.w3u.json": JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: [{ base: "hfoo", id: "h000", mods: [{ field: "umdl", value: "war3mapImported\\Hero.mdl" }] }] }),
  "map/war3mapImported/listed.blp": "",
  "map/war3mapImported/Short.blp": "",
  "map/war3mapimported/hero.mdx": "",
  "map/Buildings/Human/TownHall/TownHall.mdx": "",
  "map/_HD.w3mod/Buildings/Human/TownHall/TownHall.mdx": "",
};

function fake(opts: { imp?: string | null; ask?: boolean } = {}) {
  const files = new Map(Object.entries(FILES));
  if (opts.imp !== null) files.set("map/war3map.imp.json", opts.imp ?? IMP);
  const log: string[] = [], shown: string[] = [];
  const w3 = {
    output: { channel: () => ({ append: (l: string) => shown.push(l), clear() {}, show() {} }) },
    workspace: {
      project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }),
      files: () => [...files.keys()].sort().map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `/p/${p}`,
      readText: async (p: string) => { const t = files.get(p); if (t === undefined) throw new Error(`no ${p}`); return t; },
      readBytes: async (p: string) => { const t = files.get(p); if (t === undefined) throw new Error(`no ${p}`); return new TextEncoder().encode(t); },
      delete: async (p: string) => { log.push(`delete ${p}`); files.delete(p); },
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "fs_exists") return files.has(String(args.path).slice(3));
        throw new Error(`${command}: not in this test`);
      },
    },
    game: {
      list: async () => [],
      read: async (p: string) => { if (!(p in GAME)) throw new Error(`no ${p}`); return new TextEncoder().encode(GAME[p]); },
      readText: async (p: string) => { if (!(p in GAME)) throw new Error(`no ${p}`); return GAME[p]; },
      resolve: async (p: string) => (STORED.has(p.toLowerCase()) ? `War3.w3mod:${p}` : null),
      resolveMany: async (paths: string[]) => paths.map((p) => (STORED.has(p.toLowerCase()) ? `War3.w3mod:${p}` : null)),
    },
    settings: { get: () => undefined },
    editors: { unsavedPaths: () => [], close: async (p: string) => { log.push(`close ${p}`); } },
    commands: { execute: async (id: string, ...args: unknown[]) => { log.push(`${id} ${JSON.stringify(args)}`); } },
    window: { askDelete: async (m: string) => { log.push(`ask ${m}`); return opts.ask ?? true; }, showWarning: async () => undefined, showInfo: async () => undefined },
  } as unknown as W3Api;
  const check = builtinChecks(w3).find((c) => c.id === "unlistedImports")!;
  return { w3, files, log, shown, run: () => check.run() };
}

const byFile = (found: Problem[], archive: string) => found.find((p) => p.message.startsWith(`${archive} `));

test("files the import list doesn't name are reported, with the game file they replace and what uses them", async () => {
  const found = await fake().run();
  // Not the map's own files, nor what the list names (in any case, or inside the import folder).
  assert.deepEqual(found.map((p) => p.message.split(" ")[0]).sort(),
    ["Buildings\\Human\\TownHall\\TownHall.mdx", "_HD.w3mod\\Buildings\\Human\\TownHall\\TownHall.mdx", "war3mapimported\\hero.mdx"]);
  for (const p of found) {
    assert.equal(p.severity, "warning");
    assert.match(p.message, /isn't in the import list, but is packed into the map anyway/);
    assert.deepEqual(p.fixes?.map((f) => f.label), ["Add to import list", "Delete file"]);
    assert.deepEqual(p.reveal, { command: "w3.imports.open" });
  }
  assert.match(byFile(found, "Buildings\\Human\\TownHall\\TownHall.mdx")!.message, /and replaces the game's Buildings\\Human\\TownHall\\TownHall\.mdx$/);
  assert.match(byFile(found, "_HD.w3mod\\Buildings\\Human\\TownHall\\TownHall.mdx")!.message, /and replaces the game's Buildings\\Human\\TownHall\\TownHall\.mdx$/);
  // The object data names it as .mdl and in another case: the game finds it so all the same.
  const hero = byFile(found, "war3mapimported\\hero.mdx")!.message;
  assert.match(hero, /; used by h000 \(h000\) › Model File$/);
  assert.doesNotMatch(hero, /replaces/);
});

test("a map without any import list gets one warning for all its files, whose fixes list them all or show them", async () => {
  const f = fake({ imp: null });
  const none = await f.run();
  assert.equal(none.length, 1);
  assert.equal(none[0].message, "This map has no import list: 5 files are packed anyway (2 of them replace game files)");
  assert.deepEqual(none[0].fixes?.map((x) => x.label), ["Add all to import list", "Show the files"]);
  await none[0].fixes![0].run();
  assert.equal(f.log.length, 1);
  assert.deepEqual(JSON.parse(f.log[0].replace(/^w3\.imports\.add /, ""))[0].sort(), ["Buildings\\Human\\TownHall\\TownHall.mdx", "_HD.w3mod\\Buildings\\Human\\TownHall\\TownHall.mdx",
    "war3mapImported\\Short.blp", "war3mapImported\\listed.blp", "war3mapimported\\hero.mdx"]);
  await none[0].fixes![1].run();
  assert.equal(f.shown.length, 6);
  assert.match(f.shown.join("\n"), /^ {2}Buildings\\Human\\TownHall\\TownHall\.mdx {2}\(replaces the game's Buildings\\Human\\TownHall\\TownHall\.mdx\)$/m);
});

test("an import list that can't be read fails the check", async () => {
  await assert.rejects(fake({ imp: "{ not json" }).run(), /war3map\.imp\.json is there but can't be read/);
  await assert.rejects(fake({ imp: JSON.stringify({ format: "w3proj.imports/1", version: 1 }) }).run(), /has no file list/);
});

test("Add to import list goes through the Import Manager's command", async () => {
  const f = fake();
  const p = byFile(await f.run(), "war3mapimported\\hero.mdx")!;
  await p.fixes![0].run();
  assert.deepEqual(f.log, ['w3.imports.add [["war3mapimported\\\\hero.mdx"]]']);
});

test("Delete file asks, makes a checkpoint and deletes the file under its name on disk; declined, nothing goes", async () => {
  const f = fake();
  const p = byFile(await f.run(), "war3mapimported\\hero.mdx")!;
  await p.fixes![1].run();
  assert.equal(f.log.length, 4, f.log.join("\n"));
  assert.match(f.log[0], /^ask Delete war3mapimported\\hero\.mdx from the project\?/);
  assert.deepEqual(f.log.slice(1), ['w3.checkpoints.create [{"quiet":true}]', "close map/war3mapimported/hero.mdx", "delete map/war3mapimported/hero.mdx"]);
  assert.ok(!f.files.has("map/war3mapimported/hero.mdx"));

  const no = fake({ ask: false });
  await byFile(await no.run(), "war3mapimported\\hero.mdx")!.fixes![1].run();
  assert.equal(no.log.length, 1);
  assert.ok(no.files.has("map/war3mapimported/hero.mdx"));
});

test("Delete file refuses a file the list names by now, and does nothing for one gone meanwhile", async () => {
  const f = fake();
  const p = byFile(await f.run(), "war3mapimported\\hero.mdx")!;
  f.files.set("map/war3map.imp.json", JSON.stringify({ format: "w3proj.imports/1", version: 1, files: [{ flags: 21, path: "war3mapImported\\Hero.mdx" }] }));
  await assert.rejects(p.fixes![1].run(), /is in the import list now, so it wasn't deleted/);
  assert.ok(f.files.has("map/war3mapimported/hero.mdx"));
  assert.ok(!f.log.some((l) => /^(delete|w3\.checkpoints)/.test(l)));

  const g = fake();
  const q = byFile(await g.run(), "Buildings\\Human\\TownHall\\TownHall.mdx")!;
  g.files.delete("map/Buildings/Human/TownHall/TownHall.mdx");
  await q.fixes![1].run();
  assert.ok(!g.log.some((l) => /^(delete|w3\.checkpoints)/.test(l)));
});

test("a list of nameless entries gives no 'unlisted' warning per file; a list with names beside blank ones still does", async () => {
  const blank = (n: number) => Array.from({ length: n }, () => ({ flags: 0, path: "" }));
  assert.deepEqual(await fake({ imp: JSON.stringify({ files: blank(66) }) }).run(), []);
  // Control: with a name in the list the real unlisted files are reported again.
  const mixed = await fake({ imp: JSON.stringify({ files: [...blank(3), { flags: 21, path: "war3mapImported\\Listed.blp" }] }) }).run();
  assert.ok(mixed.length > 0);
});

test("the imports check names blank entries once, not once per entry", async () => {
  const f = fake({ imp: JSON.stringify({ files: Array.from({ length: 66 }, () => ({ flags: 0, path: "" })) }) });
  const found = await builtinChecks(f.w3).find((c) => c.id === "imports")!.run();
  assert.equal(found.length, 1);
  assert.equal(found[0].message, "66 import entries have no name (stored blank by the map's tool); the imported files can't be matched to the list");
});
