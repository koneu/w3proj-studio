// A file per graphics mode (lib/imports.ts): Reforged reads `_HD.w3mod\<path>` before `<path>`, so a plain import and
// its Reforged version are one entry of the Import Manager, "Use in" chooses where an import goes, a row's versions
// move together, and the map's own files are read in the order of the graphics mode (previews, terrain view).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classicPathOf, dePathOf, importedPathFor, isDePath, importRows, isReforgedPath, modeNames, newEntryFlags, ownNames, pathForUse, previewMode, readImportedFor,
  reforgedPathOf, rowEntries, rowMoves, takenWithVersions, type ImportEntry,
} from "./imports";
import type { W3Api } from "../extensions/api";

test("a plain path and its Reforged version: _HD.w3mod\\ in front, in any case, and back", () => {
  assert.equal(reforgedPathOf("war3mapImported\\Hero.mdx"), "_HD.w3mod\\war3mapImported\\Hero.mdx");
  assert.equal(reforgedPathOf("war3mapImported/Hero.mdx"), "_HD.w3mod\\war3mapImported\\Hero.mdx");
  assert.equal(classicPathOf("_hd.W3MOD\\war3mapImported\\Hero.mdx"), "war3mapImported\\Hero.mdx");
  assert.equal(classicPathOf("war3mapImported\\Hero.mdx"), "war3mapImported\\Hero.mdx");
  assert.ok(isReforgedPath("_HD.w3mod\\a.blp") && isReforgedPath("_hd.w3mod/a.blp"));
  // Only the folder at the root is the art set; another _HD folder or a similar name isn't.
  for (const p of ["war3mapImported\\_HD.w3mod\\a.blp", "_HD.w3modx\\a.blp", "_DE.w3mod\\a.blp", "a.blp"]) assert.ok(!isReforgedPath(p), p);
  // Blizzard's campaigns list their Reforged files as custom-path entries.
  assert.equal(newEntryFlags("_HD.w3mod\\a.blp"), 13);
  assert.equal(newEntryFlags("war3mapImported\\a.blp"), 21);
});

test("Use in: Both and Classic only keep the plain path, Reforged only puts models and textures below _HD.w3mod\\", () => {
  assert.equal(pathForUse("war3mapImported\\Hero.mdx", "both"), "war3mapImported\\Hero.mdx");
  assert.equal(pathForUse("war3mapImported\\Hero.mdx", "classic"), "war3mapImported\\Hero.mdx");
  assert.equal(pathForUse("war3mapImported\\Hero.mdx", "reforged"), "_HD.w3mod\\war3mapImported\\Hero.mdx");
  assert.equal(pathForUse("war3mapImported\\Hero.dds", "reforged"), "_HD.w3mod\\war3mapImported\\Hero.dds");
  // Other files have no per-mode version here: a script or a sound stays plain.
  assert.equal(pathForUse("war3mapImported\\a.lua", "reforged"), "war3mapImported\\a.lua");
  assert.equal(pathForUse("war3mapImported\\a.flac", "reforged"), "war3mapImported\\a.flac");
});

test("a new import's name is taken when either of its versions is: an unrelated file would stand in for it", () => {
  const have = new Set(["_hd.w3mod\\war3mapimported\\hero.mdx", "war3mapimported\\tex.blp"]);
  const taken = (p: string) => have.has(p.toLowerCase());
  assert.ok(takenWithVersions("war3mapImported\\Hero.mdx", taken), "the Reforged one is there");
  assert.ok(takenWithVersions("_HD.w3mod\\war3mapImported\\Tex.blp", taken), "the plain one is there");
  assert.ok(!takenWithVersions("war3mapImported\\Other.mdx", taken));
});

test("rows: a plain entry and its Reforged version are one, in the order of the first; others stay alone", () => {
  const e = (flags: number, path: string): ImportEntry => ({ flags, path });
  const hero = e(21, "war3mapImported\\Hero.mdx"), heroHd = e(13, "_HD.w3mod\\WAR3MAPIMPORTED\\hero.mdx");
  const onlyHd = e(13, "_HD.w3mod\\war3mapImported\\Night.mdx"), sound = e(21, "war3mapImported\\a.flac");
  const standard = e(5, "Tex.blp"), standardHd = e(13, "_HD.w3mod\\war3mapImported\\Tex.blp"), again = e(21, "war3mapImported\\Hero.mdx");
  const rows = importRows([heroHd, sound, onlyHd, hero, standard, standardHd, again],
    // A standard-path entry's name is inside the import folder.
    (x) => (x.flags === 5 ? `war3mapImported\\${x.path}` : x.path));
  assert.deepEqual(rows.map((r) => [r.path, r.classic?.path ?? null, r.reforged?.path ?? null]), [
    // Named as the plain entry spells it, though the Reforged one came first.
    ["war3mapImported\\Hero.mdx", "war3mapImported\\Hero.mdx", "_HD.w3mod\\WAR3MAPIMPORTED\\hero.mdx"],
    ["war3mapImported\\a.flac", "war3mapImported\\a.flac", null],
    ["war3mapImported\\Night.mdx", null, "_HD.w3mod\\war3mapImported\\Night.mdx"],
    ["war3mapImported\\Tex.blp", "Tex.blp", "_HD.w3mod\\war3mapImported\\Tex.blp"],
    // A second entry of the same version is a row of its own (lists may name a path twice), with a key of its own.
    ["war3mapImported\\Hero.mdx", "war3mapImported\\Hero.mdx", null],
  ]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
  assert.deepEqual(rowEntries(rows[0]), [hero, heroHd], "Classic first");
  // Control: without the pairing every entry would be a row.
  assert.equal(importRows([hero]).length, 1);
  assert.equal(importRows([hero, heroHd]).length, 1);
});

test("Change path moves both versions of a row; a Classic entry alone goes where it is told", () => {
  const [pair] = importRows([{ flags: 21, path: "war3mapImported\\Hero.mdx" }, { flags: 13, path: "_HD.w3mod\\war3mapImported\\Hero.mdx" }]);
  assert.deepEqual(rowMoves(pair, "Units\\Hero.mdx").map((m) => [m.from, m.to]), [
    ["war3mapImported\\Hero.mdx", "Units\\Hero.mdx"], ["_HD.w3mod\\war3mapImported\\Hero.mdx", "_HD.w3mod\\Units\\Hero.mdx"]]);
  // The Reforged version follows into its folder: a typed _HD.w3mod\ isn't doubled.
  assert.deepEqual(rowMoves(pair, "_HD.w3mod\\Units\\Hero.mdx").map((m) => m.to), ["Units\\Hero.mdx", "_HD.w3mod\\Units\\Hero.mdx"]);
  const [hdOnly] = importRows([{ flags: 13, path: "_HD.w3mod\\a.mdx" }]);
  assert.deepEqual(rowMoves(hdOnly, "b.mdx").map((m) => [m.from, m.to]), [["_HD.w3mod\\a.mdx", "_HD.w3mod\\b.mdx"]]);
  const [plain] = importRows([{ flags: 21, path: "a.mdx" }]);
  assert.deepEqual(rowMoves(plain, "_HD.w3mod\\a.mdx").map((m) => m.to), ["_HD.w3mod\\a.mdx"], "a plain file can be moved into the Reforged folder");
});

test("the map's own files per graphics mode: Reforged reads the _HD.w3mod\\ version first, Classic never", () => {
  assert.deepEqual(modeNames("war3mapImported\\Hero.mdx", "hd"), ["_HD.w3mod\\war3mapImported\\Hero.mdx", "war3mapImported\\Hero.mdx"]);
  // 3.0: its own _DE.w3mod\ version, then the Reforged one, then the plain file (from any version's spelling).
  const deOrder = ["_DE.w3mod\\war3mapImported\\Hero.mdx", "_HD.w3mod\\war3mapImported\\Hero.mdx", "war3mapImported\\Hero.mdx"];
  assert.deepEqual(modeNames("war3mapImported\\Hero.mdx", "de"), deOrder);
  assert.deepEqual(modeNames("_de.w3mod/war3mapImported/Hero.mdx", "de"), deOrder);
  assert.deepEqual(modeNames("war3mapImported\\Hero.mdx", "sd"), ["war3mapImported\\Hero.mdx"]);
  // A preview's preference wins over the mode set; without either, Reforged HD (the setting's default).
  assert.equal(previewMode("classic", "hd"), "sd");
  assert.equal(previewMode("hd", "sd"), "hd");
  assert.equal(previewMode("reforged", "sd"), "hd");
  assert.equal(previewMode(undefined, "sd"), "sd");
  assert.equal(previewMode(undefined, "de"), "de");
  assert.equal(previewMode("de", "sd"), "de");
  assert.equal(previewMode(undefined, undefined), "hd");
  // A texture's names (its .blp and the .dds the game reads instead): every Reforged version before any plain file.
  assert.deepEqual(ownNames(["a.blp", "a.dds"], "hd"), ["_HD.w3mod\\a.blp", "_HD.w3mod\\a.dds", "a.blp", "a.dds"]);
  assert.deepEqual(ownNames(["a.blp", "a.dds"], "sd"), ["a.blp", "a.dds"]);
  assert.deepEqual(ownNames(["a.blp", "a.dds"], "de"), ["_DE.w3mod\\a.blp", "_DE.w3mod\\a.dds", "_HD.w3mod\\a.blp", "_HD.w3mod\\a.dds", "a.blp", "a.dds"]);
});

test("the map's file of a graphics mode is found under its name on disk; Classic never reads the Reforged one", async () => {
  const files = ["map/war3mapImported/hero.mdx", "map/_hd.w3mod/war3mapimported/hero.mdx", "map/_HD.w3mod/war3mapImported/Night.mdx"]
    .map((path) => ({ path, size: 1, modified: 0 }));
  const read: string[] = [];
  const w3 = { workspace: { files: () => files, readBytes: async (p: string) => { read.push(p); return new Uint8Array([read.length]); } } } as unknown as W3Api;
  assert.equal(importedPathFor(w3, "war3mapImported\\Hero.mdx", "hd"), "map/_hd.w3mod/war3mapimported/hero.mdx");
  assert.equal(importedPathFor(w3, "war3mapImported\\Hero.mdx", "sd"), "map/war3mapImported/hero.mdx");
  assert.equal(importedPathFor(w3, "war3mapImported/Night.mdx", "hd"), "map/_HD.w3mod/war3mapImported/Night.mdx");
  assert.equal(importedPathFor(w3, "war3mapImported\\Night.mdx", "sd"), undefined, "a Reforged version alone is nothing in Classic");
  assert.deepEqual(await readImportedFor(w3, "war3mapImported\\Hero.mdx", "de"), new Uint8Array([1]));
  assert.equal(await readImportedFor(w3, "war3mapImported\\Night.mdx", "sd"), null);
  assert.deepEqual(read, ["map/_hd.w3mod/war3mapimported/hero.mdx"]);
});

const H = "war3mapImported\\Hero.mdx";
const DE_H = `_DE.w3mod\\${H}`;

test("3.0 versions: _DE.w3mod\\ path, flags, a row of three, the files of the modes, Use in", () => {
  assert.equal(dePathOf(H), DE_H);
  assert.equal(dePathOf("war3mapImported/Hero.mdx"), DE_H);
  assert.ok(isDePath("_de.W3MOD/a.blp") && !isDePath("_HD.w3mod\\a.blp") && !isDePath("war3mapImported\\_DE.w3mod\\a.blp"));
  assert.equal(classicPathOf("_DE.w3mod\\x.mdx"), "x.mdx");
  assert.equal(newEntryFlags(DE_H), 13);
  assert.equal(pathForUse(H, "de"), DE_H);
  assert.equal(pathForUse("war3mapImported\\a.lua", "de"), "war3mapImported\\a.lua", "a script has no 3.0 version");
  const e = (flags: number, path: string): ImportEntry => ({ flags, path });
  const plain = e(21, H), hd = e(13, `_HD.w3mod\\${H}`), de = e(13, DE_H.toUpperCase());
  const rows = importRows([de, hd, plain, e(13, `_DE.w3mod\\${H}`)]);
  assert.deepEqual(rows.map((r) => [r.path, r.classic ?? null, r.reforged ?? null, r.de ?? null]), [
    [H, plain, hd, de],
    // A second 3.0 entry of the same name is a row of its own.
    [H, null, null, e(13, DE_H)],
  ]);
  assert.deepEqual(rowEntries(rows[0]), [plain, hd, de]);
  assert.deepEqual(rowMoves(rows[0], "x\\b.mdx").map((m) => m.to), ["x\\b.mdx", "_HD.w3mod\\x\\b.mdx", "_DE.w3mod\\x\\b.mdx"]);
  assert.deepEqual(rowMoves(importRows([de])[0], "_DE.w3mod\\y.mdx").map((m) => m.to), ["_DE.w3mod\\y.mdx"]);
  // A name is taken when any of its three versions is.
  const taken = (have: string) => (p: string) => p.toLowerCase() === have.toLowerCase();
  for (const have of [H, `_HD.w3mod\\${H}`, DE_H]) for (const p of [H, `_HD.w3mod\\${H}`, DE_H]) assert.ok(takenWithVersions(p, taken(have)), `${p} vs ${have}`);
  assert.ok(!takenWithVersions(H, taken("war3mapImported\\Other.mdx")));
  // Each mode reads its own order from the project's files.
  const files = ["map/war3mapImported/Hero.mdx", "map/_HD.w3mod/war3mapImported/Hero.mdx", "map/_DE.w3mod/war3mapImported/Hero.mdx"].map((path) => ({ path, size: 1, modified: 0 }));
  const w3 = (list: typeof files) => ({ workspace: { files: () => list } }) as unknown as W3Api;
  assert.deepEqual(["sd", "hd", "de"].map((m) => importedPathFor(w3(files), H, m)), [files[0].path, files[1].path, files[2].path]);
  // Without the 3.0 file 3.0 reads the Reforged one; without that, the plain one; Reforged never reads the 3.0 one.
  assert.equal(importedPathFor(w3(files.slice(0, 2)), H, "de"), files[1].path);
  assert.equal(importedPathFor(w3([files[0], files[2]]), H, "de"), files[2].path);
  assert.equal(importedPathFor(w3([files[0]]), H, "de"), files[0].path);
  assert.equal(importedPathFor(w3([files[2]]), H, "hd"), undefined);
  assert.equal(importedPathFor(w3([files[2]]), H, "sd"), undefined);
});
