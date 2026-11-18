import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { editMapDoc, terrainInfoLock } from "./derive";

/** A project with the given files (path -> text); `decode` is what the raw form's codec does. */
function project(files: Record<string, string>, decode: (p: string) => string) {
  const writes: string[] = [];
  const w3 = {
    workspace: {
      project: () => ({ root: "/p" }),
      files: () => Object.keys(files).map((path) => ({ path })),
      readText: async (p: string) => { if (!(p in files)) throw new Error("not found"); return files[p]; },
      writeText: async (p: string, t: string) => { writes.push(p); files[p] = t; },
    },
    backend: { invoke: async (cmd: string, a: { path: string; text?: string }) => (cmd === "codec_decode" ? decode(a.path) : cmd === "codec_canonicalize" ? a.text : (writes.push(a.path), undefined)) },
  } as unknown as W3Api;
  return { w3, writes, files };
}

test("editMapDoc: an absent file is skipped, a readable one edited", async () => {
  const p = project({ "map/war3map.w3i.json": '{"tileset":"A"}' }, () => "");
  await editMapDoc(p.w3, "war3map.w3r", () => assert.fail("absent file edited"));
  await editMapDoc(p.w3, "war3map.w3i", (d) => { d.tileset = "B"; });
  assert.equal(p.files["map/war3map.w3i.json"], '{"tileset":"B"}');
});

test("editMapDoc: a present w3i that can't be parsed or decoded refuses and leaves the file as it is", async () => {
  const bad = project({ "map/war3map.w3i.json": "{not json" }, () => "");
  await assert.rejects(editMapDoc(bad.w3, "war3map.w3i", (d) => { d.tileset = "B"; }), /war3map\.w3i can't be read/);
  assert.equal(bad.files["map/war3map.w3i.json"], "{not json");
  assert.deepEqual(bad.writes, []);
  const raw = project({ "map/war3map.w3i": "binary" }, () => { throw new Error("undecodable"); });
  let changed = false;
  await assert.rejects(editMapDoc(raw.w3, "war3map.w3i", () => { changed = true; }), /undecodable/);
  assert.equal(changed, false, "the change callback isn't run on an undecodable file");
  assert.deepEqual(raw.writes, []);
});

test("terrainInfoLock: the project's own terrain is read-only when its w3i is there but can't be decoded, from the start", async () => {
  const own = "map/war3map.w3e.txt";
  // A chapter of The Chosen Ones opened on its own: the cut-off version-25 w3i is kept raw, the codec refuses it.
  const raw = project({ [own]: "", "map/war3map.w3i": "cut off" }, () => { throw new Error("w3i: the file ends at 257"); });
  const why = await terrainInfoLock(raw.w3, own, own);
  assert.match(why ?? "", /read-only: war3map\.w3i can't be read \(w3i: the file ends at 257\)/);
  assert.deepEqual(raw.writes, []);
  // Inside a campaign project the chapter's terrain isn't the project's own: it edits as before.
  assert.equal(await terrainInfoLock(raw.w3, "maps/Prologue.w3x/map/war3map.w3e.txt", null), null);
  assert.equal(await terrainInfoLock(raw.w3, "maps/Prologue.w3x/map/war3map.w3e.txt", own), null);
  // Controls: a w3i that reads, and none at all (absent isn't unreadable).
  const good = project({ [own]: "", "map/war3map.w3i.json": '{"tileset":"A"}' }, () => "");
  assert.equal(await terrainInfoLock(good.w3, own, own), null);
  const none = project({ [own]: "" }, () => { throw new Error("not called"); });
  assert.equal(await terrainInfoLock(none.w3, own, own), null);
  const badJson = project({ [own]: "", "map/war3map.w3i.json": "{not json" }, () => "");
  assert.match((await terrainInfoLock(badJson.w3, own, own)) ?? "", /read-only/);
});
