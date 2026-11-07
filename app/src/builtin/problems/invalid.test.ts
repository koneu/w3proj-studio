// Delete Invalid Objects, through the code the command runs, on a made-up project and game.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { deleteInvalid, describePlan, planInvalid, splitInvalid, type KindLoader } from "./invalid";

const UNITS = "map/war3mapUnits.doo.json", DOODADS = "map/war3map.doo.json";
const units = (...ids: string[]) => JSON.stringify({ format: "w3proj.units/1", version: 8, units: ids.map((id, i) => ({ id, position: [i, 0, 0], player: 0 })) });
const doodads = (...ids: string[]) => JSON.stringify({ format: "w3proj.doodads/1", version: 8, doodads: ids.map((id) => ({ id, position: [0, 0, 0] })) });

/** The game knows hfoo (unit), ratf (item), LTlt (doodad), ATtr (destructable). */
const GAME: Record<string, string[]> = { w3u: ["hfoo"], w3t: ["ratf"], w3b: ["ATtr"], w3d: ["LTlt"] };
const game: KindLoader = async (_w3, kind) => ({ baseIds: GAME[kind] ?? [] });

function setup(files: Record<string, string>, opts: { answer?: boolean; unsaved?: string[]; raw?: string[]; root?: string } = {}) {
  const fs = new Map(Object.entries(files));
  const log: string[] = [];
  const raw = new Set(opts.raw ?? []);
  const state = { asked: "" };
  const w3 = {
    workspace: {
      project: () => ({ root: opts.root ?? "C:\\p" }),
      resolve: (p: string) => p,
      readText: async (p: string) => { if (raw.has(p) || !fs.has(p)) throw new Error("no such file"); return fs.get(p)!; },
      writeText: async (p: string, t: string) => { log.push(`write ${p}`); fs.set(p, t); },
    },
    backend: {
      invoke: async (cmd: string, a: { path: string; text?: string }) => {
        if (cmd === "codec_decode") { const t = fs.get(`${a.path}.json`); if (t === undefined) throw new Error("no codec"); return t; }
        if (cmd === "fs_exists") return fs.has(a.path) || fs.has(`${a.path}.json`);
        if (cmd === "codec_canonicalize") return a.text!;
        if (cmd === "codec_write") { log.push(`codec_write ${a.path}`); fs.set(`${a.path}.json`, a.text!); return null; }
        throw new Error(cmd);
      },
    },
    editors: { unsavedPaths: () => opts.unsaved ?? [] },
    commands: { execute: async (id: string) => { log.push(`command ${id}`); } },
    window: {
      confirm: async (m: string) => { state.asked = m; log.push("confirm"); return opts.answer ?? true; },
      showInfo: async () => undefined,
    },
  } as unknown as W3Api;
  return { w3, fs, log, state };
}

const idsOf = (fs: Map<string, string>, file: string, key: string) => (JSON.parse(fs.get(file)!)[key] as { id: string }[]).map((p) => p.id);

test("splitInvalid keeps known types, start locations, random objects and entries it can't read", () => {
  const known = new Set(["hfoo"]); // no "sloc" in it: start locations are kept by rule
  const { keep, removed } = splitInvalid([{ id: "hfoo" }, { id: "sloc" }, { id: "uDNR" }, { id: "YiI3" }, { id: "zzzz" }, { id: 7 }, {}, { id: "Qqqq" }], known);
  assert.deepEqual(removed.map((p) => p.id), ["zzzz", "Qqqq"]);
  assert.equal(keep.length, 6);
  assert.deepEqual(splitInvalid([], known), { keep: [], removed: [] });
});

test("the plan counts the unknown types per file, and only those", async () => {
  const { w3 } = setup({ [UNITS]: units("hfoo", "xxxx", "xxxx", "sloc", "ratf"), [DOODADS]: doodads("LTlt", "yyyy") });
  const plan = await planInvalid(w3, game);
  assert.equal(plan.total, 3);
  assert.deepEqual([...plan.types], [["xxxx", 2], ["yyyy", 1]]);
  assert.deepEqual(plan.files.map((f) => [f.file, f.count]), [[UNITS, 2], [DOODADS, 1]]);
  assert.match(describePlan(plan), /Delete 3 placed objects of 2 unknown types \(xxxx ×2, yyyy ×1\)/);
});

test("a custom object of the map's own data is not invalid", async () => {
  const custom = JSON.stringify({ custom: [{ id: "h000", base: "hfoo" }] });
  const { w3 } = setup({ [UNITS]: units("h000", "xxxx"), "map/war3map.w3u.json": custom });
  assert.equal((await planInvalid(w3, game)).total, 1);
});

test("it asks first, makes a checkpoint, removes them, and keeps everything else in the files", async () => {
  const { w3, fs, log, state } = setup({ [UNITS]: units("hfoo", "xxxx", "sloc", "ratf", "xxxx"), [DOODADS]: doodads("LTlt", "yyyy", "ATtr") });
  assert.equal(await deleteInvalid(w3, game), 3);
  assert.match(state.asked, /3 placed objects/);
  assert.deepEqual(idsOf(fs, UNITS, "units"), ["hfoo", "sloc", "ratf"]);
  assert.deepEqual(idsOf(fs, DOODADS, "doodads"), ["LTlt", "ATtr"]);
  const doc = JSON.parse(fs.get(UNITS)!);
  assert.equal(doc.format, "w3proj.units/1");
  assert.equal(doc.version, 8);
  assert.deepEqual(log.slice(0, 2), ["confirm", "command w3.checkpoints.create"], "asked, then checkpoint, before any write");
  assert.deepEqual(log.slice(2), [`write ${UNITS}`, `write ${DOODADS}`]);
});

test("a file with nothing invalid isn't written", async () => {
  const { w3, log } = setup({ [UNITS]: units("hfoo", "xxxx"), [DOODADS]: doodads("LTlt") });
  await deleteInvalid(w3, game);
  assert.deepEqual(log.filter((l) => l.startsWith("write")), [`write ${UNITS}`]);
});

test("declining changes nothing", async () => {
  const { w3, fs, log } = setup({ [UNITS]: units("hfoo", "xxxx") }, { answer: false });
  const before = fs.get(UNITS);
  assert.equal(await deleteInvalid(w3, game), 0);
  assert.equal(fs.get(UNITS), before);
  assert.deepEqual(log, ["confirm"]);
});

test("nothing invalid: no question, no checkpoint", async () => {
  const { w3, log } = setup({ [UNITS]: units("hfoo", "sloc"), [DOODADS]: doodads("LTlt") });
  assert.equal(await deleteInvalid(w3, game), 0);
  assert.deepEqual(log, []);
});

test("refused without the game's data: whether it failed to load or came back empty", async () => {
  for (const load of [
    (async (_w3, kind) => { if (kind === "w3d") throw new Error("no game"); return { baseIds: ["hfoo"] }; }) as KindLoader,
    (async () => ({ baseIds: [] })) as KindLoader,
  ]) {
    const { w3, fs, log } = setup({ [UNITS]: units("hfoo", "xxxx", "sloc") });
    const before = fs.get(UNITS);
    await assert.rejects(deleteInvalid(w3, load), /game's object data isn't available/);
    assert.equal(fs.get(UNITS), before);
    assert.deepEqual(log, []);
  }
});

test("refused while an editor has unsaved changes", async () => {
  const { w3, fs, log } = setup({ [UNITS]: units("hfoo", "xxxx") }, { unsaved: ["map/war3map.w3e.txt"] });
  const before = fs.get(UNITS);
  await assert.rejects(deleteInvalid(w3, game), /war3map\.w3e\.txt/);
  assert.equal(fs.get(UNITS), before);
  assert.deepEqual(log, []);
});

test("a file the project keeps raw goes back through its codec", async () => {
  const { w3, fs, log } = setup({ [UNITS]: units("hfoo", "xxxx") }, { raw: [UNITS] });
  assert.equal(await deleteInvalid(w3, game), 1);
  assert.deepEqual(idsOf(fs, UNITS, "units"), ["hfoo"]);
  assert.ok(log.includes("codec_write map/war3mapUnits.doo"));
});

const CHAPTER = "C:\\camp\\maps\\Chapter 4.w3x";
const customUnits = (...ids: string[]) => JSON.stringify({ custom: ids.map((id) => ({ id, base: "hfoo" })) });

test("a chapter map knows its campaign's custom objects, also the skin ones, so none are invalid", async () => {
  const { w3, fs, log } = setup({
    [UNITS]: units("hfoo", "c001", "c002", "xxxx"), [DOODADS]: doodads("LTlt", "d001"),
    "C:/camp/map/war3campaign.w3u.json": customUnits("c001"),
    "C:/camp/map/war3campaignSkin.w3u.json": customUnits("c002"),
    "C:/camp/map/war3campaign.w3d.json": JSON.stringify({ custom: [{ id: "d001", base: "LTlt" }] }),
  }, { root: CHAPTER });
  const plan = await planInvalid(w3, game);
  assert.deepEqual([...plan.types], [["xxxx", 1]], "only the type nobody has");
  await deleteInvalid(w3, game);
  assert.deepEqual(idsOf(fs, UNITS, "units"), ["hfoo", "c001", "c002"]);
  assert.deepEqual(idsOf(fs, DOODADS, "doodads"), ["LTlt", "d001"]);
  assert.ok(log.length > 0);
});

test("a project that holds the campaign's object files itself knows them too", async () => {
  const { w3 } = setup({
    [UNITS]: units("hfoo", "c001", "c002"), [DOODADS]: doodads(),
    "map/war3campaign.w3u.json": customUnits("c001"), "map/war3campaignSkin.w3u.json": customUnits("c002"),
  });
  assert.equal((await planInvalid(w3, game)).total, 0);
});

test("a map outside a campaign folder gets no campaign path", async () => {
  const { campaignOf } = await import("./invalid");
  assert.equal(campaignOf("C:\\camp\\maps\\Chapter 4.w3x"), "C:/camp");
  assert.equal(campaignOf("C:\\camp\\maps\\Chapter 4.w3x\\"), "C:/camp");
  assert.equal(campaignOf("/home/u/camp/maps/ch"), "/home/u/camp");
  assert.equal(campaignOf("C:\\maps\\My Map"), "C:");
  assert.equal(campaignOf("C:\\p"), undefined);
  assert.equal(campaignOf(undefined), undefined);
});

test("an object file that is there but can't be read stops everything instead of making its objects unknown", async () => {
  for (const bad of ["map/war3map.w3u.json", "map/war3mapSkin.w3u.json", "C:/camp/map/war3campaign.w3u.json"]) {
    const { w3, fs, log } = setup({ [UNITS]: units("hfoo", "h000", "h001"), [DOODADS]: doodads("LTlt"), [bad]: "{ not json" }, { root: CHAPTER });
    const before = fs.get(UNITS);
    await assert.rejects(deleteInvalid(w3, game), (e: Error) => e.message.includes(bad) && /can't be read/.test(e.message), bad);
    assert.equal(fs.get(UNITS), before);
    assert.deepEqual(log, [], "no question, no checkpoint, no write");
  }
});

test("a placement file that can't be read is refused too", async () => {
  const { w3 } = setup({ [UNITS]: "{ broken", [DOODADS]: doodads("LTlt", "yyyy") });
  await assert.rejects(planInvalid(w3, game), /war3mapUnits\.doo\.json is there but can't be read/);
});
