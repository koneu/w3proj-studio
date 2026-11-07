import assert from "node:assert/strict";
import { test } from "node:test";
import { changedTypes, changesImports, changesObjectData, changesPathing, DebouncedReload } from "./filewatch";
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

test("only unit, destructable and doodad object data changes pathing footprints", () => {
  for (const p of ["map/war3map.w3u.json", "map/war3map.w3d.json", "map/war3map.w3b.json", "map/war3map.w3u", "MAP/WAR3MAP.W3B.JSON"]) assert.equal(changesPathing(p), true, p);
  for (const p of ["map/war3map.w3t.json", "map/war3mapSkin.w3u.json", "map/war3map.doo.json", "map/war3map.w3a.json"]) assert.equal(changesPathing(p), false, p);
});

test("saves that keep coming can't starve the wait: the reload runs after the longest wait", async (t) => {
  // A fake clock: the time is counted, not measured, so a loaded machine can't stretch it.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  // setImmediate isn't faked: it lets the run's promise chain go on between turns of the clock.
  const flush = () => new Promise<void>((r) => setImmediate(r));
  const delay = 30, maxWait = 90, every = 10, savesFor = 500;
  const runsAt: number[] = [];
  const reload = new DebouncedReload(async () => { runsAt.push(Date.now()); }, () => {}, delay, maxWait);
  const start = Date.now();
  // A save every 10 ms, a third of the debounce delay, for half a second: without the longest
  // wait, the delay never runs out until they stop.
  for (let at = 0; at < savesFor; at += every) {
    reload.schedule();
    t.mock.timers.tick(every);
    await flush();
  }
  assert.ok(runsAt.length > 0, `no reload while ${savesFor / every} saves kept coming`);
  assert.ok(runsAt[0] - start <= maxWait, `first run after ${runsAt[0] - start} ms of saves, longer than the longest wait of ${maxWait}`);
  // Each later run is as close to its predecessor: the saves never hold one back.
  for (let i = 1; i < runsAt.length; i++) assert.ok(runsAt[i] - runsAt[i - 1] <= maxWait + every, `run ${i + 1} came ${runsAt[i] - runsAt[i - 1]} ms after the one before`);
  // The saves stop: the last one's reload comes, and the wait ends with it.
  let settled = false;
  const w = reload.settled().then(() => { settled = true; });
  t.mock.timers.tick(delay);
  await flush();
  await w;
  assert.ok(settled);
  assert.equal(runsAt.at(-1), start + savesFor + delay, "the last save's reload, a delay after it");
});

test("a save during a run gets its own run, and the wait covers both", async () => {
  const order: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let n = 0;
  const reload = new DebouncedReload(async () => { const me = ++n; order.push(`start ${me}`); if (me === 1) await gate; order.push(`end ${me}`); }, () => {}, 5, 50);
  reload.schedule();
  await new Promise((r) => setTimeout(r, 30));
  reload.schedule();
  const w = reload.settled();
  open();
  await w;
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"]);
});
