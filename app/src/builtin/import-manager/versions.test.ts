// "Add Reforged Version…" / "Add Classic Version…" store the file at the row's other path under the same name, a row
// shows the version of the graphics mode set, and a model added for one mode brings the textures next to it on disk
// into that mode's folder.

import assert from "node:assert/strict";
import { test } from "node:test";
import { importRows } from "../../lib/imports";
import { bringsTextures, followingTextures, modelTextures, shownEntry, textureSpots, versionsToAdd, versionToAdd } from "./versions";

const plain = { flags: 21, path: "war3mapImported\\Hero.mdx" }, hd = { flags: 13, path: "_HD.w3mod\\war3mapImported\\Hero.mdx" };
const de = { flags: 13, path: "_DE.w3mod\\war3mapImported\\Hero.mdx" };

test("the version a row can still get: Reforged for a plain file, Classic for a Reforged one, 3.0 for a pair, none for all", () => {
  assert.deepEqual(versionToAdd(importRows([plain])[0]), { side: "reforged", path: "_HD.w3mod\\war3mapImported\\Hero.mdx", flags: 13 });
  assert.deepEqual(versionToAdd(importRows([hd])[0]), { side: "classic", path: "war3mapImported\\Hero.mdx", flags: 21 });
  assert.deepEqual(versionToAdd(importRows([plain, hd])[0]), { side: "de", path: "_DE.w3mod\\war3mapImported\\Hero.mdx", flags: 13 });
  assert.equal(versionToAdd(importRows([plain, hd, de])[0]), null);
  // The 3.0 version can be asked for by name; one the row has isn't offered.
  assert.deepEqual(versionToAdd(importRows([plain])[0], "de"), { side: "de", path: "_DE.w3mod\\war3mapImported\\Hero.mdx", flags: 13 });
  assert.equal(versionToAdd(importRows([plain, de])[0], "de"), null);
  assert.deepEqual(versionsToAdd(importRows([de])[0]).map((v) => v.side), ["reforged", "classic"]);
});

test("a row shows the version of the graphics mode set, else the one it has", () => {
  const [pair] = importRows([plain, hd]);
  assert.equal(shownEntry(pair, "sd"), plain);
  assert.equal(shownEntry(pair, "hd"), hd);
  assert.equal(shownEntry(pair, "de"), hd, "3.0 reads the Reforged version when the row has no 3.0 one");
  // A row of three: each mode its own; 3.0 falls back to Reforged, then to the plain file.
  const [three] = importRows([plain, hd, de]);
  assert.deepEqual(["sd", "hd", "de"].map((m) => shownEntry(three, m)), [plain, hd, de]);
  assert.equal(shownEntry(importRows([plain, de])[0], "hd"), plain);
  assert.equal(shownEntry(importRows([de])[0], "sd"), de, "a version no mode of the choice reads is shown when it is all the row has");
  assert.equal(shownEntry(importRows([hd])[0], "sd"), hd);
  assert.equal(shownEntry(importRows([plain])[0], "hd"), plain);
});

test("where a model's texture may lie next to it: the longest tail of its path first, then the .dds Reforged reads", () => {
  assert.deepEqual(textureSpots("/d/pack/", "war3mapImported\\Hero\\skin.blp"), [
    { file: "/d/pack/war3mapImported/Hero/skin.blp", archive: "war3mapImported\\Hero\\skin.blp" },
    { file: "/d/pack/Hero/skin.blp", archive: "war3mapImported\\Hero\\skin.blp" },
    { file: "/d/pack/skin.blp", archive: "war3mapImported\\Hero\\skin.blp" },
    { file: "/d/pack/war3mapImported/Hero/skin.dds", archive: "war3mapImported\\Hero\\skin.dds" },
    { file: "/d/pack/Hero/skin.dds", archive: "war3mapImported\\Hero\\skin.dds" },
    { file: "/d/pack/skin.dds", archive: "war3mapImported\\Hero\\skin.dds" },
  ]);
  // Nothing climbs out of the folder.
  assert.deepEqual(textureSpots("C:\\x", "..\\..\\a.png").map((s) => s.file), ["C:\\x/a.png"]);
  assert.deepEqual(textureSpots("/d", ""), []);
});

test("an .mdl import brings its textures as an .mdx one does: the MDL text's texture list", async () => {
  assert.ok(bringsTextures("war3mapImported\\Hero.mdl") && bringsTextures("_HD.w3mod\\war3mapImported\\Hero.MDL"));
  assert.ok(bringsTextures("war3mapImported\\Hero.mdx"));
  // Control: what isn't a model brings nothing.
  assert.ok(!bringsTextures("war3mapImported\\Hero.blp") && !bringsTextures("war3mapImported\\Hero.mdl.txt"));
  const mdl = new TextEncoder().encode(`Version {
	FormatVersion 1000,
}
Model "Hero" {
	NumGeosets 0,
}
Textures 3 {
	Bitmap { Image "war3mapImported\\Hero_Diffuse.dds", }
	Bitmap { Image "war3mapImported\\Hero_Normal.dds", }
	Bitmap { Image "", ReplaceableId 1, }
}
`);
  const textures = modelTextures(mdl);
  assert.deepEqual(textures, [
    { path: "war3mapImported\\Hero_Diffuse.dds", replaceableId: 0, flags: 0 },
    { path: "war3mapImported\\Hero_Normal.dds", replaceableId: 0, flags: 0 },
    { path: "", replaceableId: 1, flags: 0 },
  ]);
  const disk = new Set(["/d/Hero_Diffuse.dds", "/d/Hero_Normal.dds"]);
  assert.deepEqual(await followingTextures("/d", textures!, (a) => `_HD.w3mod\\${a}`, async (f) => disk.has(f), () => false), [
    { file: "/d/Hero_Diffuse.dds", archive: "_HD.w3mod\\war3mapImported\\Hero_Diffuse.dds" },
    { file: "/d/Hero_Normal.dds", archive: "_HD.w3mod\\war3mapImported\\Hero_Normal.dds" },
  ]);
  // Bytes that are no model (MDX or MDL) bring none, without throwing.
  assert.equal(modelTextures(new TextEncoder().encode("just a readme")), null);
});

test("the textures that follow a model: found next to it, not replaceable, once each, not where the map has a file", async () => {
  const disk = new Set(["/d/skin.blp", "/d/Hero/glow.dds", "/d/taken.blp"]);
  const textures = [
    { path: "war3mapImported\\skin.blp", replaceableId: 0 },
    { path: "war3mapImported\\Hero\\glow.blp", replaceableId: 0 },
    { path: "war3mapImported\\SKIN.blp", replaceableId: 0 },
    { path: "", replaceableId: 1 },
    { path: "ReplaceableTextures\\TeamColor\\TeamColor00.blp", replaceableId: 1 },
    { path: "war3mapImported\\missing.blp", replaceableId: 0 },
    { path: "taken.blp", replaceableId: 0 },
    { path: "C:\\Users\\me\\abs.blp", replaceableId: 0 },
  ];
  const asked: string[] = [];
  const found = await followingTextures("/d", textures, (a) => `_HD.w3mod\\${a}`,
    async (f) => { asked.push(f); return disk.has(f); }, (a) => a.toLowerCase() === "_hd.w3mod\\taken.blp");
  assert.deepEqual(found, [
    { file: "/d/skin.blp", archive: "_HD.w3mod\\war3mapImported\\skin.blp" },
    { file: "/d/Hero/glow.dds", archive: "_HD.w3mod\\war3mapImported\\Hero\\glow.dds" },
  ]);
  assert.ok(!asked.some((f) => /abs\.blp|TeamColor/.test(f)), "a path on someone's disk or a replaceable texture isn't looked for");
  // Control: with nothing next to the model, none follows.
  assert.deepEqual(await followingTextures("/d", textures, (a) => a, async () => false, () => false), []);
});
