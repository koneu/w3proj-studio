import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta } from "../../lib/objects/metadata";
import { changedFields, gameFields, gameObjectList, mapObjectList, modelPacks, objectName, type MapObjects } from "./objectinfo";

const field = (id: string, label: string, repeat = 0) => ({ id, label, repeat }) as FieldMeta;
const kind = { names: new Map([["hfoo", "Footman"], ["AHbz", "Blizzard"]]), fieldById: new Map([["unam", field("unam", "Name")], ["uhpm", field("uhpm", "Hit Points")]]) };
const resolve = (v: string) => (v === "TRIGSTR_001" ? "|cffff0000Red|r Guard" : v);

const file: MapObjects = {
  custom: [{ base: "hfoo", id: "h000", mods: [{ field: "unam", value: "TRIGSTR_001" }, { field: "uhpm", value: 500 }] }],
  original: [{ base: "hfoo", mods: [{ field: "uhpm", value: 450 }] }],
};

test("game objects can be narrowed to a tileset and a category", () => {
  const tiles: Record<string, string> = { ATtr: "A", LTlt: "L,F", YTct: "*" };
  const kinds = { ATtr: "Trees", LTlt: "Trees", YTct: "Other" } as Record<string, string>;
  const game = {
    baseIds: ["ATtr", "LTlt", "YTct"], names: new Map([["ATtr", "Tree"]]), facets: (id: string) => ({ category: kinds[id] }),
    fieldById: new Map([["btil", field("btil", "Tilesets")]]), defaultValue: (id: string) => tiles[id],
  };
  const ids = (t?: string, c?: string) => gameObjectList(game, (s) => s, t, c).map((o) => o.id);
  assert.deepEqual(ids(), ["ATtr", "LTlt", "YTct"]);
  assert.deepEqual(ids("a"), ["ATtr", "YTct"]);
  assert.deepEqual(ids("F"), ["LTlt", "YTct"]);
  assert.deepEqual(ids("A", "tree"), ["ATtr"]);
  assert.deepEqual(gameObjectList(game, (s) => s, "A")[0], { id: "ATtr", name: "Tree", category: "Trees" });
});

test("objects say what their model means in the game", () => {
  const stored = modelPacks([
    "War3.w3mod:Doodads/Tree/Tree.mdx", "War3.w3mod:Doodads/Rock/Rock0.mdx", "War3.w3mod:_DE.w3mod:Doodads/Lantern/Lantern.mdx", "War3.w3mod:_HD.w3mod:Doodads/Lantern/Lantern.mdx",
  ]);
  const paths: Record<string, string> = { a: "Doodads\\Tree\\Tree", b: "Doodads\\Rock\\Rock", c: "Doodads\\Lantern\\Lantern.mdl", d: "Doodads\\Gone\\Gone", e: "_" };
  const game = {
    baseIds: Object.keys(paths), names: new Map<string, string>(), facets: () => ({}),
    fieldById: new Map([["dfil", field("dfil", "Model")]]), defaultValue: (id: string) => paths[id],
  };
  assert.deepEqual(gameObjectList(game, (s) => s, undefined, undefined, stored).map(({ id, name, ...rest }) => rest), [
    {}, {}, { modelOnlyIn: ["DE", "HD"] }, { noModel: true }, { noModel: true },
  ]);
});

test("objects say their size and whether they take up ground", () => {
  const values: Record<string, string> = { dmis: "0.8", dmas: "1.2", dptx: "PathTextures\\4x4Default.tga" };
  const game = {
    baseIds: ["a"], names: new Map<string, string>(), facets: () => ({}),
    fieldById: new Map(["dmis", "dmas", "dptx"].map((f) => [f, field(f, f)])), defaultValue: (_: string, f: FieldMeta) => values[f.id],
  };
  assert.deepEqual(gameObjectList(game, (s) => s)[0], { id: "a", name: "a", sizeRange: [0.8, 1.2], takesRoom: true });
  values.dptx = "_";
  assert.equal(gameObjectList(game, (s) => s)[0].takesRoom, false);
  values.dptx = "none";
  assert.equal(gameObjectList(game, (s) => s)[0].takesRoom, false);
  delete values.dptx;
  assert.equal("takesRoom" in gameObjectList(game, (s) => s)[0], false, "unknown isn't no");
});

test("a type's variations each need a model: a placed one uses just its own", () => {
  const stored = modelPacks(["War3.w3mod:Doodads/V/Pot0.mdx", "War3.w3mod:Doodads/V/Pot1.mdx", "War3.w3mod:_DE.w3mod:Doodads/V/Jug0.mdx", "War3.w3mod:Doodads/V/Jug1.mdx"]);
  const paths: Record<string, string> = { a: "Doodads\\V\\Pot", b: "Doodads\\V\\Jug" };
  const values: Record<string, string> = { dvar: "3" };
  const game = {
    baseIds: ["a", "b"], names: new Map<string, string>(), facets: () => ({}),
    fieldById: new Map([["dfil", field("dfil", "Model")], ["dvar", field("dvar", "Variations")]]),
    defaultValue: (id: string, f: FieldMeta) => (f.id === "dfil" ? paths[id] : values[f.id]),
  };
  const [pot, jug] = gameObjectList(game, (s) => s, undefined, undefined, stored);
  assert.deepEqual(pot.variationsWithoutModel, [2]);
  assert.equal("modelOnlyIn" in pot, false);
  assert.deepEqual(jug.modelOnlyIn, ["DE"]);
});

test("odd model paths of the game's tables still find their files", () => {
  // As in the game (2026-11): the dummy units' "Empty.ma", the item clom's path with its pack, the City wall endcap
  // YSw5 of 2 variations whose classic file has no number.
  const stored = modelPacks([
    "War3.w3mod:_DE.w3mod:Doodads/Cinematic/Empty/Empty.mdx", "War3.w3mod:_DE.w3mod:Doodads/Undercity/Props/Corpse/Corpse2.mdx",
    "War3.w3mod:Doodads/Cityscape/Structures/CityWallEndcap/CityWallEndcap.mdx",
    "War3.w3mod:_DE.w3mod:Doodads/Cityscape/Structures/CityWallEndcap/CityWallEndcap0.mdx", "War3.w3mod:_HD.w3mod:Doodads/Cityscape/Structures/CityWallEndcap/CityWallEndcap1.mdx",
  ]);
  const paths: Record<string, string> = {
    oimd: "Doodads/Cinematic/Empty/Empty.ma", clom: "war3.w3mod:_de.w3mod:doodads\\undercity\\props\\corpse\\corpse2.mdx",
    YSw5: "Doodads\\Cityscape\\Structures\\CityWallEndcap\\CityWallEndcap", gone: "Doodads\\Gone\\Gone.ma",
  };
  const values: Record<string, string> = { YSw5: "2" };
  const game = {
    baseIds: Object.keys(paths), names: new Map<string, string>(), facets: () => ({}),
    fieldById: new Map([["dfil", field("dfil", "Model")], ["dvar", field("dvar", "Variations")]]),
    defaultValue: (id: string, f: FieldMeta) => (f.id === "dfil" ? paths[id] : values[id]),
  };
  assert.deepEqual(gameObjectList(game, (s) => s, undefined, undefined, stored).map(({ id, name, ...rest }) => [id, rest]), [
    ["oimd", { modelOnlyIn: ["DE"] }], ["clom", { modelOnlyIn: ["DE"] }], ["YSw5", {}], ["gone", { noModel: true }],
  ]);
});

test("trees go by what the game targets them as, not their category", () => {
  const targets: Record<string, string> = { ATtr: "tree", LOcg: "debris", ZTx: "tree,debris" };
  const game = {
    baseIds: Object.keys(targets), names: new Map<string, string>(), facets: (id: string) => ({ target: targets[id] }),
    fieldById: new Map(), defaultValue: () => undefined,
  };
  assert.deepEqual(gameObjectList(game, (s) => s, undefined, undefined, undefined, true).map((o) => o.id), ["ATtr", "ZTx"]);
  assert.equal(gameObjectList(game, (s) => s)[1].tree, undefined);
});

test("names: the map's own, without colour codes, else the base's", () => {
  assert.equal(objectName(file.custom![0], kind, resolve), "Red Guard");
  assert.equal(objectName(file.original![0], kind, resolve), "Footman");
  assert.equal(objectName({ base: "xxxx" }, kind, resolve), "xxxx");
});

test("the map's list has new objects and changed game objects", () => {
  assert.deepEqual(mapObjectList(file, kind, resolve), [
    { id: "h000", base: "hfoo", name: "Red Guard", custom: true, changes: 2 },
    { id: "hfoo", name: "Footman", custom: false, changes: 1 },
  ]);
  assert.deepEqual(mapObjectList({}, kind, resolve), []);
});

test("changed fields say what they are, level values and data sets included", () => {
  assert.deepEqual(changedFields(file.custom![0], kind, resolve), [
    { field: "unam", label: "Name", value: "Red Guard" },
    { field: "uhpm", label: "Hit Points", value: 500 },
  ]);
  const ability = { base: "AHbz", sets: [{ mods: [{ field: "Hbz1", level: 2, value: 7 }] }] };
  assert.deepEqual(changedFields(ability, kind, resolve), [{ field: "Hbz1", label: "Hbz1", level: 2, value: 7 }]);
});

test("game fields skip what's empty, and repeating fields show level 1", () => {
  const levels: number[] = [];
  const game = {
    fieldsFor: () => [field("uhpm", "Hit Points"), field("udam", "Damage", 3), field("unot", "Nothing")],
    defaultValue: (_: string, f: FieldMeta, level: number) => { levels.push(level); return f.id === "unot" ? "" : "420"; },
  };
  assert.deepEqual(gameFields("hfoo", game).map((f) => f.field), ["uhpm", "udam"]);
  assert.deepEqual(levels, [0, 1, 0]);
});
