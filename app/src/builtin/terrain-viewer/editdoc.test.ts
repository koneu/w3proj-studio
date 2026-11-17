import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { editMapDoc } from "./derive";

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
