import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { loadPlacedFile, newEntry, onBuildingGrid, pastedEntry, savePlacedFile, type PlacedFile } from "./placement";
import type { Placed } from "./objects";

const file = (key: "doodads" | "units", version: number, subversion: number, more: Record<string, unknown> = {}, list: Placed[] = []): PlacedFile =>
  ({ name: key === "doodads" ? "war3map.doo" : "war3mapUnits.doo", key, doc: { version, subversion, [key]: list, ...more }, list, json: true, dirty: false });

test("a new map's empty doodad file takes its first doodad", () => {
  const f = file("doodads", 13, 11);
  const e = newEntry(f, "LTlt", [64, 128, 0]) as unknown as Record<string, unknown>;
  assert.equal(e.id, "LTlt");
  assert.equal(e.skinId, "LTlt");
  assert.deepEqual(e.position, [64, 128, 0]);
  assert.equal(e.life, 100);
  assert.equal(e.preFlags, 0xffffffff);
  assert.equal(e.editorId, 0xffffffff, "a v13 doodad's number is in its trailer");
  assert.deepEqual(e.trailer, [0, 0, 0]);
  assert.deepEqual(e.extras, []);
});

test("the second doodad continues from the first", () => {
  const f = file("doodads", 13, 11);
  f.list.push(newEntry(f, "LTlt", [0, 0, 0]));
  const e = newEntry(f, "LTlt", [64, 0, 0]) as unknown as { trailer: number[] };
  assert.deepEqual(e.trailer, [1, 0, 0]);
});

test("a blank entry has only what the version has", () => {
  const old = newEntry(file("doodads", 7, 9), "LTlt", [0, 0, 0]) as unknown as Record<string, unknown>;
  for (const k of ["skinId", "preFlags", "itemTable", "itemSets", "trailer", "extras"]) assert.ok(!(k in old), k);
  const v8 = newEntry(file("doodads", 8, 11), "LTlt", [0, 0, 0]) as unknown as Record<string, unknown>;
  assert.ok("itemSets" in v8 && !("skinId" in v8));
  assert.ok("skinId" in (newEntry(file("doodads", 8, 11, { skinIds: true }), "LTlt", [0, 0, 0]) as unknown as Record<string, unknown>));
  const v12 = newEntry(file("doodads", 12, 11), "LTlt", [0, 0, 0]) as unknown as { trailer: number[] };
  assert.equal(v12.trailer.length, 2);
});

test("an empty unit file takes a unit, with hero fields only where the layout has them", () => {
  const sub9 = newEntry(file("units", 13, 9), "hfoo", [0, 0, 0], 2) as unknown as Record<string, unknown>;
  assert.equal(sub9.player, 2);
  assert.equal(sub9.hp, -1);
  assert.ok(!("strength" in sub9) && !("itemTable" in sub9));
  const sub11 = newEntry(file("units", 8, 11), "hfoo", [0, 0, 0]) as unknown as Record<string, unknown>;
  assert.ok("strength" in sub11 && "itemTable" in sub11);
  assert.equal(sub11.level, 1);
});

test("a new item has the World Editor's level 0 and target acquisition 0, a unit 1 and Normal", () => {
  const f = file("units", 8, 11);
  const unit = newEntry(f, "hfoo", [0, 0, 0], 0, "w3u") as unknown as Record<string, unknown>;
  assert.equal(unit.level, 1);
  assert.equal(unit.targetAcquisition, -1);
  f.list.push(unit as unknown as Placed);
  // Same id as an existing item too: the template's values aren't kept.
  for (const list of [[unit], [unit, { ...unit, id: "ratc", level: 3, targetAcquisition: -2 }]]) {
    const g = file("units", 8, 11, {}, list as unknown as Placed[]);
    const item = newEntry(g, "ratc", [64, 0, 0], 0, "w3t") as unknown as Record<string, unknown>;
    assert.equal(item.level, 0);
    assert.equal(item.targetAcquisition, 0);
    assert.equal(item.gold, 0);
    assert.equal(item.player, 27);
  }
  const blank = newEntry(file("units", 8, 11), "ratc", [0, 0, 0], undefined, "w3t") as unknown as Record<string, unknown>;
  assert.equal(blank.level, 0);
  assert.equal(blank.targetAcquisition, 0);
});

test("a new unit copied from an uprooted Ancient isn't uprooted", () => {
  const ancient = { id: "eaow", variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1], player: 1, playerFlags: 0x10000 } as Placed;
  const e = newEntry(file("units", 8, 11, {}, [ancient]), "eaow", [64, 0, 0]) as unknown as Record<string, unknown>;
  assert.equal("playerFlags" in e, false);
});

test("a pasted doodad keeps how it looks, and gets a number of its own", () => {
  const f = file("doodads", 13, 11);
  const first = newEntry(f, "LTlt", [0, 0, 0]);
  f.list.push(first);
  const copied = { entry: { ...structuredClone(first), variation: 2, scale: [2, 2, 3], flags: 6, life: 50 } as unknown as Record<string, unknown>, angle: 1 };
  delete copied.entry.position;
  delete copied.entry.angle;
  const a = pastedEntry(f, copied, [64, 0, 0]);
  f.list.push(a);
  const b = pastedEntry(f, copied, [128, 0, 0]) as unknown as Record<string, unknown>;
  assert.deepEqual([a.variation, a.scale, a.angle, a.position], [2, [2, 2, 3], 1, [64, 0, 0]]);
  assert.equal(b.flags, 6);
  assert.equal(b.life, 50);
  const numbers = [first, a, b].map((e) => (e as unknown as { trailer: number[] }).trailer[0]);
  assert.equal(new Set(numbers).size, 3, `numbers ${numbers}`);
});

test("pasted things share nothing with the copy", () => {
  const f = file("doodads", 13, 11);
  const copied = { entry: { id: "LTlt", scale: [1, 1, 1] }, angle: 0 };
  const a = pastedEntry(f, copied, [0, 0, 0]);
  a.scale[0] = 5;
  assert.equal(copied.entry.scale[0], 1);
});

test("fields of another file version stay out of the map", () => {
  const f = file("doodads", 8, 11);
  const e = pastedEntry(f, { entry: { id: "LTlt", fromAnotherVersion: 1, scale: [2, 2, 2] }, angle: 0 }, [0, 0, 0]) as unknown as Record<string, unknown>;
  assert.equal("fromAnotherVersion" in e, false);
  assert.deepEqual(e.scale, [2, 2, 2]);
});

test("a pasted unit stays its owner's", () => {
  const f = file("units", 8, 11);
  f.list.push(newEntry(f, "hfoo", [0, 0, 0], 1));
  const e = pastedEntry(f, { entry: { id: "hfoo", player: 3 }, angle: 0 }, [64, 0, 0]);
  assert.equal(e.player, 3);
});

test("buildings stand where real maps have them: their edges on the 64 grid", () => {
  // Footprints and spots measured on 14 maps: 8, 12 and 16 on the grid, 6 at 32 past it.
  for (const cells of [4, 8, 12, 16]) assert.equal(((onBuildingGrid(1000, cells) % 64) + 64) % 64, 0, `${cells} cells`);
  for (const cells of [2, 6, 10]) assert.equal(((onBuildingGrid(1000, cells) % 64) + 64) % 64, 32, `${cells} cells`);
  assert.equal(onBuildingGrid(-1000, 8) % 64, -0);
  for (const cells of [4, 6, 8, 12]) assert.equal(onBuildingGrid(onBuildingGrid(777, cells), cells), onBuildingGrid(777, cells), "stays put");
  assert.ok(Math.abs(onBuildingGrid(100, 6) - 100) <= 32, "the nearest spot");
});

test("a plain doodad has life 255, a destructable 100, also copied from each other", () => {
  const f = file("doodads", 13, 11);
  assert.equal((newEntry(f, "CPct", [0, 0, 0], undefined, "w3d") as unknown as { life: number }).life, 255);
  assert.equal((newEntry(f, "LTlt", [0, 0, 0], undefined, "w3b") as unknown as { life: number }).life, 100);
  f.list.push(newEntry(f, "LTlt", [0, 0, 0], undefined, "w3b"));
  assert.equal((newEntry(f, "CPct", [64, 0, 0], undefined, "w3d") as unknown as { life: number }).life, 255);
});

test("items belong to Neutral Passive, whoever's turn it is", () => {
  const f = file("units", 8, 11);
  const owner = (e: unknown) => (e as { player: number }).player;
  assert.equal(owner(newEntry(f, "ratf", [0, 0, 0], 3, "w3t")), 27);
  assert.equal(owner(newEntry(f, "ratf", [0, 0, 0], undefined, "w3t")), 27);
  assert.equal(owner(newEntry(f, "hfoo", [0, 0, 0], 3, "w3u")), 3);
});

test("a doodad file's special doodads are read with it and saved back as they were", async () => {
  const specials = [{ id: "YCx7", z: 0, x: 13, y: 24 }, { id: "LCc0", z: 0, x: 40, y: 60 }];
  const stored = JSON.stringify({ format: "w3proj.doodads/1", version: 13, subversion: 11, doodads: [], specialVersion: 0, specials });
  const written: Record<string, string> = {};
  const w3 = {
    workspace: {
      files: () => [{ path: "map/war3map.doo.json" }],
      readText: async () => stored,
      writeText: async (p: string, text: string) => { written[p] = text; },
      project: () => ({ root: "/maps/M" }),
    },
    backend: { invoke: async (cmd: string, a: { text: string }) => { assert.equal(cmd, "codec_canonicalize"); return a.text; } },
  } as unknown as W3Api;
  const f = (await loadPlacedFile(w3, "war3map.doo", "doodads"))!;
  f.list.push(newEntry(f, "LTlt", [64, 64, 0]));
  await savePlacedFile(w3, f);
  const saved = JSON.parse(written["map/war3map.doo.json"]) as { specials: unknown; specialVersion: number; doodads: unknown[] };
  assert.equal(saved.doodads.length, 1, "the doodad placed is saved");
  assert.deepEqual(saved.specials, specials);
  assert.equal(saved.specialVersion, 0);
});
