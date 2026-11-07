import assert from "node:assert/strict";
import { test } from "node:test";
import { changedTypes, changesImports, changesObjectData, DebouncedReload } from "./filewatch";
import type { Skin } from "./objects";

test("the generated minimap isn't an import, or every save would reload all models", () => {
  for (const p of ["map/war3mapMap.blp", "map\\war3mapMap.blp", "MAP/WAR3MAPMAP.BLP", "map/war3mapMap.tga", "map/war3mapPreview.tga"]) assert.equal(changesImports(p), false, p);
});

test("imported art and the import list are", () => {
  for (const p of ["map/war3map.imp", "map/war3map.imp.json", "map/Hero.mdx", "map/war3mapImported/Tree.blp", "map/textures/rock.dds"]) assert.equal(changesImports(p), true, p);
});

test("the rest isn't", () => {
  for (const p of ["map/war3map.w3e.txt", "map/war3map.doo.json", "build/x.blp", "map/war3map.wpm"]) assert.equal(changesImports(p), false, p);
});

test("object data files are the ones that give types their looks", () => {
  for (const p of ["map/war3map.w3u.json", "map\\war3map.w3d.json", "MAP/WAR3MAP.W3B.JSON", "map/war3mapSkin.w3t.json", "map/war3map.w3u"]) assert.equal(changesObjectData(p), true, p);
  for (const p of ["map/war3map.w3a.json", "map/war3map.doo.json", "map/war3map.w3u.bak", "other/war3map.w3u.json"]) assert.equal(changesObjectData(p), false, p);
});

const skin = (file: string, extra: Partial<Skin> = {}): Skin => ({
  kind: "w3u", file, numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "", ...extra,
});

test("only the placed types whose look changed are named", () => {
  const before = { skins: new Map([["hfoo", skin("footman")], ["h000", skin("footman")], ["h001", skin("knight")]]), bases: new Map([["h000", "hfoo"]]) };
  const after = { skins: new Map([["hfoo", skin("footman")], ["h000", skin("footman")], ["h001", skin("knight", { modelScale: 2 })]]), bases: new Map([["h000", "hfoo"]]) };
  assert.deepEqual([...changedTypes(before, after, ["hfoo", "h000", "h001"])], ["h001"]);
  // A change to a type nothing is placed with is none.
  assert.deepEqual([...changedTypes(before, after, ["hfoo", "h000"])], []);
});

test("a type that appears or goes, or takes another base, counts as changed", () => {
  const before = { skins: new Map([["hfoo", skin("footman")], ["hkni", skin("knight")]]), bases: new Map([["h000", "hfoo"]]) };
  const after = { skins: new Map([["hfoo", skin("footman")], ["hkni", skin("knight")], ["h001", skin("knight")]]), bases: new Map([["h000", "hkni"], ["h001", "hkni"]]) };
  // h000 has no skin of its own: its base's look is its look, so a new base is a change.
  assert.deepEqual([...changedTypes(before, after, ["h000", "h001", "hfoo", "zzzz"])].sort(), ["h000", "h001"]);
  assert.deepEqual([...changedTypes(after, before, ["h001"])], ["h001"]);
});

test("a reload that is scheduled is waited for, also while it runs; a burst makes one", async () => {
  let runs = 0, finished = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const reload = new DebouncedReload(async () => { runs++; await gate; finished++; }, () => assert.fail("no error expected"), 5);
  await reload.settled();
  assert.equal(runs, 0, "nothing scheduled: nothing to wait for");
  reload.schedule(); reload.schedule(); reload.schedule();
  let waited = false;
  const w = reload.settled().then(() => { waited = true; });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runs, 1);
  assert.equal(waited, false, "still running");
  open();
  await w;
  assert.deepEqual([runs, finished], [1, 1]);
});

test("a failing reload is reported, and still ends the wait", async () => {
  const errors: string[] = [];
  const reload = new DebouncedReload(async () => { throw new Error("boom"); }, (e) => errors.push((e as Error).message), 1);
  reload.schedule();
  await reload.settled();
  assert.deepEqual(errors, ["boom"]);
});

test("cancelling ends the wait without running", async () => {
  let runs = 0;
  const reload = new DebouncedReload(async () => { runs++; }, () => {}, 20);
  reload.schedule();
  const w = reload.settled();
  reload.cancel();
  await w;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runs, 0);
});
