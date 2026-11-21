import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { copyCentre, DEFAULT_START_GOLD, loadPlacedFile, newEntry, onBuildingGrid, pastedEntry, pasteCentreAt, savePlacedFile, startGoldOf, unitGridCells, type PlacedFile } from "./placement";
import { fragmentOf } from "../../lib/terrain/fragment";
import { doodadOnGrid } from "./doodadgrid";
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

test("entries made before any is inserted get one number each (a scatter fill), and an undone one's isn't given again", () => {
  const units = file("units", 8, 11);
  units.list.push(newEntry(units, "hfoo", [0, 0, 0], 0, "w3u"));
  const fill = [0, 1, 2].map((i) => newEntry(units, "uDNR", [64 * i, 0, 0], 0, "w3u") as unknown as { editorId: number });
  assert.deepEqual(fill.map((e) => e.editorId), [1, 2, 3]);
  // Taken out again (an undo), its numbers stay used: a redo puts the same objects back.
  const later = newEntry(units, "hfoo", [0, 0, 0], 0, "w3u") as unknown as { editorId: number };
  assert.equal(later.editorId, 4);
  const doodads = file("doodads", 13, 11);
  const trees = [0, 1, 2].map(() => newEntry(doodads, "LTlt", [0, 0, 0]) as unknown as { trailer: number[]; editorId: number });
  assert.deepEqual(trees.map((t) => t.trailer[0]), [0, 1, 2]);
  assert.ok(trees.every((t) => t.editorId === 0xffffffff), "a v13 doodad's editorId stays unset");
  // A number already in the file above what was handed out still counts.
  units.list.push({ ...(newEntry(units, "hfoo", [0, 0, 0], 0, "w3u") as object), editorId: 40 } as unknown as Placed);
  assert.equal((newEntry(units, "hfoo", [0, 0, 0], 0, "w3u") as unknown as { editorId: number }).editorId, 41);
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

// we-drive 2026-11-15 (branch paste-centre-we, tests/we-compare/paste-centre.json's input, SD): one object or a box of
// them copied and pasted at an off-grid pointer, the pointer read from a lone pathless LPcr pasted at the same pixel
// first (it lands where the pointer is), the rest from the saved files. The copied positions are as the editor saved
// them (doodads on their grids, the farms where the map put them). Grids: LTbs and LOsh 2x2 (64n + 32), LTlt and the
// farm hhou 4x4 (64n); LPcr, the footman and the item ratf have none.
type Kind = "free" | "2x2" | "4x4" | "farm";
const WE_MIXED: { name: string; copied: [Kind, number, number][]; pointer: [number, number]; pasted: [number, number][] }[] = [
  { name: "LPcr", copied: [["free", -901.3, 1013.7]], pointer: [-976.718, 291.992], pasted: [[-976.718, 291.992]] },
  { name: "LTbs", copied: [["2x2", -480, 992]], pointer: [-716.028, 291.992], pasted: [[-736, 288]] },
  { name: "LTlt", copied: [["4x4", -128, 1024]], pointer: [-455.339, 291.992], pasted: [[-448, 320]] },
  { name: "LOsh", copied: [["2x2", 288, 992]], pointer: [-194.649, 291.992], pasted: [[-224, 288]] },
  { name: "LTbs + LPcr", copied: [["2x2", -928, 672], ["free", -783.6, 701.2]], pointer: [66.042, 291.992], pasted: [[-32, 288], [112.4, 317.2]] },
  { name: "LPcr + LPcr", copied: [["free", -405.1, 640.3], ["free", -291.7, 688.9]], pointer: [326.731, 291.992], pasted: [[270.031, 267.692], [383.432, 316.292]] },
  { name: "LOsh + LTlt", copied: [["2x2", 96, 672], ["4x4", 256, 640]], pointer: [587.421, 291.992], pasted: [[480, 352], [640, 320]] },
  { name: "LTbs + LTlt", copied: [["2x2", 608, 672], ["4x4", 704, 640]], pointer: [848.111, 291.992], pasted: [[800, 352], [896, 320]] },
  { name: "hfoo", copied: [["free", -900.4, -650.6]], pointer: [-929.307, -203.811], pasted: [[-929.307, -203.811]] },
  { name: "ratf", copied: [["free", -550.2, -640.9]], pointer: [-508.367, -203.811], pasted: [[-508.367, -203.811]] },
  { name: "hhou", copied: [["farm", -200, -650]], pointer: [-87.426, -203.811], pasted: [[-64, -192]] },
  // The farm counts at 320, -640 (its grid): from 290 the group's mean would round to 192 and the footman land at 278.7.
  { name: "hfoo + hhou", copied: [["free", 150.7, -650.3], ["farm", 290, -650]], pointer: [333.515, -203.811], pasted: [[214.7, -202.3], [384, -192]] },
  { name: "hfoo + ratf", copied: [["free", 600.9, -650.2], ["free", 700.3, -610.7]], pointer: [754.455, -203.811], pasted: [[704.755, -223.561], [804.155, -184.061]] },
];

test("pastes of pathless, gridded and mixed groups land where the World Editor puts them", () => {
  const SIZES = { "2x2": { width: 2, height: 2 }, "4x4": { width: 4, height: 4 } } as const;
  // Each object's own grid, as the terrain viewer's ruledPose (doodads) and onGrid (units) give it.
  const own = (kind: Kind, x: number, y: number): [number, number] => {
    if (kind === "free") return [x, y];
    if (kind === "farm") return [onBuildingGrid(x, 4), onBuildingGrid(y, 4)];
    const at = doodadOnGrid(x, y, (270 * Math.PI) / 180, SIZES[kind]);
    return [at.x, at.y];
  };
  // The editor's numbers are single precision, written here to three places.
  const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
  for (const { name, copied, pointer, pasted } of WE_MIXED) {
    const free = copied.every(([kind]) => kind === "free");
    const f = fragmentOf(copied.map(([, x, y]) => ({ list: "doodads" as const, entry: { position: [x, y, 0], angle: 0 } })), () => 0,
      copyCentre(copied.map(([kind, x, y]) => own(kind, x, y)), free));
    const [cx, cy] = pasteCentreAt(...pointer, free);
    const got = f.objects.map((o, i) => own(copied[i][0], cx + o.at[0], cy + o.at[1]));
    assert.ok(got.every(([x, y], i) => close(x, pasted[i][0]) && close(y, pasted[i][1])), `${name}: ${JSON.stringify(got)}, the editor ${JSON.stringify(pasted)}`);
  }
});

test("the paste grid takes half-way values up and never gives -0", () => {
  assert.deepEqual(copyCentre([[-992, 544]]), [-960, 576], "-15.5 and 8.5 cells");
  assert.deepEqual(copyCentre([[-608, 800], [-352, 864]]), [-448, 832], "-7.5 cells");
  assert.ok(Object.is(pasteCentreAt(-10, -31)[0], 0) && Object.is(pasteCentreAt(-10, -31)[1], 0));
  assert.deepEqual(pasteCentreAt(31.9, 32), [0, 64]);
});

const emptyV8 = (key: "doodads" | "units", skinIds: boolean) => JSON.stringify({
  format: key === "doodads" ? "w3proj.doodads/1" : "w3proj.units/1",
  magic: "W3do",
  version: 8,
  subversion: 11,
  skinIds,
  [key]: [],
  ...(key === "doodads" ? { specialVersion: 0, specials: [] } : {}),
});

function mockWorkspace(files: Record<string, string>, raw?: Record<string, string>, root = "/maps/M") {
  const written: Record<string, string> = {};
  const list = [
    ...Object.keys(files).map((path) => ({ path })),
    ...Object.keys(raw ?? {}).map((path) => ({ path })),
  ];
  let currentRoot = root;
  const w3 = {
    workspace: {
      files: () => list,
      readText: async (path: string) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`);
        return files[path];
      },
      writeText: async (path: string, text: string) => { written[path] = text; },
      project: () => ({ root: currentRoot }),
    },
    backend: {
      invoke: async (cmd: string, args: { path?: string; text?: string }) => {
        if (cmd === "codec_decode") {
          if (args.path && raw && args.path in raw) return raw[args.path];
          throw new Error(`decode failed: ${args.path}`);
        }
        if (cmd === "codec_canonicalize") return args.text;
        throw new Error(`unexpected cmd: ${cmd}`);
      },
    },
  } as unknown as W3Api;
  return { w3, written, setRoot: (next: string) => { currentRoot = next; } };
}

test("empty v8 files with stale skinIds: true resolve to false on pre-Reforged maps and omit skinId", async () => {
  for (const [label, ed] of [["v25 ed=6059", 6059], ["v28 ed=6088", 6088]] as const) {
    const { w3 } = mockWorkspace({
      "map/war3map.w3i.json": JSON.stringify({ version: 25, editorVersion: ed }),
      "map/war3mapUnits.doo.json": emptyV8("units", true),
      "map/war3map.doo.json": emptyV8("doodads", true),
    });
    const units = (await loadPlacedFile(w3, "war3mapUnits.doo", "units"))!;
    const doodads = (await loadPlacedFile(w3, "war3map.doo", "doodads"))!;
    assert.equal(units.doc.skinIds, false, label);
    assert.equal(doodads.doc.skinIds, false, label);
    const sloc = newEntry(units, "sloc", [0, 0, 0], 0) as unknown as Record<string, unknown>;
    const tree = newEntry(doodads, "LTlt", [0, 0, 0]) as unknown as Record<string, unknown>;
    const pasted = pastedEntry(units, { entry: { id: "hfoo", skinId: "hfoo", variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1] }, angle: 0 }, [64, 0, 0]) as unknown as Record<string, unknown>;
    assert.ok(!("skinId" in sloc), `${label}: sloc`);
    assert.ok(!("skinId" in tree), `${label}: tree`);
    assert.ok(!("skinId" in pasted), `${label}: pasted`);
  }

  // Raw war3map.w3i works too, and editPlaced's read callback uses unsaved buffer text.
  const { w3: rawW3 } = mockWorkspace(
    { "map/war3mapUnits.doo.json": emptyV8("units", true) },
    { "map/war3map.w3i": JSON.stringify({ version: 25, editorVersion: 6059 }) },
  );
  const rawUnits = (await loadPlacedFile(rawW3, "war3mapUnits.doo", "units"))!;
  assert.equal(rawUnits.doc.skinIds, false);
  assert.ok(!("skinId" in (newEntry(rawUnits, "sloc", [0, 0, 0], 0) as unknown as Record<string, unknown>)));
});

test("empty v8 files on Reforged maps (editorVersion >= 6089) resolve skinIds: true and include skinId", async () => {
  for (const ed of [6089, 6117]) {
    const { w3 } = mockWorkspace({
      "map/war3map.w3i.json": JSON.stringify({ version: 33, editorVersion: ed }),
      "map/war3mapUnits.doo.json": emptyV8("units", false),
      "map/war3map.doo.json": emptyV8("doodads", false),
    });
    const units = (await loadPlacedFile(w3, "war3mapUnits.doo", "units"))!;
    const doodads = (await loadPlacedFile(w3, "war3map.doo", "doodads"))!;
    assert.equal(units.doc.skinIds, true, `ed=${ed}`);
    assert.equal(doodads.doc.skinIds, true, `ed=${ed}`);
    const sloc = newEntry(units, "sloc", [0, 0, 0], 0) as unknown as Record<string, unknown>;
    const tree = newEntry(doodads, "LTlt", [0, 0, 0]) as unknown as Record<string, unknown>;
    const pasted = pastedEntry(units, { entry: { id: "hfoo", variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1] }, angle: 0 }, [64, 0, 0]) as unknown as Record<string, unknown>;
    assert.equal(sloc.skinId, "sloc");
    assert.equal(tree.skinId, "LTlt");
    assert.equal(pasted.skinId, "hfoo");
  }
});

test("non-empty v8 files follow entry layout and handle absent vs unreadable war3map.w3i", async () => {
  // Non-empty Reforged v8 file keeps skinIds: true even if war3map.w3i is unreadable (cut-off chapter).
  const refUnit = newEntry(file("units", 8, 11, { skinIds: true }), "hfoo", [0, 0, 0], 0);
  const { w3: tco } = mockWorkspace({
    "map/war3map.w3i.json": "{broken",
    "map/war3mapUnits.doo.json": JSON.stringify({ format: "w3proj.units/1", magic: "W3do", version: 8, subversion: 11, skinIds: true, units: [refUnit] }),
  });
  const refLoaded = (await loadPlacedFile(tco, "war3mapUnits.doo", "units"))!;
  assert.equal(refLoaded.doc.skinIds, true);
  assert.equal((newEntry(refLoaded, "hkni", [64, 0, 0], 0) as unknown as Record<string, unknown>).skinId, "hkni");

  // Non-empty pre-Reforged file whose only entries are randomType != 0 still omits skinId even with stale skinIds: true.
  const randUnit = { ...(newEntry(file("units", 8, 11, { skinIds: false }), "uDNR", [0, 0, 0]) as unknown as Record<string, unknown>), randomType: 1 };
  const { w3: staleRand } = mockWorkspace({
    "map/war3mapUnits.doo.json": JSON.stringify({ format: "w3proj.units/1", magic: "W3do", version: 8, subversion: 11, skinIds: true, units: [randUnit] }),
  });
  const randLoaded = (await loadPlacedFile(staleRand, "war3mapUnits.doo", "units"))!;
  assert.equal(randLoaded.doc.skinIds, false);
  assert.ok(!("skinId" in (newEntry(randLoaded, "hfoo", [0, 0, 0], 0) as unknown as Record<string, unknown>)));

  // Absent w3i on empty v8 -> false; unreadable w3i -> rejects (never silently false).
  const { w3: absent } = mockWorkspace({ "map/war3mapUnits.doo.json": emptyV8("units", true) });
  const absentLoaded = (await loadPlacedFile(absent, "war3mapUnits.doo", "units"))!;
  assert.equal(absentLoaded.doc.skinIds, false);

  for (const badW3i of ["{not json", "[]", JSON.stringify({ version: 25 })]) {
    const { w3: bad } = mockWorkspace({
      "map/war3map.w3i.json": badW3i,
      "map/war3mapUnits.doo.json": emptyV8("units", false),
    });
    await assert.rejects(loadPlacedFile(bad, "war3mapUnits.doo", "units"), /war3map\.w3i/);
  }
  const { w3: badRaw } = mockWorkspace({ "map/war3mapUnits.doo.json": emptyV8("units", false) }, { "map/war3map.w3i": "{corrupt" });
  await assert.rejects(loadPlacedFile(badRaw, "war3mapUnits.doo", "units"), /war3map\.w3i/);

  // Project switch while reading throws instead of applying another project's w3i.
  const sw = mockWorkspace({ "map/war3map.w3i.json": JSON.stringify({ version: 33, editorVersion: 6117 }), "map/war3mapUnits.doo.json": emptyV8("units", false) });
  const origRead = sw.w3.workspace.readText.bind(sw.w3.workspace);
  sw.w3.workspace.readText = async (p: string) => {
    const out = await origRead(p);
    if (p.includes("w3i")) sw.setRoot("/maps/OTHER");
    return out;
  };
  await assert.rejects(loadPlacedFile(sw.w3, "war3mapUnits.doo", "units"), /project changed/i);
});
