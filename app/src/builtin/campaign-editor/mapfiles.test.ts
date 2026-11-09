import assert from "node:assert/strict";
import { test } from "node:test";
import { buttonsOf, dropFromMapOrder, type ChapterList } from "./chapters";
import { exportMap, HOLD, mapPlace, removeMap, replaceMap, type CampaignFs } from "./mapfiles";

/** A project in memory: paths to contents ("folders" are paths with entries below them). */
function memoryFs(entries: Record<string, string>, opts: { badSource?: string } = {}) {
  const files = new Map(Object.entries(entries));
  const out = new Map<string, string>();
  const under = (p: string) => [...files.keys()].filter((k) => k === p || k.startsWith(`${p}/`));
  const fs: CampaignFs = {
    exists: async (p) => under(p).length > 0,
    rename: async (from, to) => {
      if (under(to).length) throw new Error(`${to} exists`);
      const moving = under(from);
      if (!moving.length) throw new Error(`no ${from}`);
      for (const k of moving) { files.set(to + k.slice(from.length), files.get(k)!); files.delete(k); }
    },
    unpack: async (src, dir) => {
      if (src === opts.badSource) throw new Error(`can't read ${src}`);
      files.set(`${dir}/w3proj.toml`, `from ${src}`);
      files.set(`${dir}/map/war3map.w3i.json`, `info of ${src}`);
    },
    copy: async (from, to) => {
      if (from === opts.badSource) throw new Error(`can't read ${from}`);
      const v = files.get(from) ?? (from.startsWith("/") ? `bytes of ${from}` : undefined);
      if (v === undefined) throw new Error(`no ${from}`);
      if (to.startsWith("/")) out.set(to, v); else files.set(to, v);
    },
    pack: async (dir, output) => { out.set(output, `packed ${files.get(`${dir}/w3proj.toml`)}`); },
  };
  const visible = () => [...files.keys()].filter((k) => !k.startsWith(`${HOLD}/`)).sort();
  return { fs, files, out, visible };
}

const PROJECT = { "maps/One.w3x/w3proj.toml": "one", "maps/One.w3x/map/war3map.w3i.json": "info one", "map/Two.w3m": "two", "map/war3campaign.w3f.json": "{}" };

test("a campaign map's place: its project under maps/, or its packed file in map/", () => {
  assert.equal(mapPlace("One.w3x", true), "maps/One.w3x");
  assert.equal(mapPlace("Two.w3m", false), "map/Two.w3m");
});

test("Remove map: the map leaves the campaign, kept in build/ for undo; redo takes it away again", async () => {
  const m = memoryFs(PROJECT);
  const step = await removeMap(m.fs, "One.w3x", true);
  assert.deepEqual(m.visible(), ["map/Two.w3m", "map/war3campaign.w3f.json"]);
  // Nothing is gone: it waits below build/ (not packed, not in git).
  assert.equal([...m.files.keys()].filter((k) => k.startsWith(`${HOLD}/`)).length, 2);
  await step.undo();
  assert.deepEqual(m.visible(), Object.keys(PROJECT).sort());
  assert.equal(m.files.get("maps/One.w3x/map/war3map.w3i.json"), "info one");
  await step.redo();
  assert.equal(await m.fs.exists("maps/One.w3x"), false);
  // A packed map the same way.
  const packed = await removeMap(m.fs, "Two.w3m", false);
  assert.equal(await m.fs.exists("map/Two.w3m"), false);
  await packed.undo();
  assert.equal(m.files.get("map/Two.w3m"), "two");
});

test("Replace map: new content at the same place, the old one back with undo", async () => {
  const m = memoryFs(PROJECT);
  const step = await replaceMap(m.fs, "One.w3x", true, "/disk/Other.w3x");
  assert.equal(m.files.get("maps/One.w3x/w3proj.toml"), "from /disk/Other.w3x");
  assert.equal(m.files.get("maps/One.w3x/map/war3map.w3i.json"), "info of /disk/Other.w3x");
  assert.deepEqual(m.visible(), Object.keys(PROJECT).sort());
  await step.undo();
  assert.equal(m.files.get("maps/One.w3x/map/war3map.w3i.json"), "info one");
  await step.redo();
  assert.equal(m.files.get("maps/One.w3x/map/war3map.w3i.json"), "info of /disk/Other.w3x");
  // A packed map: the file is copied in.
  await replaceMap(m.fs, "Two.w3m", false, "/disk/New.w3m");
  assert.equal(m.files.get("map/Two.w3m"), "bytes of /disk/New.w3m");
});

test("Replace map: a map that can't be read changes nothing", async () => {
  const m = memoryFs(PROJECT, { badSource: "/disk/broken.w3x" });
  await assert.rejects(replaceMap(m.fs, "One.w3x", true, "/disk/broken.w3x"), /can't read/);
  await assert.rejects(replaceMap(m.fs, "Two.w3m", false, "/disk/broken.w3x"), /can't read/);
  assert.deepEqual(m.visible(), Object.keys(PROJECT).sort());
  assert.equal(m.files.get("maps/One.w3x/map/war3map.w3i.json"), "info one");
  assert.equal(m.files.get("map/Two.w3m"), "two");
  // A map that isn't there is refused before anything is read.
  await assert.rejects(replaceMap(m.fs, "Gone.w3x", true, "/disk/Other.w3x"), /isn't there/);
});

test("undo of a removed map is refused when something took its place since", async () => {
  const m = memoryFs(PROJECT);
  const step = await removeMap(m.fs, "One.w3x", true);
  m.files.set("maps/One.w3x/w3proj.toml", "a new one");
  await assert.rejects(step.undo(), /in the way/);
  assert.equal(m.files.get("maps/One.w3x/w3proj.toml"), "a new one");
});

test("Export map: a project map packed, a packed one copied", async () => {
  const m = memoryFs(PROJECT);
  await exportMap(m.fs, "One.w3x", true, "/out/One.w3x");
  assert.equal(m.out.get("/out/One.w3x"), "packed one");
  await exportMap(m.fs, "Two.w3m", false, "/out/Two.w3m");
  assert.equal(m.out.get("/out/Two.w3m"), "two");
  await assert.rejects(exportMap(m.fs, "Gone.w3x", true, "/out/x.w3x"), /isn't there/);
});

test("buttons of a map, and a removed map out of the map order (buttons stay)", () => {
  const info: ChapterList = {
    chapters: [{ flags: 1, chapter: "1", title: "a", map: "One.w3x" }, { flags: 0, chapter: "2", title: "b", map: "Two.w3m" }, { flags: 0, chapter: "3", title: "c", map: "one.W3X" }],
    mapOrder: [{ unknown: "", map: "One.w3x" }, { unknown: "", map: "Two.w3m" }],
  };
  assert.deepEqual(buttonsOf(info, "ONE.w3x"), [0, 2]);
  assert.deepEqual(buttonsOf(info, "Three.w3x"), []);
  dropFromMapOrder(info, "one.w3x");
  assert.deepEqual(info.mapOrder.map((m) => m.map), ["Two.w3m"]);
  assert.equal(info.chapters.length, 3);
});
