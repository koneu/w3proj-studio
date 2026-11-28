// "Clean up import list" (lib/importcleanup.ts) on a list modelled on smoketest_maps' TurtleRock v2.0 (a W3Champions
// build): its war3map.imp holds 66 entries of flag 0 and no name, while the archive holds 48 imported files (the rest of
// its 71 are the map's own) that the list therefore can't show.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanedList, cleanupIsEmpty, cleanupSummary, entriesWithoutFile, entryGameNames, importCleanup } from "./importcleanup";
import { IMPORT_FOLDER, unlistedFiles, type ImportEntry } from "./imports";

/** The map's own files as the project holds them (not imports). */
const OWN = ["conversation.json", "war3map.doo.json", "war3map.imp.json", "war3map.lua", "war3mapMap.blp", "war3map.mmp.json", "war3map.shd",
  "war3mapSkin.w3b.json", "war3mapSkin.w3t.json", "war3mapUnits.doo.json", "war3map.w3b.json", "war3map.w3c.json", "war3map.w3e.txt",
  "war3map.w3i.json", "war3map.w3r.json", "war3map.w3t.json", "war3map.w3u.json", "war3map.wct.txt", "war3map.wpm", "war3map.wtg", "war3map.wts"];
const CLAW = [4, 5, 8, 9, 12, 15];
/** TurtleRock's imported files, as unpacked (project paths below map/). */
const IMPORTS = [
  ...["generic.dds", "generic.mdx", "tome.dds", "tome.mdx"].map((n) => `loot-indicator/loot-indicator-${n}`),
  "loot-indicator/ui/loot-table-ui.fdf", "loot-indicator/ui/ui.toc",
  ...["", "_teen.w3mod/"].flatMap((art) => [
    ...CLAW.map((n) => `${art}ReplaceableTextures/CommandButtons/BTNClaw+${n}.dds`),
    ...CLAW.map((n) => `${art}ReplaceableTextures/CommandButtonsDisabled/DISBTNClaw+${n}.dds`)]),
  ...[3, 4, 5].flatMap((n) => [`ReplaceableTextures/CommandButtons/BTNRoP+${n}.dds`, `ReplaceableTextures/CommandButtonsDisabled/DISBTNRoP+${n}.dds`]),
  "UI/MiniMap/MiniMap-Gold.dds", "UI/MiniMap/MiniMapIconCreepLoc.dds", "UI/MiniMap/MiniMapIconCreepLoc2.dds", "UI/MiniMap/MiniMap-NeutralBuilding.dds",
  ...["Laboratory", "Mercenary", "Shop", "Tavern"].flatMap((n) => [`UI/MiniMap/MiniMap-${n}.dds`, `UI/MiniMap/MiniMap-${n}.mdx`]),
];
const turtleFiles = () => [...OWN, ...IMPORTS].map((p) => `map/${p}`);
const blanks = (n: number): ImportEntry[] => Array.from({ length: n }, () => ({ flags: 0, path: "" }));
const archive = (p: string) => p.split("/").join("\\");

test("TurtleRock: the 66 blank entries go, the 48 imported files come in with the flags new imports get", () => {
  assert.equal(IMPORTS.length, 48);
  const entries = blanks(66);
  const c = importCleanup(turtleFiles(), entries, IMPORT_FOLDER);
  assert.equal(c.drop.length, 66);
  assert.ok(c.drop.every((d, i) => d.reason === "blank" && d.index === i && d.entry === entries[i]));
  assert.deepEqual(c.keptProvided, []);
  assert.equal(c.add.length, 48);
  assert.deepEqual(new Set(c.add.map((e) => e.path)), new Set(IMPORTS.map(archive)));
  assert.ok(c.add.every((e) => e.flags === 21), JSON.stringify(c.add.filter((e) => e.flags !== 21)));
  // The art-set folder and the "+" names stay as the archive spells them.
  assert.ok(c.add.some((e) => e.path === "_teen.w3mod\\ReplaceableTextures\\CommandButtons\\BTNClaw+15.dds"));
  assert.ok(c.add.some((e) => e.path === "ReplaceableTextures\\CommandButtonsDisabled\\DISBTNClaw+4.dds"));
  // None of the map's own files is listed as an import.
  assert.ok(!c.add.some((e) => /^war3map|^conversation/i.test(e.path)));
  // Sorted: a list that versions well.
  assert.deepEqual(c.add.map((e) => e.path), [...c.add.map((e) => e.path)].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));

  const after = cleanedList(entries, c);
  assert.equal(after.length, 48);
  // Afterwards the list names every file: the Problems view's rule finds nothing unlisted, a second clean-up nothing to do.
  assert.deepEqual(unlistedFiles(turtleFiles(), after, IMPORT_FOLDER), []);
  assert.ok(cleanupIsEmpty(importCleanup(turtleFiles(), after, IMPORT_FOLDER)));
  assert.match(cleanupSummary(c), /^Clean up the import list: remove 66 entries without a name; add 48 files of the map that aren't listed \(.*, and 42 more\)\.$/);
});

test("entries whose file is there stay (standard-path entries, a sound stored under another extension, any case); missing ones go", () => {
  const files = ["map/war3map.w3i.json", "map/war3mapImported/Kept.blp", "map/war3mapImported/Short.blp", "map/war3mapImported/boom.ogg",
    "map/war3mapimported/case.mdx", "map/Units/New.mdx"];
  const keep = { flags: 21, path: "war3mapImported\\Kept.blp" }, short = { flags: 5, path: "Short.blp" }, sound = { flags: 21, path: "war3mapImported\\boom.flac" };
  const cased = { flags: 21, path: "war3mapImported\\Case.mdx" }, gone = { flags: 21, path: "war3mapImported\\Gone.blp" };
  const game = { flags: 13, path: "Units\\Human\\Footman\\Footman.mdx" };
  const entries = [keep, gone, short, game, sound, cased, ...blanks(1)];
  assert.deepEqual(entriesWithoutFile(files, entries, IMPORT_FOLDER), [gone, game]);
  const provided = new Set(["Units\\Human\\Footman\\Footman.mdx"]);
  const c = importCleanup(files, entries, IMPORT_FOLDER, (e) => entryGameNames(e, IMPORT_FOLDER).some((n) => provided.has(n)));
  assert.deepEqual(c.drop.map((d) => [d.entry, d.index, d.reason]), [[gone, 1, "missing"], [entries[6], 6, "blank"]]);
  assert.deepEqual(c.keptProvided, [game]);
  assert.deepEqual(c.add, [{ flags: 21, path: "Units\\New.mdx" }]);
  assert.deepEqual(cleanedList(entries, c), [keep, short, game, sound, cased, { flags: 21, path: "Units\\New.mdx" }]);
  assert.match(cleanupSummary(c), /remove 1 entry without a name; remove 1 entry whose file isn't in the map \(war3mapImported\\Gone\.blp\); add 1 file of the map that isn't listed \(Units\\New\.mdx\)\. 1 entry names a file the game or the campaign provides; kept\.$/);
  // Control: without the game's answer the entry it provides goes too.
  assert.ok(importCleanup(files, entries, IMPORT_FOLDER).drop.some((d) => d.entry === game));
  // The whole change for the Output panel: no names in the line itself.
  assert.equal(cleanupSummary(c, 0), "Clean up the import list: remove 1 entry without a name; remove 1 entry whose file isn't in the map; add 1 file of the map that isn't listed. 1 entry names a file the game or the campaign provides; kept.");
});

test("a Reforged version gets the flags Blizzard's maps list it with; two files differing only in case are one entry", () => {
  const c = importCleanup(["map/_HD.w3mod/war3mapImported/a.mdx", "map/x/A.blp", "map/x/a.blp"], [], IMPORT_FOLDER);
  assert.deepEqual(c.add, [{ flags: 13, path: "_HD.w3mod\\war3mapImported\\a.mdx" }, { flags: 21, path: "x\\A.blp" }]);
});

/** The game's lookup as the backend does it (crates/casc/src/game.rs resolve, Classic layers): a plain path, `\` or
 *  `/`, any case, behind each layer prefix, against the storage's full root paths. An art set's or language's folder
 *  (`_HD.w3mod\Units\X.mdx`) is taken as the layer it is (`_hd.w3mod:units/x.mdx`: layer_form). */
function gameResolver(root: readonly string[]) {
  const stored = new Map(root.map((p) => [p.toLowerCase(), p]));
  const layers = ["war3.w3mod:_locales/enus.w3mod:", "war3.w3mod:", "war3.w3mod:_deprecated.w3mod:"];
  return (path: string) => {
    const p = path.replace(/\\/g, "/").toLowerCase().replace(/\.w3mod\//g, ".w3mod:");
    for (const l of layers) { const hit = stored.get(`${l}${p}`); if (hit) return hit; }
    return null;
  };
}

test("an art set's or language's entry is looked up by its archive path, which game.resolve takes as the layer it is", () => {
  const f = { flags: 13, path: "Units\\Human\\Footman\\Footman.mdx" };
  assert.deepEqual(entryGameNames(f, IMPORT_FOLDER), ["Units\\Human\\Footman\\Footman.mdx"]);
  assert.deepEqual(entryGameNames({ flags: 13, path: "_HD.w3mod\\Units\\Human\\Footman\\Footman.mdx" }, IMPORT_FOLDER), ["_HD.w3mod\\Units\\Human\\Footman\\Footman.mdx"]);
  assert.deepEqual(entryGameNames({ flags: 13, path: "_HD.w3mod\\_Locales\\deDE.w3mod\\Sound\\X.wav" }, IMPORT_FOLDER).slice(0, 1), ["_HD.w3mod\\_Locales\\deDE.w3mod\\Sound\\X.wav"]);
});

test("Clean up keeps an _HD entry the game provides (its layer _hd.w3mod), drops one it hasn't", () => {
  const resolve = gameResolver(["War3.w3mod:Units/Human/Footman/Footman.mdx", "War3.w3mod:_HD.w3mod:Units/Human/Footman/Footman.mdx"]);
  const plain = { flags: 13, path: "Units\\Human\\Footman\\Footman.mdx" };
  const hd = { flags: 13, path: "_HD.w3mod\\Units\\Human\\Footman\\Footman.mdx" };
  const none = { flags: 13, path: "_HD.w3mod\\Units\\Human\\Footman\\NoSuch.mdx" };
  const files = ["map/war3map.w3i.json"];
  const c = importCleanup(files, [plain, hd, none], IMPORT_FOLDER, (e) => entryGameNames(e, IMPORT_FOLDER).some((n) => resolve(n) !== null));
  assert.deepEqual(c.keptProvided, [plain, hd]);
  assert.deepEqual(c.drop.map((d) => d.entry), [none]);
  // The Import Manager asks with these names and matches the answers back by them: the same in SD and HD.
  assert.equal(resolve(hd.path), "War3.w3mod:_HD.w3mod:Units/Human/Footman/Footman.mdx");
  assert.equal(resolve(plain.path), "War3.w3mod:Units/Human/Footman/Footman.mdx");
  // Control: a path stored in neither form is no answer.
  assert.equal(resolve(none.path), null);
});

test("a list that is already clean gives nothing to do", () => {
  const files = ["map/war3map.w3i.json", "map/war3mapImported/a.blp"];
  const c = importCleanup(files, [{ flags: 21, path: "war3mapImported\\a.blp" }], IMPORT_FOLDER);
  assert.ok(cleanupIsEmpty(c));
  assert.equal(cleanupSummary(c), "The import list names exactly the map's files: nothing to clean up.");
});
