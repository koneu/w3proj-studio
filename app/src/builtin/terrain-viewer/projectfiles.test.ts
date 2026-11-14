import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { joinPath } from "../../lib/paths";
import { mapObjectData, NotImported, readFile, readImport, typeName } from "./projectfiles";

test("a chapter map's object data: the campaign's main and Skin files, then the map's own", async () => {
  // Curse of the Forsaken's war3campaignSkin.w3b frees IOt0's fixed rotation (bfxr -1): left out, the doodad rules
  // would turn its placed IOt0 to 270.
  const campaign = joinPath("campaigns", "Forsaken");
  const root = joinPath(campaign, "maps", "Forsaken08.w3x");
  const object = (base: string, field: string, value: number) => JSON.stringify({ original: [{ base, mods: [{ field, value }] }], custom: [] });
  const files: Record<string, string> = {
    [joinPath(campaign, "map", "war3campaign.w3b.json")]: object("ITtg", "bfxr", 90),
    [joinPath(campaign, "map", "war3campaignSkin.w3b.json")]: object("IOt0", "bfxr", -1),
    "map/war3map.w3b.json": object("LTlt", "bfxr", 0),
  };
  const w3 = {
    workspace: {
      project: () => ({ root }),
      files: () => [{ path: "map/war3map.w3b.json" }],
      readText: async (p: string) => { if (p in files) return files[p]; throw new Error(`not found: ${p}`); },
    },
  } as unknown as W3Api;
  const { art, unread } = await mapObjectData(w3);
  assert.deepEqual(art.map((a) => [a.kind, a.original?.[0]?.base]), [["w3b", "ITtg"], ["w3b", "IOt0"], ["w3b", "LTlt"]]);
  assert.deepEqual(unread, []);
});

test("typeName: a custom id by its base, never by a game entry of the same id (German [H000] is \"Waldläuferin\")", () => {
  // The German install's names: NeutralUnitStrings.txt has an [H000] of its own; the map's H000 is a custom Paladin.
  const names = new Map([["Hpal", "Paladin"], ["H000", "Waldläuferin"], ["hfoo", "Fußsoldat"]]);
  const bases = new Map([["H000", "Hpal"]]);
  assert.equal(typeName(names, bases, "H000"), "Paladin");
  assert.equal(typeName(names, bases, "hfoo"), "Fußsoldat");
  // Without the map's custom ids (not loaded yet), the game's entry is all there is.
  assert.equal(typeName(names, undefined, "H000"), "Waldläuferin");
  // A custom id whose base the game doesn't name: nothing (the caller keeps the id), not the game's same-id entry.
  assert.equal(typeName(names, new Map([["H000", "Xbad"]]), "H000"), undefined);
});

/** A project (a chapter map when `campaign`) whose disk holds `disk` (full paths for the campaign's, project paths for its own). */
function project(disk: Record<string, Uint8Array | Error>, own: string[], campaign?: { root: string; listing: string[] | null }) {
  const asked: string[] = [];
  const w3 = {
    settings: { get: () => "sd" },
    workspace: {
      project: () => ({ root: campaign ? joinPath(campaign.root, "maps", "Chapter01.w3x") : joinPath("projects", "Map") }),
      files: () => own.map((path) => ({ path })),
      listFolder: async () => { if (!campaign?.listing) throw new Error("no such folder"); return campaign.listing; },
      readBytes: async (p: string) => {
        asked.push(p);
        const f = disk[p];
        if (f instanceof Error) throw f;
        if (!f) throw new Error(`no such file: ${p}`);
        return f;
      },
    },
    game: { read: async (p: string) => { asked.push(`game:${p}`); return new Uint8Array([9]); } },
  } as unknown as W3Api;
  return { w3, asked };
}

test("a file the map doesn't import is the game's, read without asking the disk for it", async () => {
  const { w3, asked } = project({}, ["map/war3mapImported/a.blp"]);
  assert.deepEqual([...await readFile(w3, { path: "map/war3map.w3e" }, "Units\\Human\\Footman\\Footman.mdx")], [9]);
  assert.deepEqual(asked, ["game:Units\\Human\\Footman\\Footman.mdx"]);
  await assert.rejects(readImport(w3, "Units\\Human\\Footman\\Footman.mdx"), NotImported);
});

test("an import that is there but can't be read is an error, not the game's file in its place", async () => {
  const { w3, asked } = project({ "map/Units/Human/Footman/Footman.mdx": new Error("permission denied") }, ["map/Units/Human/Footman/Footman.mdx"]);
  await assert.rejects(readFile(w3, { path: "map/war3map.w3e" }, "units\\human\\footman\\footman.mdx"), /permission denied/);
  assert.deepEqual(asked, ["map/Units/Human/Footman/Footman.mdx"]);
});

test("a chapter map reads its campaign's import, and asks the campaign's folder for nothing it doesn't hold", async () => {
  const root = joinPath("campaigns", "Listed");
  const hero = joinPath(root, "map", "war3campImported", "Hero.mdx");
  const { w3, asked } = project({ [hero]: new Uint8Array([7]) }, [], { root, listing: ["war3campImported/Hero.mdx"] });
  assert.deepEqual([...await readFile(w3, { path: "map/war3map.w3e" }, "war3campImported\\hero.mdx")], [7]);
  assert.deepEqual([...await readFile(w3, { path: "map/war3map.w3e" }, "Textures\\Grass.blp")], [9]);
  assert.deepEqual([...await readFile(w3, { path: "map/war3map.w3e" }, "..\\..\\..\\secret.blp")], [9]);
  assert.deepEqual(asked, [hero, "game:Textures\\Grass.blp", "game:..\\..\\..\\secret.blp"]);
});

test("a campaign whose folder can't be listed: a guessed name that isn't there is the game's file, and none leads out of it", async () => {
  const root = joinPath("campaigns", "Unlisted");
  const { w3, asked } = project({}, [], { root, listing: null });
  assert.deepEqual([...await readFile(w3, { path: "map/war3map.w3e" }, "Textures\\Grass.blp")], [9]);
  assert.deepEqual([...await readFile(w3, { path: "map/war3map.w3e" }, "..\\..\\..\\secret.blp")], [9]);
  assert.deepEqual(asked, [joinPath(root, "map", "Textures", "Grass.blp"), "game:Textures\\Grass.blp", "game:..\\..\\..\\secret.blp"]);
});
