// Packing drops the strings nothing refers to from the project's war3map.wts (dropUnusedStrings): every file of the
// map counts, the sounds' dialogue keys too; one undoable edit; nothing while an editor is unsaved, nothing when a file
// can't be read, and the same without the edit log.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dropUnusedStrings } from "./prunestrings";
import { StringTable } from "../../lib/formats/wts";
import { PRUNED_STRINGS_FILE, parsePrunedStrings } from "../../lib/formats/prunedstrings";
import type { W3Api } from "../../extensions/api";

const block = (n: number, text: string) => `STRING ${n}\r\n{\r\n${text}\r\n}\r\n\r\n`;
const WTS = "﻿" + [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => block(n, `text ${n}`)).join("");

/** A project whose files refer to strings 1 (map info), 2 (object data), 4 (custom script), 5 (region name), 6 and 7
 *  (a sound's dialogue keys), 8 (a raw trigger file); 3 and 9 are unused. */
function project() {
  return {
    "map/war3map.wts": WTS,
    "map/war3map.w3i.json": JSON.stringify({ players: [{ name: "TRIGSTR_001" }] }),
    "map/war3map.w3u.json": JSON.stringify({ custom: [{ id: "h000", mods: [{ field: "unam", value: "TRIGSTR_002" }] }] }),
    "map/war3map.wct.txt": "//== header ==\nfunction F takes nothing returns string\n    return \"TRIGSTR_004\"\nendfunction\n",
    "map/war3map.w3r.json": JSON.stringify({ regions: [{ name: "TRIGSTR_005" }] }),
    "map/war3map.w3s.json": JSON.stringify({ sounds: [{ name: "gg_snd_Talk", dialogueTextKey: 6, speakerNameKey: 7 }] }),
    "map/war3map.wtg": "WTG!\u0000\u0000TRIGSTR_008\u0000",
    "map/war3mapImported/note.png": "TRIGSTR_009",
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
  // The edit log as the MCP extension's (builtin/mcp-server/edits.ts) behaves for this: refuses while anything is
  // unsaved, writes what changed, one record per edit that changed something, which holds the file as it was.
  const records: { files: { path: string; before: string | null }[] }[] = [];
  const log = {
    list: () => records,
    edit: async (_title: string, change: (read: (p: string) => Promise<string | null>) => Promise<{ path: string; text: string }[]>) => {
      if (unsaved().length) throw new Error(`Not changed: ${unsaved().join(", ")} has unsaved changes in the editor.`);
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
    },
  };
  const w3 = {
    workspace: {
      project: () => ({ root: opts.root?.() ?? "/p" }),
      files: () => Object.keys(files).map((path) => ({ path })),
      readText,
      readBytes: async (p: string) => new TextEncoder().encode(await readText(p)),
      writeText: async (p: string, t: string) => { writes.push(p); files[p] = t; },
    },
    editors: { unsavedPaths: unsaved },
    services: { get: async () => { if (opts.editLog === false) throw new Error("no such service"); return { edit: log.edit }; } },
    backend: { invoke: async () => { throw new Error("no backend"); } },
  } as unknown as W3Api;
  return { w3, writes, log };
}

const nums = (text: string) => [...new StringTable(text).entries()].map(([n]) => n);

test("unused strings leave the table; every file's references keep theirs, the dialogue keys too", async () => {
  const files = project();
  const { w3, writes, log } = fakeW3(files);
  const r = await dropUnusedStrings(w3);
  assert.deepEqual(r, { dropped: [3, 9], restored: [], kept: null });
  assert.deepEqual(nums(files["map/war3map.wts"]), [1, 2, 4, 5, 6, 7, 8]);
  assert.equal(files["map/war3map.wts"], WTS.replace(block(3, "text 3"), "").replace(block(9, "text 9"), ""), "the rest byte for byte");
  assert.deepEqual(writes, [PRUNED_STRINGS_FILE, "map/war3map.wts"], "the record before the table");
  assert.deepEqual([...parsePrunedStrings(files[PRUNED_STRINGS_FILE])], [[3, "text 3"], [9, "text 9"]]);
  assert.equal(log.list().length, 1, "one undoable edit");
  // Undone in one step: the file as it was.
  assert.equal(log.list()[0].files[0].before, WTS);
  // Nothing left to drop: no edit.
  assert.deepEqual(await dropUnusedStrings(w3), { dropped: [], restored: [], kept: null });
  assert.equal(log.list().length, 1);
});

test("the control: without the sounds file, its dialogue strings are unused", async () => {
  const files = project();
  delete files["map/war3map.w3s.json"];
  const { w3 } = fakeW3(files);
  assert.deepEqual((await dropUnusedStrings(w3)).dropped, [3, 6, 7, 9]);
});

test("an unsaved editor: nothing dropped, and why", async () => {
  const files = project();
  const { w3, writes } = fakeW3(files, { unsaved: ["map/war3map.w3u.json"] });
  const r = await dropUnusedStrings(w3);
  assert.deepEqual(r.dropped, []);
  assert.match(r.kept!, /war3map\.w3u\.json has unsaved changes/);
  assert.deepEqual(writes, []);
});

test("a file that may refer to strings and can't be read: throws, nothing written", async () => {
  const files = project();
  files["map/war3map.wct.txt"] = "\u0000unreadable";
  const { w3, writes } = fakeW3(files);
  await assert.rejects(dropUnusedStrings(w3), /can't read map\/war3map\.wct\.txt/);
  assert.deepEqual(writes, []);
  assert.equal(files["map/war3map.wts"], WTS);
});

test("war3map.wts there but unreadable throws; absent is nothing to do", async () => {
  const files = project();
  files["map/war3map.wts"] = "\u0000unreadable";
  await assert.rejects(dropUnusedStrings(fakeW3(files).w3), /can't read map\/war3map\.wts/);
  const none = project();
  delete none["map/war3map.wts"];
  const { w3, writes } = fakeW3(none);
  assert.deepEqual(await dropUnusedStrings(w3), { dropped: [], restored: [], kept: null });
  assert.deepEqual(writes, []);
});

test("the project changes while the files are read: nothing written", async () => {
  const files = project();
  let calls = 0;
  const { w3, writes } = fakeW3(files, { root: () => (calls++ === 0 ? "/p" : "/other") });
  await assert.rejects(dropUnusedStrings(w3), /project changed/);
  assert.deepEqual(writes, []);
});

test("without the edit log: the same strings go, written once", async () => {
  const files = project();
  const { w3, writes } = fakeW3(files, { editLog: false });
  assert.deepEqual(await dropUnusedStrings(w3), { dropped: [3, 9], restored: [], kept: null });
  assert.deepEqual(nums(files["map/war3map.wts"]), [1, 2, 4, 5, 6, 7, 8]);
  assert.deepEqual(writes, [PRUNED_STRINGS_FILE, "map/war3map.wts"]);
});

test("undo after a pack: a dropped string that is referred to again comes back on the next pack, number and text", async () => {
  const files = project();
  const { w3, log } = fakeW3(files);
  assert.deepEqual((await dropUnusedStrings(w3)).dropped, [3, 9]);
  // The Object Editor's undo brings back an object naming string 3, and is saved.
  files["map/war3map.w3u.json"] = JSON.stringify({ custom: [
    { id: "h000", mods: [{ field: "unam", value: "TRIGSTR_002" }] }, { id: "h001", mods: [{ field: "unam", value: "TRIGSTR_003" }] }] });
  const r = await dropUnusedStrings(w3);
  assert.deepEqual(r, { dropped: [], restored: [3], kept: null });
  const table = new StringTable(files["map/war3map.wts"]);
  assert.equal(table.get(3), "text 3", "its old text, under its old number");
  assert.deepEqual(nums(files["map/war3map.wts"]), [1, 2, 4, 5, 6, 7, 8, 3]);
  assert.ok(files["map/war3map.wts"].startsWith(WTS.replace(block(3, "text 3"), "").replace(block(9, "text 9"), "")), "the rest byte for byte");
  assert.deepEqual([...parsePrunedStrings(files[PRUNED_STRINGS_FILE])], [[9, "text 9"]], "a string that is back leaves the record");
  assert.equal(log.list().length, 2, "the restore is an undoable edit of its own");
  // Unreferenced again: dropped and recorded again.
  files["map/war3map.w3u.json"] = project()["map/war3map.w3u.json"];
  assert.deepEqual((await dropUnusedStrings(w3)).dropped, [3]);
  assert.deepEqual([...parsePrunedStrings(files[PRUNED_STRINGS_FILE])], [[3, "text 3"], [9, "text 9"]]);
});

test("a record that is there but can't be read: nothing restored, nothing dropped", async () => {
  const files = project();
  files[PRUNED_STRINGS_FILE] = "{ not json";
  const { w3, writes } = fakeW3(files);
  await assert.rejects(dropUnusedStrings(w3), /pruned-strings\.json isn't valid JSON/);
  assert.deepEqual(writes, []);
  files[PRUNED_STRINGS_FILE] = "\u0000unreadable";
  await assert.rejects(dropUnusedStrings(w3), /pruned-strings\.json is there but can't be read/);
  assert.deepEqual(writes, []);
  assert.equal(files["map/war3map.wts"], WTS);
});
