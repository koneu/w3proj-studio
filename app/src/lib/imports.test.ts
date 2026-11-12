import assert from "node:assert/strict";
import { test } from "node:test";
import { clickSelection } from "./selection";
import { importedPath, importPath, importTreePath, isJunkFile, isMapFile, listedPath, readImported, unlistedFiles } from "./imports";
import type { W3Api } from "../extensions/api";

test("files of the map folder the list doesn't name are unlisted; the map's own files and what the list names aren't", () => {
  const files = ["map/war3map.w3i.json", "map/war3map.j", "map/war3mapMap.blp", "map/war3mapSkin.txt", "map/war3map.imp.json", "map/war3mapImported/A.blp",
    "map/war3mapImported/short.blp", "map/Sound/x.ogg", "map/Units/Human/TownHall/TownHall.mdx", "map/_HD.w3mod/war3mapImported/A.blp", "w3proj.toml", "maps/c/map/x.blp"];
  // Listed in another case; a "standard path" entry names a file inside the import folder; a sound listed as .flac
  // stands for the .ogg the map holds.
  const entries = [{ flags: 21, path: "WAR3MAPIMPORTED\\a.blp" }, { flags: 5, path: "Short.blp" }, { flags: 13, path: "Sound\\x.flac" }];
  assert.deepEqual(unlistedFiles(files, entries, "war3mapImported"), ["map/Units/Human/TownHall/TownHall.mdx", "map/_HD.w3mod/war3mapImported/A.blp"]);
  assert.deepEqual(unlistedFiles(files, [], "war3mapImported"), ["map/war3mapImported/A.blp", "map/war3mapImported/short.blp", "map/Sound/x.ogg",
    "map/Units/Human/TownHall/TownHall.mdx", "map/_HD.w3mod/war3mapImported/A.blp"]);
  // A campaign's list: its own files and its import folder.
  assert.deepEqual(unlistedFiles(["map/war3campaign.w3f.json", "map/war3campImported/s.blp"], [{ flags: 5, path: "s.blp" }], "war3campImported"), []);
});

test("a map's file is found under its name on disk, whatever the case asked for; the exact name wins", async () => {
  const list = [{ path: "map/war3mapimported/hero.mdx" }, { path: "map/Units/A.mdx" }, { path: "map/units/a.mdx" }].map((f) => ({ ...f, size: 1, modified: 0 }));
  assert.equal(listedPath(list, "map/war3mapImported/Hero.mdx"), "map/war3mapimported/hero.mdx");
  assert.equal(listedPath(list, "map/units/a.mdx"), "map/units/a.mdx");
  assert.equal(listedPath(list, "map/UNITS/A.MDX"), "map/Units/A.mdx");
  assert.equal(listedPath(list, "map/none.mdx"), undefined);
  const read: string[] = [];
  const w3 = { workspace: { files: () => list, readBytes: async (p: string) => { read.push(p); return new Uint8Array([1]); } } } as unknown as W3Api;
  // An archive path, escaped as the project stores it.
  assert.equal(importedPath(w3, "war3mapImported\\HERO.mdx"), "map/war3mapimported/hero.mdx");
  assert.deepEqual(await readImported(w3, "War3mapImported/Hero.MDX"), new Uint8Array([1]));
  assert.equal(await readImported(w3, "war3mapImported\\none.mdx"), null);
  assert.deepEqual(read, ["map/war3mapimported/hero.mdx"]);
});

test("a campaign's own files aren't imports, its imports are", () => {
  for (const f of ["war3campaign.w3f", "war3campaign.wts", "war3campaignSkin.w3u", "war3campaignSkin.txt", "war3campaignMisc.txt", "war3campaignExtra.txt", "war3mapMisc.txt"]) {
    assert.ok(isMapFile(f), f);
  }
  for (const f of ["war3campaignMiscs.txt", "war3campImported\\war3campaignMisc.txt", "war3campaignOther.txt"]) assert.ok(!isMapFile(f), f);
  // The language and art set versions of the map's own files (Blizzard's maps) aren't imports either.
  for (const f of ["war3mapPreview.tga", "_Locales\\deDE.w3mod\\war3map.wts", "_HD.w3mod\\war3mapSkin.txt", "_hd.w3mod\\_locales\\zhCN.w3mod\\war3map.wts"]) assert.ok(isMapFile(f), f);
  for (const f of ["_Locales\\deDE.w3mod\\war3mapImported\\a.blp", "_HD.w3mod\\x\\war3map.wts", "_Locales\\de.w3mod\\war3map.wts"]) assert.ok(!isMapFile(f), f);
});

test("imports go below the import folder, numbered if taken", () => {
  const taken = new Set(["war3mapImported\\a.blp", "war3mapImported\\a (2).blp"]);
  assert.equal(importPath("C:\\x\\b.blp", (p) => taken.has(p)), "war3mapImported\\b.blp");
  assert.equal(importPath("C:/x/a.blp", (p) => taken.has(p)), "war3mapImported\\a (3).blp");
  assert.equal(importPath("noext", () => false, "war3campImported"), "war3campImported\\noext");
});

test("folder imports keep their structure", () => {
  assert.equal(importTreePath("Pack/fx/a.blp", () => false), "war3mapImported\\Pack\\fx\\a.blp");
  const taken = (p: string) => p === "war3mapImported\\Pack\\a.blp";
  assert.equal(importTreePath("Pack/a.blp", taken), "war3mapImported\\Pack\\a (2).blp");
});

test("folder imports skip system leftovers", () => {
  for (const f of ["Thumbs.db", "a/desktop.ini", ".DS_Store", ".git/config", "a/.svn/x.blp"]) assert.ok(isJunkFile(f), f);
  for (const f of ["a.blp", "a/b.c.blp", "thumbs.db.blp"]) assert.ok(!isJunkFile(f), f);
});

test("selection: plain, Ctrl and Shift clicks", () => {
  const order = ["a", "b", "c", "d"];
  const plain = { ctrl: false, shift: false }, ctrl = { ctrl: true, shift: false }, shift = { ctrl: false, shift: true };
  const one = clickSelection(order, new Set(["c"]), "c", "a", plain);
  assert.deepEqual([...one.selected], ["a"]);
  const two = clickSelection(order, one.selected, one.anchor, "c", ctrl);
  assert.deepEqual([...two.selected].sort(), ["a", "c"]);
  assert.deepEqual([...clickSelection(order, two.selected, two.anchor, "c", ctrl).selected], ["a"]);
  // Shift works both ways from the anchor, which stays.
  const range = clickSelection(order, new Set(["b"]), "b", "d", shift);
  assert.deepEqual([...range.selected], ["b", "c", "d"]);
  assert.deepEqual([...clickSelection(order, range.selected, range.anchor, "a", shift).selected], ["a", "b"]);
  // Ctrl+Shift adds the range; Shift without a usable anchor is a plain click.
  assert.deepEqual([...clickSelection(order, new Set(["d"]), "a", "b", { ctrl: true, shift: true }).selected].sort(), ["a", "b", "d"]);
  assert.deepEqual([...clickSelection(order, new Set(), "gone", "b", shift).selected], ["b"]);
});
