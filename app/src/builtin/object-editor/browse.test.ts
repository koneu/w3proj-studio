import assert from "node:assert/strict";
import { test } from "node:test";
import { folderTree, foldersOf, inFolder, labelFiles, storedSound } from "./browse";

const paths = ["Units\\Human\\Footman\\Footman.mdl", "Units\\Human\\Knight\\Knight.mdl", "units\\Orc\\Grunt\\Grunt.mdl", "Doodads\\Rock.mdl", "war3mapImported\\x.mdl", "Top.mdl"];

test("folders nest, count what lies under them, and come in name order", () => {
  const root = folderTree(paths);
  assert.equal(root.files, 6);
  assert.deepEqual(root.children.map((f) => f.name), ["Doodads", "Units", "war3mapImported"]);
  const units = root.children[1];
  assert.equal(units.files, 3);
  assert.deepEqual(units.children.map((f) => [f.name, f.files]), [["Human", 2], ["Orc", 1]]);
  assert.equal(units.children[0].children[0].path, "Units\\Human\\Footman");
});

test("case doesn't make two folders", () => {
  assert.equal(folderTree(["A\\x.mdl", "a\\y.mdl"]).children.length, 1);
});

test("a folder holds what's under it, and no folder merely starting the same", () => {
  assert.ok(inFolder("Units\\Human\\Footman.mdl", "Units"));
  assert.ok(inFolder("units\\Human\\Footman.mdl", "Units\\Human"));
  assert.ok(!inFolder("Units2\\x.mdl", "Units"));
  assert.ok(inFolder("Top.mdl", ""));
});

test("a path opens the tree down to its own folder", () => {
  assert.deepEqual(foldersOf("A\\B\\c.mdl"), ["A", "A\\B"]);
  assert.deepEqual(foldersOf("c.mdl"), []);
});

test("a label plays its first file, and the first row of a label counts", () => {
  const files = labelFiles([
    { SoundName: "Roar", FileNames: "Abilities/Roar1.wav, Abilities/Roar2.wav" },
    { SoundName: "Roar", FileNames: "Other.wav" },
    { SoundName: "Mute", FileNames: "" },
  ]);
  assert.equal(files.get("Roar"), "Abilities\\Roar1.wav");
  assert.ok(!files.has("Mute"));
});

test("a sound is found whatever its extension, and by bare name", () => {
  const game = ["Sound\\Roar.flac", "Units\\Human\\Footman\\FootmanWhat1.flac", "Units\\Footman.mdl"];
  assert.equal(storedSound("Sound\\Roar.wav", game), "Sound\\Roar.flac");
  assert.equal(storedSound("FootmanWhat1.wav", game), "Units\\Human\\Footman\\FootmanWhat1.flac");
  assert.equal(storedSound("Footman.wav", game), null, "only sound files count");
  assert.equal(storedSound("Nothing.wav", game), null);
});
