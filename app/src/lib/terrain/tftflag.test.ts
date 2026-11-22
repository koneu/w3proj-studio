import assert from "node:assert/strict";
import { test } from "node:test";
import { meleeFiles, readTypeVersions, savedMelee, type MeleeFiles } from "./meleesave";
import { placedNeedTft, REQUIRES_TFT, TFT_UNITS_SUBVERSION, tftFlagsAfter, tftUnitsLayout, typeVersions } from "./tftflag";
import { fakeReadTriggers } from "../testhelpers/triggers";

/** UnitData.slk: a footman (0), a tavern (1), a Reforged unit (2); ItemData.slk: an item of version 0 and one of 1. */
const UNITS = 'ID;PWXL;N;E\nC;Y1;X1;K"unitID"\nC;X2;K"version"\nC;Y2;X1;K"hfoo"\nC;X2;K0\nC;Y3;X1;K"ntav"\nC;X2;K1\nC;Y4;X1;K"sfoo"\nC;X2;K2\nC;Y5;X1;K"ngol"\nC;X2;K0\nE\n';
const ITEMS = 'ID;PWXL;N;E\nC;Y1;X1;K"itemID"\nC;X2;K"version"\nC;Y2;X1;K"ratc"\nC;X2;K0\nC;Y3;X1;K"shas"\nC;X2;K1\nE\n';
const GAME: Record<string, string> = { "Units\\UnitData.slk": UNITS, "Units\\ItemData.slk": ITEMS };
const VERSIONS = new Map([["hfoo", 0], ["ntav", 1], ["sfoo", 2], ["ngol", 0], ["ratc", 0], ["shas", 1]]);

const at = (id: string, player = 24) => ({ id, player, position: [1000, 1000, 0] });
const start = { id: "sloc", player: 0, position: [0, 0, 0] };

test("the placed units and items of version 1 or 2 need The Frozen Throne's data, as the World Editor's save measured", () => {
  // we-drive 2026-11-17, tests/we-compare/tft-flag-we.json: tavern, creep (v1), a Reforged unit (v2), an item (v1) set
  // 0x4000; a unit of version 0 doesn't; nothing placed of version 1 clears it.
  assert.equal(placedNeedTft([start, at("ntav", 27)], VERSIONS), true, "a tavern");
  assert.equal(placedNeedTft([start, at("sfoo")], VERSIONS), true, "a unit of version 2");
  assert.equal(placedNeedTft([start, at("shas", 27)], VERSIONS), true, "an item of version 1");
  assert.equal(placedNeedTft([start, at("hfoo"), at("ratc")], VERSIONS), false, "control: version 0 only");
  assert.equal(placedNeedTft([start], VERSIONS), false, "a start location alone");
  assert.equal(placedNeedTft([], VERSIONS), false, "nothing placed");
  // Not known: a type the tables don't have (a custom unit, a random one), no tables.
  assert.equal(placedNeedTft([start, at("h000")], VERSIONS), null, "a custom unit");
  assert.equal(placedNeedTft([start, at("uDNR")], VERSIONS), null, "a random unit");
  assert.equal(placedNeedTft([start, at("h000"), at("ntav")], VERSIONS), true, "a tavern beside an unknown");
  assert.equal(placedNeedTft([{ id: undefined }], VERSIONS), null, "an entry without an id");
  assert.equal(placedNeedTft([start, at("hfoo")], null), null, "no tables");
  assert.equal(placedNeedTft([start, at("ntav")], undefined), null, "no tables, even for a tavern");
});

test("an item of version 1 in a unit's drop sets counts; a random item doesn't", () => {
  const drops = (...ids: string[]) => ({ ...at("hfoo"), itemSets: [ids.map((id) => ({ id, chance: 100 }))] });
  // tft-drop and tft-drop-random (we-drive 2026-11-17); the game's melee maps with rman, rreb or gold in their drops
  // keep it (corpus).
  assert.equal(placedNeedTft([start, drops("shas")], VERSIONS), true, "a drop of version 1");
  assert.equal(placedNeedTft([start, drops("YjI5")], VERSIONS), false, "a random item: not a reason");
  assert.equal(placedNeedTft([start, drops("ratc", "YkI2")], VERSIONS), false, "control: version 0 and random");
  assert.equal(placedNeedTft([start, drops("I000")], VERSIONS), null, "a custom item");
  assert.equal(placedNeedTft([start, { ...at("hfoo"), itemSets: 3 }], VERSIONS), null, "drop sets of another shape");
  assert.equal(placedNeedTft([start, { ...at("hfoo"), itemSets: [[{ chance: 5 }]] }], VERSIONS), null, "a drop without an id");
});

test("a destructable's drops count; a hero's inventory and an item table nothing uses don't", () => {
  // we-drive 2026-11-20 (branch we-batch-3), tft-flag-we.json tft-dest-drop(-v0), tft-inventory(-clear),
  // tft-item-table(-clear): the editor's save set the flag for shas in a crate's drops, not for ratc there, and neither
  // set nor kept it for shas in a Paladin's inventory or in an unused item table.
  const crate = (...ids: string[]) => ({ id: "LTcr", position: [0, 0, 0], itemTable: -1, itemSets: [ids.map((id) => ({ id, chance: 100 }))] });
  const table = [{ number: 0, sets: [[{ id: "shas", chance: 100 }]] }];
  assert.equal(placedNeedTft([start], VERSIONS, undefined, [crate("shas")]), true, "a destructable's drop of version 1");
  assert.equal(placedNeedTft([start], VERSIONS, undefined, [crate("ratc")]), false, "control: of version 0");
  assert.equal(placedNeedTft([start], VERSIONS, undefined, [crate("YjI5")]), false, "a random item");
  assert.equal(placedNeedTft([start], VERSIONS, undefined, [crate("I000")]), null, "a custom item");
  assert.equal(placedNeedTft([start], VERSIONS, undefined, [{ id: "LTbr", itemSets: [] }]), false, "a destructable of version 1 itself isn't a reason");
  assert.equal(placedNeedTft([start], VERSIONS, undefined, [{ ...crate(), itemSets: 3 }]), null, "drop sets of another shape");
  assert.equal(placedNeedTft([start], VERSIONS, undefined, null), null, "a doodad file that can't be read");
  assert.equal(placedNeedTft([start, at("ntav")], VERSIONS, undefined, null), true, "a tavern decides anyway");
  assert.equal(placedNeedTft([start], VERSIONS, undefined, []), false, "no doodads");
  assert.equal(placedNeedTft([start, { ...at("Hpal"), inventory: [{ slot: 0, id: "shas" }] }], new Map([...VERSIONS, ["Hpal", 0]])), false, "an inventory item of version 1");
  assert.equal(placedNeedTft([start], VERSIONS, table), false, "an item table nothing uses");
  assert.equal(placedNeedTft([start], VERSIONS, [{ number: 0 }]), false, "an unused item table of another shape");
  // A table a unit or destructable uses isn't measured: can't be told unless it holds only types of version 0.
  assert.equal(placedNeedTft([start, { ...at("hfoo"), itemTable: 0 }], VERSIONS, table), null, "a used table holding shas");
  assert.equal(placedNeedTft([start], VERSIONS, table, [{ ...crate(), itemTable: 0 }]), null, "a used table, by a destructable");
  assert.equal(placedNeedTft([start, { ...at("hfoo"), itemTable: 0 }], VERSIONS, [{ number: 0, sets: [[{ id: "ratc", chance: 100 }]] }]), false, "control: of version 0");
  assert.equal(placedNeedTft([start, { ...at("hfoo"), itemTable: 0 }], VERSIONS, [{ number: 0 }]), null, "a used table without sets");
});

test("the flag follows: set, cleared, or left when it can't be told", () => {
  const F = 0x9c14;
  assert.equal(tftFlagsAfter(F, true), F | REQUIRES_TFT);
  assert.equal(tftFlagsAfter(F | REQUIRES_TFT, false), F);
  assert.equal(tftFlagsAfter(F | REQUIRES_TFT, null), F | REQUIRES_TFT);
  assert.equal(tftFlagsAfter(F, null), F);
  assert.equal(tftFlagsAfter(F | REQUIRES_TFT, false, false), F | REQUIRES_TFT, "not cleared unless it may");
  assert.equal(tftFlagsAfter(F, true, false), F | REQUIRES_TFT, "set anyway");
});

test("the versions come from the game's unit and item tables; unreadable ones are not known", async () => {
  const ws = (game: Record<string, string> | null): Pick<MeleeFiles, "gameText"> => ({
    gameText: game ? async (p: string) => { if (!(p in game)) throw new Error(p); return game[p]; } : undefined,
  });
  assert.deepEqual(await readTypeVersions(ws(GAME)), VERSIONS);
  assert.equal(await readTypeVersions(ws(null)), null, "no game");
  assert.equal(await readTypeVersions(ws({ "Units\\UnitData.slk": UNITS })), null, "ItemData.slk missing");
  assert.equal(await readTypeVersions(ws({ ...GAME, "Units\\UnitData.slk": "" })), null, "an empty UnitData.slk");
  assert.equal(await readTypeVersions(ws({ ...GAME, "Units\\ItemData.slk": 'ID;PWXL;N;E\nC;Y1;X1;K"itemID"\nC;Y2;X1;K"ratc"\nE\n' })), null, "items without versions");
  assert.deepEqual(typeVersions([{ unitID: "a", version: "" }, { unitID: "b", version: "x" }, { unitID: "c", version: "1" }], "unitID"), new Map([["c", 1]]));
});

test("the app's game tables are read once per game; a failed read is tried again", async () => {
  let reads = 0, fail = true;
  const game = { readText: async (p: string) => { reads++; if (fail) throw new Error("EIO"); return GAME[p]; }, read: async () => new Uint8Array() };
  const w3 = { workspace: {} as never, game: game as never };
  assert.equal(await readTypeVersions(meleeFiles(w3)), null, "unreadable");
  fail = false;
  assert.deepEqual(await readTypeVersions(meleeFiles(w3)), VERSIONS, "read again after the failure");
  const after = reads;
  assert.deepEqual(await readTypeVersions(meleeFiles(w3)), VERSIONS);
  assert.equal(reads, after, "kept: not read again");
});

test("a save sets and clears 0x4000 on melee maps and others alike, through savedMelee", async () => {
  const project = (game: Record<string, string> | null = GAME, own: Record<string, string | Error> = {}): MeleeFiles => ({
    files: () => Object.keys(own).map((path) => ({ path })),
    readText: async (p) => { const v = own[p]; if (typeof v !== "string") throw v ?? new Error(`not found: ${p}`); return v; },
    readBytes: async (p) => { throw new Error(`not found: ${p}`); },
    readTriggers: fakeReadTriggers((p) => { const v = own[p]; if (v instanceof Error) throw v; return v; }),
    gameText: game ? async (p: string) => { if (!(p in game)) throw new Error(p); return game[p]; } : undefined,
  });
  const MELEE = 0x9c14, NOT = MELEE & ~4;
  assert.equal((await savedMelee(project(), { flags: MELEE }, [start, at("ntav", 27)])).flags, MELEE | REQUIRES_TFT, "melee map, tavern");
  assert.equal((await savedMelee(project(), { flags: MELEE | REQUIRES_TFT }, [start])).flags, MELEE, "melee map, nothing of version 1");
  // A map that isn't melee, for a reason war3map.w3i or the units tell (a player's footman): nothing of the project read.
  assert.equal((await savedMelee(project(), { flags: NOT }, [start, at("hfoo", 0), at("ntav", 27)])).flags, NOT | REQUIRES_TFT, "not melee, tavern");
  assert.equal((await savedMelee(project(), { flags: NOT | REQUIRES_TFT }, [start, at("hfoo", 0)])).flags, NOT, "not melee, version 0");
  const r = await savedMelee(project(), { flags: MELEE }, [start, at("ntav", 27)]);
  assert.deepEqual(r.reasons, [], "the Melee flag isn't touched by it");
  assert.equal((await savedMelee(project(null), { flags: MELEE | REQUIRES_TFT }, [start])).flags, MELEE | REQUIRES_TFT, "no game: left");
  assert.equal((await savedMelee(project(null), { flags: MELEE }, [start, at("ntav", 27)])).flags, MELEE, "no game: left off");
  assert.equal((await savedMelee(project(), { flags: MELEE | REQUIRES_TFT }, [start, at("h000")])).flags, MELEE | REQUIRES_TFT, "a custom unit: left");
  // (12)WormWar: nothing of version 1 placed, custom units, abilities, buffs and triggers: the World Editor's save kept
  // the flag, for its abilities and buffs. we-compare corpus-saves (2026-11-20): ability, buff and upgrade data, custom
  // or a changed original, set the flag; a custom unit (based on Ucrl or hfoo) and item, destructable and doodad data
  // let it clear. For melee maps and others alike.
  const objects = (original: unknown[], custom: unknown[]) => JSON.stringify({ format: "w3proj.objects/1", version: 2, original, custom });
  const tftOf = async (flags: number, only: typeof start[], own: Record<string, string | Error>) => (await savedMelee(project(GAME, own), { flags }, only)).flags & REQUIRES_TFT;
  for (const flags of [MELEE, NOT]) {
    const only = flags === NOT ? [start, at("hfoo", 0)] : [start];
    const hex = flags.toString(16);
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3map.w3u.json": objects([], [{ id: "U000", base: "Ucrl", mods: [] }]) }), 0, `a custom unit based on Ucrl: cleared (${hex})`);
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3map.w3t.json": objects([], [{ id: "I000", base: "ratc", mods: [] }]), "map/war3mapSkin.w3d.json": objects([{ base: "LWw0", mods: [] }], []) }), 0, `item data and a doodad skin entry: cleared (${hex})`);
    assert.equal(await tftOf(flags, only, { "map/war3map.w3a.json": objects([], [{ id: "A000", base: "AHhb", mods: [] }]) }), REQUIRES_TFT, `a custom ability sets it (${hex})`);
    assert.equal(await tftOf(flags, only, { "map/war3map.w3a.json": objects([{ base: "AHhb", mods: [{ field: "anam" }] }], []) }), REQUIRES_TFT, `a changed original ability sets it (${hex})`);
    assert.equal(await tftOf(flags, only, { "map/war3map.w3h.json": objects([], [{ id: "B000", base: "BHbd", mods: [] }]) }), REQUIRES_TFT, `a custom buff sets it (${hex})`);
    assert.equal(await tftOf(flags, only, { "map/war3map.w3q.json": objects([{ base: "Rhme", mods: [] }], []) }), REQUIRES_TFT, `upgrade data sets it (${hex})`);
    assert.equal(await tftOf(flags, only, { "map/war3map.w3q.json": objects([], []) }), 0, `control: an empty upgrade file doesn't (${hex})`);
    // A custom game interface lets it clear (WormWar's war3mapSkin.txt, corpus-saves-wormwar-noobj).
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3mapSkin.txt": "[FrameDef]\nQUESTSMAIN=x\n" }), 0, `a custom game interface: cleared (${hex})`);
    // Not measured, so left as it is: ability data only in a skin file.
    assert.equal(await tftOf(flags, only, { "map/war3mapSkin.w3a.json": objects([{ base: "AHhb", mods: [] }], []) }), 0, `a skin entry of an ability: not set (${hex})`);
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3mapSkin.w3a.json": objects([{ base: "AHhb", mods: [] }], []) }), REQUIRES_TFT, `nor cleared (${hex})`);
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3map.w3u.json": "{" }), REQUIRES_TFT, `unreadable object data keeps it (${hex})`);
    assert.equal(await tftOf(flags, only, { "map/war3map.w3a.json": "{" }), 0, `unreadable ability data doesn't set it (${hex})`);
    assert.equal((await savedMelee(project(GAME, { "map/triggers/triggers.json": new Error("EACCES") }), { flags: flags | REQUIRES_TFT }, only)).flags & REQUIRES_TFT, REQUIRES_TFT, `unreadable triggers keep it (${flags.toString(16)})`);
    assert.equal((await savedMelee(project(GAME, {}), { flags: flags | REQUIRES_TFT }, only)).flags & REQUIRES_TFT, 0, `control: neither, cleared (${flags.toString(16)})`);
    // war3map.doo's drops (tft-dest-drop, branch we-batch-3): read from the project; a raw or unreadable file can't be told.
    const doo = (id: string) => JSON.stringify({ doodads: [{ id: "LTcr", position: [0, 0, 0], itemTable: -1, itemSets: [[{ id, chance: 100 }]] }], specials: [] });
    assert.equal(await tftOf(flags, only, { "map/war3map.doo.json": doo("shas") }), REQUIRES_TFT, `a crate dropping shas sets it (${hex})`);
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3map.doo.json": doo("ratc") }), 0, `control: dropping ratc, cleared (${hex})`);
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3map.doo.json": "{" }), REQUIRES_TFT, `an unreadable doodad file keeps it (${hex})`);
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3map.doo.json": new Error("EACCES") }), REQUIRES_TFT, `a doodad file that can't be read keeps it (${hex})`);
    assert.equal(await tftOf(flags | REQUIRES_TFT, only, { "map/war3map.doo": "raw" }), REQUIRES_TFT, `a raw doodad file keeps it (${hex})`);
  }
});

test("a units file of subversion 9 takes the layout with item tables and hero attributes, as the editor's save with 0x4000", () => {
  // The editor's save of building-turn-tavern.w3m: every entry (start location, footman, tavern) with item table -1 and
  // attributes 0, nothing else changed (we-drive 2026-11-20).
  const doc = { version: 8, subversion: 9, units: [{ id: "sloc", hp: -1 }, { id: "hfoo", hp: -1 }, { id: "ntav", hp: 0 }] };
  assert.equal(tftUnitsLayout(doc), true);
  assert.equal(doc.subversion, TFT_UNITS_SUBVERSION);
  for (const u of doc.units) assert.deepEqual(u, { id: u.id, hp: u.hp, itemTable: -1, strength: 0, agility: 0, intelligence: 0 });
  // A file of 11 is left as it is (its tables and attributes kept), and so is one already upgraded.
  const eleven = { subversion: 11, units: [{ id: "Hpal", itemTable: 2, strength: 22 }] };
  assert.equal(tftUnitsLayout(eleven), false);
  assert.deepEqual(eleven, { subversion: 11, units: [{ id: "Hpal", itemTable: 2, strength: 22 }] });
  assert.equal(tftUnitsLayout(doc), false);
  // Not a list of entries: nothing is changed, not even the subversion.
  const odd = { subversion: 9, units: [{ id: "hfoo" }, 7] };
  assert.equal(tftUnitsLayout(odd), false);
  assert.deepEqual(odd, { subversion: 9, units: [{ id: "hfoo" }, 7] });
});
