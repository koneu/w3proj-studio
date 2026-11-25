// Packing drops the strings nothing refers to from the project's war3map.wts (dropUnusedStrings): every file of the
// map counts, the sounds' dialogue keys too; one undoable edit; nothing while an editor is unsaved, nothing when a file
// can't be read, and the same without the edit log.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dropUnusedStrings } from "./prunestrings";
import { readTextFile, StringTable, writeTextFile } from "../../lib/formats/wts";
import { decodeLossless, encodeLossless } from "../../lib/formats/lossless";
import { PRUNED_STRINGS_FILE, parsePrunedStrings } from "../../lib/formats/prunedstrings";
import type { W3Api } from "../../extensions/api";
import { fixturePath } from "../../lib/testhelpers/testutil";

const block = (n: number, text: string) => `STRING ${n}\r\n{\r\n${text}\r\n}\r\n\r\n`;
const WTS = "\uFEFF" + [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => block(n, `text ${n}`)).join("");

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

/** `unlisted`: files the workspace doesn't list yet, as right after an open, until `listing` ends (filesReady). */
function fakeW3(files: Record<string, string>, opts: { unsaved?: string[]; editLog?: boolean; root?: () => string; unlisted?: string[]; listing?: Promise<void> } = {}) {
  const writes: string[] = [];
  const unsaved = () => opts.unsaved ?? [];
  const listed = { pending: !!opts.listing };
  opts.listing?.then(() => { listed.pending = false; }, () => {});
  // A file's text is its bytes as lossless.ts reads them: one that isn't UTF-8 (a table in an old code page) holds its
  // private-use characters, and readText refuses it as the backend does.
  const readBytes = async (p: string) => {
    if (!(p in files)) throw new Error(`${p}: No such file or directory (os error 2)`);
    if (files[p] === "\u0000unreadable") throw new Error(`can't read ${p}`);
    return encodeLossless(files[p]);
  };
  const readText = async (p: string) => {
    const bytes = await readBytes(p);
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw Object.assign(new Error(`${p} is not valid UTF-8`), { name: "NotUtf8Error" }); }
  };
  const workspace = {
    project: () => ({ root: opts.root?.() ?? "/p" }),
    files: () => Object.keys(files).filter((path) => !listed.pending || !opts.unlisted?.includes(path)).map((path) => ({ path })),
    filesReady: async () => { await opts.listing; },
    readText,
    readBytes,
    writeText: async (p: string, t: string) => { writes.push(p); files[p] = decodeLossless(new TextEncoder().encode(t)); },
    writeBytes: async (p: string, b: Uint8Array) => { writes.push(p); files[p] = decodeLossless(b); },
  };
  // The edit log as the MCP extension's (builtin/mcp-server/edits.ts) behaves for this: refuses while anything is
  // unsaved, writes what changed, one record per edit that changed something, which holds the file as it was. It
  // reads and writes as the MCP extension does (readTextFile, writeTextFile).
  const records: { files: { path: string; before: string | null }[] }[] = [];
  const log = {
    list: () => records,
    edit: async (_title: string, change: (read: (p: string) => Promise<string | null>) => Promise<{ path: string; text: string }[]>) => {
      if (unsaved().length) throw new Error(`Not changed: ${unsaved().join(", ")} has unsaved changes in the editor.`);
      const read = async (p: string) => (p in files ? readTextFile(workspace, p) : null);
      const changed = [];
      for (const f of await change(read)) {
        const before = await read(f.path);
        if (before !== f.text) changed.push({ ...f, before });
      }
      if (!changed.length) return false;
      for (const f of changed) await writeTextFile(workspace, f.path, f.text);
      records.push({ files: changed });
      return true;
    },
  };
  const w3 = {
    workspace,
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
  const { w3, writes } = fakeW3(files, { root: () => (calls++ < 2 ? "/p" : "/other") });
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

// The table of crates/w3proj/src/wts.rs "a_table_in_a_code_page_is_pruned_byte_for_byte": GBK "中文", CP949 "한국" (unused),
// Big5 "中文", a GBK character whose second byte is `}` (the text ends there, as at any `}`), and the junk the game's
// BonusCredits.w3m holds in its table. Both sides must give the same bytes.
const codePageBlock = (n: number, text: number[]) => [...new TextEncoder().encode(`STRING ${n}\r\n{\r\n`), ...text, ...new TextEncoder().encode("\r\n}\r\n\r\n")];
const CODE_PAGE = [
  [0xef, 0xbb, 0xbf],
  codePageBlock(1, [0xd6, 0xd0, 0xce, 0xc4]),
  codePageBlock(2, [...new TextEncoder().encode("orphan "), 0xc7, 0xd1, 0xb1, 0xb9]),
  codePageBlock(3, [0xa4, 0xa4, 0xa4, 0xe5]),
  codePageBlock(4, [...new TextEncoder().encode("cut "), 0x81, 0x7d]),
  codePageBlock(5, [0xee, 0xee, 0xb1, 0x12, 0xdd]),
];

for (const editLog of [true, false]) {
  test(`a table that isn't UTF-8 (an old map's code page) is pruned byte for byte${editLog ? "" : ", without the edit log too"}`, async () => {
    const files = project();
    const bytes = new Uint8Array(CODE_PAGE.flat());
    files["map/war3map.wts"] = decodeLossless(bytes);
    files["map/war3map.w3i.json"] = JSON.stringify({ a: "TRIGSTR_001", b: "TRIGSTR_003", c: "TRIGSTR_004", d: "TRIGSTR_005" });
    for (const p of ["map/war3map.w3u.json", "map/war3map.wct.txt", "map/war3map.w3r.json", "map/war3map.w3s.json", "map/war3map.wtg", "map/war3mapImported/note.png"]) delete files[p];
    const { w3, writes } = fakeW3(files, { editLog });
    // The control: the table can't be read as text, which is what kept it whole before.
    await assert.rejects(w3.workspace.readText("map/war3map.wts"), { name: "NotUtf8Error" });
    assert.deepEqual(await dropUnusedStrings(w3), { dropped: [2], restored: [], kept: null });
    const expected = new Uint8Array([CODE_PAGE[0], CODE_PAGE[1], CODE_PAGE[3], CODE_PAGE[4], CODE_PAGE[5]].flat());
    assert.deepEqual(encodeLossless(files["map/war3map.wts"]), expected);
    assert.deepEqual(writes, [PRUNED_STRINGS_FILE, "map/war3map.wts"]);
    // The record holds the dropped text as lossless text (JSON can't hold its bytes); restored, it is those bytes again.
    assert.deepEqual(encodeLossless(parsePrunedStrings(await w3.workspace.readText(PRUNED_STRINGS_FILE)).get(2)!), new Uint8Array(CODE_PAGE[2].slice(13, 24)));
    files["map/war3map.w3i.json"] = JSON.stringify({ a: "TRIGSTR_001", b: "TRIGSTR_003", c: "TRIGSTR_004", d: "TRIGSTR_005", e: "TRIGSTR_002" });
    assert.deepEqual(await dropUnusedStrings(w3), { dropped: [], restored: [2], kept: null });
    assert.deepEqual(encodeLossless(files["map/war3map.wts"]), new Uint8Array([...expected, ...CODE_PAGE[2]]));
  });
}

const twinFixture = (): string => fixturePath("wts-prune");

test("the fixture the CLI's Rust prunes too (crates/w3proj/tests/wts_prune.rs): the same table", async () => {
  const root = twinFixture();
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else files[`${rel}${e.name}`] = readFileSync(join(dir, e.name), "latin1");
    }
  };
  walk(join(root, "map"), "map/");
  files[PRUNED_STRINGS_FILE] = readFileSync(join(root, PRUNED_STRINGS_FILE), "utf8");
  const { w3 } = fakeW3(files);
  assert.deepEqual(await dropUnusedStrings(w3), { dropped: [3, 5, 9, 12], restored: [20], kept: null });
  assert.equal(files["map/war3map.wts"], readFileSync(join(root, "expected.wts"), "utf8"));
  // The German table stays byte for byte: the strings war3map.wts dropped (3, 5, 12) and its own 30 too, and its text's
  // TRIGSTR_009 doesn't keep 9 (a string table refers to nothing).
  const de = "map/_Locales/deDE.w3mod/war3map.wts";
  assert.equal(files[de], readFileSync(join(root, de), "latin1"));
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

test("right after an open, while the file list is still read: the drop waits for it, a file not listed yet isn't absent", async () => {
  const files = project();
  let done!: () => void;
  const listing = new Promise<void>((r) => { done = r; });
  const { w3 } = fakeW3(files, { listing, unlisted: ["map/war3map.wct.txt", "map/war3map.w3r.json"] });
  // The control: the list as it is before the listing ends lacks the files that refer to 4 and 5.
  assert.ok(!w3.workspace.files().some((f) => f.path === "map/war3map.wct.txt"));
  const run = dropUnusedStrings(w3);
  // [Refactored] Replaced 20 ms setTimeout with deterministic setImmediate after dropUnusedStrings awaits listing.
  setImmediate(done);
  assert.deepEqual((await run).dropped, [3, 9]);
  assert.deepEqual(nums(files["map/war3map.wts"]), [1, 2, 4, 5, 6, 7, 8]);
});

test("a file list that can't be read: nothing dropped", async () => {
  const files = project();
  const { w3, writes } = fakeW3(files, { listing: Promise.reject(new Error("The project's file list couldn't be read")), unlisted: ["map/war3map.wct.txt"] });
  await assert.rejects(dropUnusedStrings(w3), /file list couldn't be read/);
  assert.deepEqual(writes, []);
});
