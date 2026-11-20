// Packing gives the players' and forces' plain names strings of war3map.wts (namesToStringTable), as the World Editor's
// save does (we-compare plain-names): one undoable edit; numbered past every number taken; the languages' tables too;
// nothing while an editor is unsaved, nothing when a file can't be read, a table made when there is none.

import assert from "node:assert/strict";
import { test } from "node:test";
import { namesToStringTable } from "./namestrings";
import { StringTable } from "../../lib/formats/wts";
import type { W3Api } from "../../extensions/api";

const block = (n: number, text: string) => `STRING ${n}\r\n{\r\n${text}\r\n}\r\n\r\n`;
const WTS = "﻿" + block(1, "Player 1") + block(2, "Force 1");
const INFO = "map/war3map.w3i.json";

/** plain-names-a's w3i: three players, one with no name, one force. */
function project() {
  return {
    "map/war3map.wts": WTS,
    [INFO]: JSON.stringify({ name: "Just another Warcraft III map", players: [{ id: 0, name: "Plain player 1" }, { id: 1, name: "" }, { id: 2, name: "Plain player 3" }], forces: [{ flags: 0, name: "Plain force" }] }),
  } as Record<string, string>;
}

function fakeW3(files: Record<string, string>, opts: { unsaved?: string[]; editLog?: boolean; root?: () => string } = {}) {
  const writes: string[] = [];
  const unsaved = () => opts.unsaved ?? [];
  const readText = async (p: string) => {
    if (!(p in files)) throw new Error(`${p}: No such file or directory (os error 2)`);
    if (files[p] === "\u0000unreadable") throw new Error(`can't read ${p}`);
    return files[p];
  };
  const records: { files: { path: string; before: string | null }[] }[] = [];
  // The edit log as the MCP extension's behaves here: refuses while anything is unsaved, reads absent as null and
  // unreadable as an error, writes what changed in the order given, one record per edit that changed something.
  const edit = async (_title: string, change: (read: (p: string) => Promise<string | null>) => Promise<{ path: string; text: string }[]>) => {
    if (unsaved().length) throw new Error("Not changed: unsaved changes");
    const read = async (p: string) => (p in files ? readText(p) : null);
    const changed = [];
    for (const f of await change(read)) {
      const before = await read(f.path);
      if (before !== f.text) changed.push({ ...f, before });
    }
    if (!changed.length) return false;
    for (const f of changed) { writes.push(f.path); files[f.path] = f.text; }
    records.push({ files: changed });
    return true;
  };
  const w3 = {
    workspace: {
      project: () => ({ root: opts.root?.() ?? "/p" }),
      files: () => Object.keys(files).map((path) => ({ path })),
      filesReady: async () => {},
      readText,
      readBytes: async (p: string) => new TextEncoder().encode(await readText(p)),
      writeText: async (p: string, t: string) => { writes.push(p); files[p] = t; },
    },
    editors: { unsavedPaths: unsaved },
    services: { get: async () => { if (opts.editLog === false) throw new Error("no such service"); return { edit }; } },
    // codec_canonicalize: the codec's layout of the JSON (here the text as given).
    backend: { invoke: async (cmd: string, a: { text: string }) => { assert.equal(cmd, "codec_canonicalize"); return a.text; } },
  } as unknown as W3Api;
  return { w3, writes, records };
}

const info = (files: Record<string, string>) => JSON.parse(files[INFO]) as { name: string; players: { name: string }[]; forces: { name: string }[] };

test("plain names become strings 3, 4, 5 after the table's 1 and 2, in one edit, the tables before the w3i", async () => {
  const files = project();
  const { w3, writes, records } = fakeW3(files);
  assert.deepEqual(await namesToStringTable(w3), { added: [3, 4, 5], reused: 0, kept: null });
  assert.deepEqual(info(files).players.map((p) => p.name), ["TRIGSTR_003", "", "TRIGSTR_004"]);
  assert.deepEqual(info(files).forces.map((f) => f.name), ["TRIGSTR_005"]);
  assert.equal(info(files).name, "Just another Warcraft III map", "the map's name stays plain");
  const table = new StringTable(files["map/war3map.wts"]);
  assert.deepEqual([3, 4, 5].map((n) => table.get(n)), ["Plain player 1", "Plain player 3", "Plain force"]);
  assert.ok(files["map/war3map.wts"].startsWith(WTS), "the table's strings before stay byte for byte");
  assert.deepEqual(writes, ["map/war3map.wts", INFO]);
  assert.equal(records.length, 1, "one undoable edit");
  // Done: nothing left to do, no second edit.
  assert.deepEqual(await namesToStringTable(w3), { added: [], reused: 0, kept: null });
  assert.equal(records.length, 1);
});

test("numbers past what the map's files and the languages' tables take; each language's table gets the strings too", async () => {
  const files = project();
  files["map/war3map.w3r.json"] = JSON.stringify({ regions: [{ name: "TRIGSTR_040" }] });
  files["map/_Locales/deDE.w3mod/war3map.wts"] = "﻿" + block(1, "Spieler 1") + block(50, "nur deutsch");
  const { w3 } = fakeW3(files);
  assert.deepEqual((await namesToStringTable(w3)).added, [51, 52, 53]);
  const de = new StringTable(files["map/_Locales/deDE.w3mod/war3map.wts"]);
  assert.equal(de.get(51), "Plain player 1");
  assert.equal(de.get(50), "nur deutsch");
});

test("the control: names all references or empty change nothing", async () => {
  const files = project();
  files[INFO] = JSON.stringify({ players: [{ name: "TRIGSTR_001" }, { name: "" }], forces: [{ name: "TRIGSTR_002" }] });
  const before = { ...files };
  const { w3, writes } = fakeW3(files);
  assert.deepEqual(await namesToStringTable(w3), { added: [], reused: 0, kept: null });
  assert.deepEqual(writes, []);
  assert.deepEqual(files, before);
});

test("a name whose text the table has, or an earlier name took, refers to that string (plain-names-c)", async () => {
  // plain-names-c: the table holds 2 "Force 1"; the editor saved 3, 3, 4, 5 and 3, 2, 6.
  const files = project();
  files["map/war3map.wts"] = "﻿" + block(2, "Force 1");
  files[INFO] = JSON.stringify({ players: [{ name: "Twin" }, { name: "Twin" }, { name: "Player 1" }, { name: "twin" }], forces: [{ name: "Twin" }, { name: "Force 1" }, { name: "Lone" }] });
  const { w3, records } = fakeW3(files);
  assert.deepEqual(await namesToStringTable(w3), { added: [3, 4, 5, 6], reused: 3, kept: null });
  assert.deepEqual(info(files).players.map((p) => p.name), ["TRIGSTR_003", "TRIGSTR_003", "TRIGSTR_004", "TRIGSTR_005"]);
  assert.deepEqual(info(files).forces.map((f) => f.name), ["TRIGSTR_003", "TRIGSTR_002", "TRIGSTR_006"]);
  const table = new StringTable(files["map/war3map.wts"]);
  assert.deepEqual([...table.entries()], [[2, "Force 1"], [3, "Twin"], [4, "Player 1"], [5, "twin"], [6, "Lone"]]);
  assert.equal(records.length, 1);
  // Only names the table has already: the w3i changes, the table doesn't, still one edit.
  const only = project();
  only[INFO] = JSON.stringify({ players: [{ name: "Player 1" }], forces: [{ name: "Force 1" }] });
  const o = fakeW3(only);
  assert.deepEqual(await namesToStringTable(o.w3), { added: [], reused: 2, kept: null });
  assert.deepEqual(o.writes, [INFO]);
  assert.equal(only["map/war3map.wts"], WTS);
  assert.deepEqual([...info(only).players, ...info(only).forces].map((x) => x.name), ["TRIGSTR_001", "TRIGSTR_002"]);
});

test("no war3map.wts: one is made with the new strings", async () => {
  const files = project();
  delete files["map/war3map.wts"];
  const { w3 } = fakeW3(files);
  assert.deepEqual((await namesToStringTable(w3)).added, [1, 2, 3]);
  assert.equal(new StringTable(files["map/war3map.wts"]).get(1), "Plain player 1");
});

test("a table there but unreadable, or a w3i that isn't JSON: throws, nothing written", async () => {
  const files = project();
  files["map/war3map.wts"] = "\u0000unreadable";
  const a = fakeW3(files);
  await assert.rejects(namesToStringTable(a.w3), /can't read map\/war3map\.wts/);
  assert.deepEqual(a.writes, []);
  const de = project();
  de["map/_Locales/deDE.w3mod/war3map.wts"] = "\u0000unreadable";
  const b = fakeW3(de);
  await assert.rejects(namesToStringTable(b.w3), /deDE/);
  assert.deepEqual(b.writes, []);
  assert.equal(de[INFO], project()[INFO]);
  const broken = project();
  broken[INFO] = "{ not json";
  const c = fakeW3(broken);
  await assert.rejects(namesToStringTable(c.w3), /war3map\.w3i\.json is there but can't be read/);
  assert.deepEqual(c.writes, []);
});

test("an unsaved editor, no edit log, a raw w3i: nothing written, and why", async () => {
  const files = project();
  const a = fakeW3(files, { unsaved: ["map/war3map.w3i.json"] });
  const r = await namesToStringTable(a.w3);
  assert.deepEqual(r.added, []);
  assert.match(r.kept!, /war3map\.w3i\.json has unsaved changes/);
  const b = fakeW3(files, { editLog: false });
  assert.match((await namesToStringTable(b.w3)).kept!, /edit log/);
  const raw = project();
  delete raw[INFO];
  raw["map/war3map.w3i"] = "binary";
  const c = fakeW3(raw);
  assert.deepEqual(await namesToStringTable(c.w3), { added: [], reused: 0, kept: null });
  assert.deepEqual([...a.writes, ...b.writes, ...c.writes], []);
});

test("the project changes while the files are read: nothing written", async () => {
  const files = project();
  let calls = 0;
  const { w3, writes } = fakeW3(files, { root: () => (calls++ < 3 ? "/p" : "/other") });
  await assert.rejects(namesToStringTable(w3), /project changed/);
  assert.deepEqual(writes, []);
  assert.equal(files[INFO], project()[INFO]);
});

// A string of war3map.wts ends at its first "}" (lib/formats/wts wtsCutLines): such a name can't become a string, so it
// stays plain, named in the outcome, and the other names still get theirs (it used to throw for all of them).
test("a name with braces, or with a line of only }, stays plain and is named; the others get strings", async () => {
  const files = project();
  files["map/_Locales/deDE.w3mod/war3map.wts"] = "﻿" + block(1, "Spieler 1");
  files[INFO] = JSON.stringify({ players: [{ id: 0, name: "{Clan} Bob" }, { id: 3, name: "two\n}" }, { id: 4, name: "Fine" }, { id: 5, name: "{open" }], forces: [{ name: "{x}" }, { name: "Team" }] });
  const { w3, records } = fakeW3(files);
  assert.deepEqual(await namesToStringTable(w3), { added: [3, 4, 5], reused: 0, kept: null, plainKept: ["Player 1's name", "Player 4's name", "Force 1's name"] });
  assert.deepEqual(info(files).players.map((p) => p.name), ["{Clan} Bob", "two\n}", "TRIGSTR_003", "TRIGSTR_004"]);
  assert.deepEqual(info(files).forces.map((f) => f.name), ["{x}", "TRIGSTR_005"]);
  for (const path of ["map/war3map.wts", "map/_Locales/deDE.w3mod/war3map.wts"]) {
    const table = new StringTable(files[path]);
    assert.deepEqual([3, 4, 5].map((n) => table.get(n)), ["Fine", "{open", "Team"], path);
  }
  assert.equal(records.length, 1);
  // Again: the braces names are still named, nothing else changes.
  assert.deepEqual(await namesToStringTable(w3), { added: [], reused: 0, kept: null, plainKept: ["Player 1's name", "Player 4's name", "Force 1's name"] });
  assert.equal(records.length, 1);
  // Only such names: nothing is written, no table is made.
  const only = project();
  delete only["map/war3map.wts"];
  only[INFO] = JSON.stringify({ players: [{ id: 0, name: "}" }], forces: [] });
  const o = fakeW3(only);
  assert.deepEqual(await namesToStringTable(o.w3), { added: [], reused: 0, kept: null, plainKept: ["Player 1's name"] });
  assert.deepEqual(o.writes, []);
});

/** A campaign project: no map of its own, two chapter maps under maps/ (each a project), the campaign's string table. */
function campaign() {
  return {
    "map/war3campaign.w3f.json": "{}",
    "map/war3campaign.wts": "﻿" + block(90, "Campaign"),
    "maps/Chapter 1/map/war3map.w3i.json": JSON.stringify({ players: [{ id: 0, name: "Arthas" }, { id: 1, name: "TRIGSTR_001" }], forces: [{ name: "Force 1" }] }),
    "maps/Chapter 1/map/war3map.wts": "﻿" + block(1, "Player 1") + block(2, "Force 1"),
    "maps/Chapter 1/map/war3map.w3r.json": JSON.stringify({ regions: [{ name: "TRIGSTR_040" }] }),
    "maps/Chapter 1/map/_Locales/deDE.w3mod/war3map.wts": "﻿" + block(1, "Spieler 1") + block(50, "nur deutsch"),
    "maps/Chapter 1/.w3proj/pruned-strings.json": JSON.stringify({ format: "w3proj.prunedStrings/1", strings: { 60: "dropped earlier" } }),
    "maps/Chapter 2/map/war3map.w3i.json": JSON.stringify({ players: [{ id: 0, name: "Jaina" }, { id: 1, name: "{Kel}" }], forces: [{ name: "Alliance" }] }),
  } as Record<string, string>;
}

test("a campaign's chapter maps get strings for their plain names, each from its own files and tables", async () => {
  const files = campaign();
  const { w3, records } = fakeW3(files);
  const got = await namesToStringTable(w3);
  // Chapter 1: past its region's 40, its German table's 50 and its record's 60; "Force 1" is its table's 2.
  // Chapter 2: no table yet, one is made; "{Kel}" stays plain.
  assert.deepEqual(got, {
    added: [], reused: 0, kept: null, plainKept: ["maps/Chapter 2: Player 2's name"],
    chapters: [{ folder: "maps/Chapter 1", added: [61], reused: 1 }, { folder: "maps/Chapter 2", added: [1, 2], reused: 0 }],
  });
  const one = JSON.parse(files["maps/Chapter 1/map/war3map.w3i.json"]);
  assert.deepEqual([...one.players, ...one.forces].map((x: { name: string }) => x.name), ["TRIGSTR_061", "TRIGSTR_001", "TRIGSTR_002"]);
  assert.equal(new StringTable(files["maps/Chapter 1/map/war3map.wts"]).get(61), "Arthas");
  assert.equal(new StringTable(files["maps/Chapter 1/map/_Locales/deDE.w3mod/war3map.wts"]).get(61), "Arthas");
  const two = JSON.parse(files["maps/Chapter 2/map/war3map.w3i.json"]);
  assert.deepEqual([...two.players, ...two.forces].map((x: { name: string }) => x.name), ["TRIGSTR_001", "{Kel}", "TRIGSTR_002"]);
  assert.deepEqual([...new StringTable(files["maps/Chapter 2/map/war3map.wts"]).entries()], [[1, "Jaina"], [2, "Alliance"]]);
  assert.equal(files["map/war3campaign.wts"], campaign()["map/war3campaign.wts"], "the campaign's own table stays");
  assert.equal("map/war3map.wts" in files, false, "no table at the campaign's root");
  assert.equal(records.length, 1, "one undoable edit for all of it");
  // Done: nothing left.
  assert.deepEqual((await namesToStringTable(w3)).chapters, undefined);
  assert.equal(records.length, 1);
});

test("a chapter's table there but unreadable: throws, nothing written in any chapter", async () => {
  const files = campaign();
  files["maps/Chapter 2/map/war3map.wts"] = "\u0000unreadable";
  const before = { ...files };
  const { w3, writes } = fakeW3(files);
  await assert.rejects(namesToStringTable(w3), /Chapter 2\/map\/war3map\.wts/);
  assert.deepEqual(writes, []);
  assert.deepEqual(files, before);
});
