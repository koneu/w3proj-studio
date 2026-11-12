// The Skin object files (skin.ts): read with the main file, the Skin file's values winning, and split back so that
// what wasn't changed stays where it was and a changed field goes where the World Editor puts it (we-drive,
// 2026-11-12: netsafe fields such as names, icons and models into war3mapSkin.w3u, the rest into war3map.w3u).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta } from "../../lib/objects/metadata";
import type { EditFile, EditMod, EditObject } from "./objectedit";
import { isSkinField, listedPath, skinChanged, skinPathOf, skinWritable, splitSkin } from "./skin";
import { mergeSkin } from "./w3o";

const file = (custom: EditObject[], original: EditObject[] = [], version = 3): EditFile => ({ format: "w3proj.objects/1", version, original, custom });
const s = (field: string, value: string): EditMod => ({ field, type: "string", value });
const n = (field: string, value: number): EditMod => ({ field, type: "int", value });
/** The netsafe fields of these tests (UnitMetaData.slk: unam, uico, umdl, utip are 1; uhpm, uabi 0). */
const SKIN = new Set(["unam", "uico", "umdl", "utip", "atp1"]);
const opts = { toSkin: (f: string) => (f === "zzzz" ? undefined : SKIN.has(f)), skinWritable: true };
const merge = (main: EditFile | null, skin: EditFile | null) => mergeSkin(main ?? file([]), skin, { addSkinOnly: true });
const clone = <T>(x: T): T => structuredClone(x);

/** The Firebrand map's hero FXik as its two files have it. */
const FIREBRAND_MAIN = () => file([{ base: "Ekee", id: "FXik", mods: [s("urac", "human"), s("uabi", "AInv"), s("uhab", "AFso,AFfn")] }, { base: "nslr", id: "fxsl", mods: [n("umpm", 200)] }]);
const FIREBRAND_SKIN = () => file([
  { base: "Ekee", id: "FXik", mods: [s("umdl", "HeroSalamanderLord.mdl"), s("unam", "TRIGSTR_050"), s("uico", "ReplaceableTextures\\CommandButtons\\BTNInfernal Keeper Icon.dds")] },
  { base: "nslr", id: "fxsl", mods: [] },
]);

test("the merged view has the Skin file's name, model and icon, also where the main file sets them too", () => {
  const main = FIREBRAND_MAIN();
  main.custom[0].mods!.push(s("unam", "MainKeeper"), s("umdl", "MainModel.mdl"));
  const fx = merge(main, FIREBRAND_SKIN()).custom[0];
  const v = (f: string) => fx.mods!.find((m) => m.field === f)?.value;
  // As the World Editor shows and saves it (we-drive, 2026-11-12: "Infernal Keeper").
  assert.equal(v("unam"), "TRIGSTR_050");
  assert.equal(v("umdl"), "HeroSalamanderLord.mdl");
  assert.equal(v("uico"), "ReplaceableTextures\\CommandButtons\\BTNInfernal Keeper Icon.dds");
  assert.equal(v("uabi"), "AInv");
});

test("splitting unchanged objects gives both files back as they were", () => {
  const cases: [EditFile | null, EditFile | null][] = [
    [FIREBRAND_MAIN(), FIREBRAND_SKIN()],
    [FIREBRAND_MAIN(), null],
    [null, FIREBRAND_SKIN()],
    // A value in both files: the main file's hidden one stays too.
    [file([{ base: "hfoo", id: "h000", mods: [s("unam", "Main"), n("uhpm", 5)] }]), file([{ base: "hfoo", id: "h000", mods: [s("unam", "Skin")] }])],
    // Objects only the Skin file has, with and without fields; changed standard objects; the Skin file's own order.
    [file([{ base: "hfoo", id: "h000", mods: [] }, { base: "hpea", id: "h001", mods: [] }], [{ base: "hkni", mods: [n("uhpm", 9)] }]),
      file([{ base: "hpea", id: "h001", mods: [s("unam", "B")] }, { base: "hfoo", id: "h002", mods: [s("unam", "Skin only")] }, { base: "hfoo", id: "h003", mods: [] }, { base: "hfoo", id: "h000", mods: [s("unam", "A")] }], [{ base: "hkni", mods: [s("unam", "Knight")] }, { base: "hrif", mods: [s("unam", "Rifle")] }])],
    // Flagged sets (version 3) and levels; an end token of the Skin object's own.
    [file([{ base: "AHbz", id: "A000", sets: [{ flag: 0, mods: [{ field: "Hbz1", type: "int", level: 1, data: 1, value: 3 }] }, { flag: 2, mods: [] }] }]),
      file([{ base: "AHbz", id: "A000", end: "A111", sets: [{ flag: 0, mods: [{ field: "atp1", type: "string", level: 1, data: 0, value: "Tip" }] }, { flag: 2, mods: [{ field: "atp1", type: "string", level: 1, data: 0, value: "HD" }] }] }])],
    // Two objects of one id (a damaged map): each keeps its own fields.
    [file([{ base: "hfoo", id: "h000", mods: [n("uhpm", 1)] }, { base: "hfoo", id: "h000", mods: [n("uhpm", 2)] }]), file([{ base: "hfoo", id: "h000", mods: [s("unam", "one")] }, { base: "hfoo", id: "h000", mods: [s("unam", "two")] }])],
    // An object's keys in another order than the editor's (a hand-written file): they keep it.
    [file([{ base: "hfoo", id: "h000", mods: [n("uhpm", 1)], end: "h000" }], [], 1), file([{ id: "h000", mods: [s("unam", "x")], base: "hfoo" }], [], 1)],
  ];
  for (const [main, skin] of cases) {
    const out = splitSkin(merge(clone(main), clone(skin)), clone(main), clone(skin), opts);
    // As text: the same objects with their keys in another order would be a Skin file written again.
    assert.equal(JSON.stringify(out.main), JSON.stringify(main ?? file([])));
    assert.equal(JSON.stringify(out.skin), JSON.stringify(skin));
    assert.equal(skinChanged(skin, out.skin), false);
  }
});

test("an edited name goes into the Skin file, the main file stays as it was", () => {
  const merged = merge(FIREBRAND_MAIN(), FIREBRAND_SKIN());
  merged.custom[0].mods!.find((m) => m.field === "unam")!.value = "Renamed";
  const out = splitSkin(merged, FIREBRAND_MAIN(), FIREBRAND_SKIN(), opts);
  assert.deepEqual(out.main, FIREBRAND_MAIN());
  assert.deepEqual(out.skin!.custom[0].mods!.map((m) => [m.field, m.value]), [["umdl", "HeroSalamanderLord.mdl"], ["unam", "Renamed"], ["uico", FIREBRAND_SKIN().custom[0].mods![2].value]]);
  assert.equal(skinChanged(FIREBRAND_SKIN(), out.skin), true);
});

test("a changed field goes to the file it belongs in and leaves the other, as the World Editor's save puts it", () => {
  const main = file([{ base: "hfoo", id: "h000", mods: [s("unam", "Old"), n("uhpm", 5), s("uico", "a.blp")] }]);
  const skin = file([{ base: "hfoo", id: "h000", mods: [n("uhpm", 7), s("umdl", "m.mdl")] }]);
  const merged = merge(clone(main), clone(skin));
  const set = (f: string, v: string | number) => { merged.custom[0].mods!.find((m) => m.field === f)!.value = v; };
  set("unam", "New");
  set("uhpm", 9);
  const out = splitSkin(merged, main, skin, opts);
  // The name moves to the Skin file; the hit points (a main-file field the Skin file had) go to the main file; the
  // icon, unchanged, stays in the main file.
  assert.deepEqual(out.main.custom[0].mods!.map((m) => [m.field, m.value]), [["uhpm", 9], ["uico", "a.blp"]]);
  assert.deepEqual(out.skin!.custom[0].mods!.map((m) => [m.field, m.value]), [["umdl", "m.mdl"], ["unam", "New"]]);
  // A name hidden behind the Skin file's: changing it takes the main file's away too.
  const both = file([{ base: "hfoo", id: "h000", mods: [s("unam", "MainKeeper")] }]), skinBoth = file([{ base: "hfoo", id: "h000", mods: [s("unam", "TRIGSTR_050")] }]);
  const m2 = merge(clone(both), clone(skinBoth));
  m2.custom[0].mods![0].value = "Typed";
  const o2 = splitSkin(m2, both, skinBoth, opts);
  assert.deepEqual([o2.main.custom[0].mods, o2.skin!.custom[0].mods], [[], [s("unam", "Typed")]]);
});

test("where the Skin file can't take fields they stay in the main file, and an unknown field stays where it was", () => {
  const main = file([{ base: "hfoo", id: "h000", mods: [s("unam", "Old"), s("zzzz", "x")] }], [], 1);
  const merged = merge(clone(main), null);
  merged.custom[0].mods![0].value = "New";
  merged.custom[0].mods![1].value = "y";
  merged.custom[0].mods!.push(s("uico", "i.blp"));
  const out = splitSkin(merged, main, null, { ...opts, skinWritable: false });
  assert.deepEqual(out.main.custom[0].mods!.map((m) => m.value), ["New", "y", "i.blp"]);
  assert.equal(out.skin, null, "no Skin file is made");
  // Writable (a version-3 map): the name and icon go to a new Skin file, the unknown field stays.
  const w = splitSkin(clone(merged), { ...main, version: 3 }, null, opts);
  assert.deepEqual(w.main.custom[0].mods!.map((m) => m.field), ["zzzz"]);
  assert.deepEqual(w.skin, { format: "w3proj.objects/1", version: 1, original: [], custom: [{ base: "hfoo", id: "h000", mods: [s("unam", "New"), s("uico", "i.blp")] }] });
});

test("new, deleted and reset objects and fields reach both files", () => {
  const merged = merge(FIREBRAND_MAIN(), FIREBRAND_SKIN());
  // A new unit with a name; FXik deleted; fxsl's mana reset.
  merged.custom.push({ base: "hfoo", id: "h00A", mods: [s("unam", "Squire"), n("uhpm", 300)] });
  merged.custom.splice(0, 1);
  merged.custom[0].mods = [];
  merged.original.push({ base: "hpea", mods: [s("utip", "Tip")] }, { base: "hkni", mods: [] });
  const out = splitSkin(merged, FIREBRAND_MAIN(), FIREBRAND_SKIN(), opts);
  assert.deepEqual(out.main.custom, [{ base: "nslr", id: "fxsl", mods: [] }, { base: "hfoo", id: "h00A", mods: [n("uhpm", 300)] }]);
  assert.deepEqual(out.skin!.custom, [{ base: "nslr", id: "fxsl", mods: [] }, { base: "hfoo", id: "h00A", mods: [s("unam", "Squire")] }]);
  assert.deepEqual(out.main.original, [], "a standard object with nothing for the main file isn't written there");
  assert.deepEqual(out.skin!.original, [{ base: "hpea", mods: [s("utip", "Tip")] }]);
});

test("which fields belong in the Skin file comes from the metadata's netsafe column", () => {
  const meta = (netsafe?: string) => ({ id: "x", use: netsafe === undefined ? {} : { netsafe } }) as unknown as FieldMeta;
  assert.equal(isSkinField(meta("1")), true);
  assert.equal(isSkinField(meta("11")), true, "UnitMetaData has 11 for unsf and uepa");
  assert.equal(isSkinField(meta("0")), false);
  assert.equal(isSkinField(meta()), false, "DoodadMetaData has no such column: a doodad's fields stay in the main file");
  assert.equal(isSkinField(undefined), undefined);
  assert.equal(skinWritable(3, "none"), true);
  assert.equal(skinWritable(1, "none"), false);
  assert.equal(skinWritable(1, "json"), true);
  assert.equal(skinWritable(3, "raw"), false);
  assert.equal(skinPathOf("map/war3map.w3u.json"), "map/war3mapSkin.w3u.json");
  assert.equal(skinPathOf("map/war3campaign.w3d.json"), "map/war3campaignSkin.w3d.json");
  assert.equal(listedPath(["map/war3mapskin.w3u.json"], "map/war3mapSkin.w3u.json"), "map/war3mapskin.w3u.json");
});
