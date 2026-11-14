import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { copyCentre, DEFAULT_START_GOLD, loadPlacedFile, newEntry, onBuildingGrid, pastedEntry, pasteCentreAt, savePlacedFile, startGoldOf, unitGridCells, type PlacedFile } from "./placement";
import { fragmentOf } from "../../lib/terrain/fragment";
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

test("a new placed unit has the start gold the World Editor writes: 12500, or the map's Agld Gld1", () => {
  // Real maps: 12500 on every placed unit of the melee maps in smoketest_maps (start locations and items 0); a Tides of
  // Darkness chapter's units the campaign's Agld Gld1 (99000).
  const f = file("units", 8, 11);
  const mine = { ...(newEntry(f, "ngol", [0, 0, 0], 27, "w3u") as unknown as Record<string, unknown>), gold: 15000 };
  f.list.push(mine as unknown as Placed);
  assert.equal((newEntry(file("units", 8, 11), "hfoo", [0, 0, 0], 0, "w3u") as unknown as { gold: number }).gold, 12500, "a blank one");
  assert.equal((newEntry(f, "hfoo", [0, 0, 0], 0, "w3u") as unknown as { gold: number }).gold, 12500, "copied from a mine with its own amount");
  assert.equal((newEntry(f, "ngol", [0, 0, 0], 27, "w3u") as unknown as { gold: number }).gold, 12500, "a mine copied from one with 15000");
  assert.equal((newEntry(f, "hfoo", [0, 0, 0], 0, "w3u", 99000) as unknown as { gold: number }).gold, 99000);
  assert.equal((newEntry(f, "sloc", [0, 0, 0], 0, "w3u", 99000) as unknown as { gold: number }).gold, 0, "a start location");
  assert.equal((newEntry(f, "ratc", [0, 0, 0], 0, "w3t", 99000) as unknown as { gold: number }).gold, 0, "an item");
  // A copy keeps the copied unit's gold.
  assert.equal((pastedEntry(f, { entry: mine, angle: 0 }, [64, 0, 0]) as unknown as { gold: number }).gold, 15000);
});

test("startGoldOf: Agld's Gld1 at level 1, a later file's winning, else 12500", () => {
  const agld = (value: unknown, level?: number, field = "Gld1") => ({ original: [{ base: "Agld", mods: [{ field, level, value }] }] });
  assert.equal(startGoldOf([]), DEFAULT_START_GOLD);
  assert.equal(DEFAULT_START_GOLD, 12500);
  assert.equal(startGoldOf([null, undefined, { original: [] }]), 12500);
  assert.equal(startGoldOf([agld(99000, 1)]), 99000);
  assert.equal(startGoldOf([agld(99000, 1), null, agld(35000, 1)]), 35000, "the map's over the campaign's");
  assert.equal(startGoldOf([agld(35000, 1), agld(1, 1, "Gld3")]), 35000, "another field");
  assert.equal(startGoldOf([agld(35000, 2)]), 12500, "another level");
  assert.equal(startGoldOf([agld(35000)]), 35000, "no level");
  for (const bad of [-1, 1.5, "35000", Number.NaN, 2 ** 31]) assert.equal(startGoldOf([agld(bad, 1)]), 12500, String(bad));
  assert.equal(startGoldOf([{ original: [{ base: "Abgm", mods: [{ field: "Gld1", level: 1, value: 5 }] }] }]), 12500, "another ability");
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

test("a start location and a gold mine go on the 64 grid, as the World Editor puts them", () => {
  // we-drive 2026-11-13 (tests/we-compare/mine-start-grid.json): what the editor saved after each placing or move.
  const at = (id: string, texture: [number, number] | null, x: number, y: number) => {
    const cells = unitGridCells(id, texture);
    return cells ? [onBuildingGrid(x, cells[0]), onBuildingGrid(y, cells[1])] : [x, y];
  };
  // A start location has no pathing texture, but stands on the grid of a 4×4 building all the same.
  assert.deepEqual(unitGridCells("sloc", null), [4, 4]);
  assert.deepEqual(at("sloc", null, -1899.459, 500.25296), [-1920, 512], "placed from the palette");
  assert.deepEqual(at("sloc", null, -2141, 675 + 64), [-2112, 768], "nudged up once from -2141, 675");
  assert.deepEqual(at("sloc", null, -2000, 900), [-1984, 896], "Alt-moved");
  // A gold mine by its 16×16 pathing texture (PathTextures\16x16Goldmine.tga).
  assert.deepEqual(at("ngol", [16, 16], 1000 + 64, 300), [1088, 320], "nudged right once from 1000, 300");
  assert.deepEqual(at("ngol", [16, 16], 1088, 320 + 64), [1088, 384], "then up");
  // Control: a unit without a texture stays where it is put (the editor placed a Phoenix Egg at -1899.459, 500.25296).
  assert.equal(unitGridCells("hpxe", null), null);
  assert.deepEqual(at("hpxe", null, -1899.459, 500.25296), [-1899.459, 500.25296]);
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

// we-drive 2026-11-12 (branch paste-anchor-we): barrels (LTbs) on a flat map, copied (one, or a box of them) and
// pasted with Ctrl+V and a click, the pointer read from the status bar, the result from the saved war3map.doo. The
// first row is verify round 2's C7 (crates, barrels and rocks). The middle of the extent rounded to 32 (Studio's old
// rule) gets eight of the nine wrong, the same on the 64 grid five, the mean with half-way values away from 0 three;
// the mean on the 64 grid, half-way values up, gets them all. The editor also moves each doodad onto its own grid
// when the map loads (a barrel to 64n + 32, a crate to 64n): the copied positions are those it saved.
const WE_PASTES: { copied: [number, number][]; pointer: [number, number]; pasted: [number, number][] }[] = [
  { copied: [[-640, -128], [-352, -96], [-640, 128], [-384, 128]], pointer: [354, -573.4], pasted: [[256, -704], [544, -672], [256, -448], [512, -448]] },
  { copied: [[-992, 544]], pointer: [-570.7, -568.2], pasted: [[-608, -608]] },
  { copied: [[-800, 544]], pointer: [-219.6, -694.4], pasted: [[-224, -736]] },
  { copied: [[-608, 800], [-352, 864]], pointer: [232.2, -619.5], pasted: [[96, -672], [352, -608]] },
  { copied: [[224, 800], [224, 800], [608, 800]], pointer: [550.2, -814.1], pasted: [[416, -864], [416, -864], [800, -864]] },
  { copied: [[-992, 608], [-928, 608], [-608, 672]], pointer: [-492.7, -860.3], pasted: [[-672, -864], [-608, -864], [-288, -800]] },
  { copied: [[-992, 608], [-928, 608], [-608, 672]], pointer: [-98.7, -1077.8], pasted: [[-288, -1120], [-224, -1120], [96, -1056]] },
  { copied: [[160, 608], [224, 608], [288, 608], [608, 736]], pointer: [357.5, -462.2], pasted: [[224, -480], [288, -480], [352, -480], [672, -352]] },
  { copied: [[160, 608], [224, 608], [288, 608], [608, 736]], pointer: [834.9, -1036], pasted: [[672, -1056], [736, -1056], [800, -1056], [1120, -928]] },
];

test("a pasted group lands where the World Editor puts it: its mean and the pointer on the 64 grid", () => {
  for (const { copied, pointer, pasted } of WE_PASTES) {
    const f = fragmentOf(copied.map(([x, y]) => ({ list: "doodads" as const, entry: { position: [x, y, 0], angle: 0 } })), () => 0, copyCentre(copied));
    const [cx, cy] = pasteCentreAt(...pointer);
    assert.deepEqual(f.objects.map((o) => [cx + o.at[0], cy + o.at[1]]), pasted, `${JSON.stringify(copied)} at ${pointer}`);
  }
});

test("the paste grid takes half-way values up and never gives -0", () => {
  assert.deepEqual(copyCentre([[-992, 544]]), [-960, 576], "-15.5 and 8.5 cells");
  assert.deepEqual(copyCentre([[-608, 800], [-352, 864]]), [-448, 832], "-7.5 cells");
  assert.ok(Object.is(pasteCentreAt(-10, -31)[0], 0) && Object.is(pasteCentreAt(-10, -31)[1], 0));
  assert.deepEqual(pasteCentreAt(31.9, 32), [0, 64]);
});
