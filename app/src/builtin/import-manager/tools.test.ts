import assert from "node:assert/strict";
import { test } from "node:test";
import { addImport, describeImports, emptyImports, importTarget, removeImport, type ProjectFiles } from "./tools";
import { IMPORT_FOLDER, NEW_IMPORT_FLAGS } from "../../lib/imports";

const filesOf = (...paths: string[]): ProjectFiles => new Map(paths.map((p) => [p.toLowerCase(), { path: p, size: 10 }]));

test("import_file's place: the import folder under the file's name, numbered when taken, or the path asked for", () => {
  const doc = emptyImports();
  assert.deepEqual(importTarget(doc, filesOf(), "/home/me/Horn.mp3", undefined, IMPORT_FOLDER), { archive: "war3mapImported\\Horn.mp3", file: "map/war3mapImported/Horn.mp3" });
  addImport(doc, "war3mapImported\\Horn.mp3");
  assert.equal(importTarget(doc, filesOf(), "C:\\sounds\\Horn.mp3", undefined, IMPORT_FOLDER).archive, "war3mapImported\\Horn (2).mp3");
  assert.deepEqual(importTarget(doc, filesOf(), "/x/a.mdx", "Units/Human/Footman/Footman.mdx", IMPORT_FOLDER), { archive: "Units\\Human\\Footman\\Footman.mdx", file: "map/Units/Human/Footman/Footman.mdx" });
});

test("a path that isn't inside the map, is the map's own file or is taken is refused", () => {
  const doc = emptyImports();
  addImport(doc, "war3mapImported\\Horn.mp3");
  const files = filesOf("map/Textures/Sky.blp");
  const at = (path: unknown) => () => importTarget(doc, files, "/x/a.blp", path, IMPORT_FOLDER);
  assert.throws(at("..\\outside.blp"), /isn't a path inside the map/);
  assert.throws(at("C:\\x.blp"), /isn't a path inside the map/);
  assert.throws(at("a\\\\b.blp"), /isn't a path inside the map/);
  assert.throws(at(""), /path must be the file's path in the map/);
  assert.throws(at("war3map.w3e"), /one of the map's own files/);
  assert.throws(at("war3mapImported/horn.MP3"), /already has war3mapImported\\horn.MP3/);
  assert.throws(at("textures\\sky.blp"), /already has/);
  // A model or image's other graphics mode version counts as taken too.
  assert.throws(at("_HD.w3mod\\Textures\\Sky.blp"), /already has/);
});

test("entries are added with a new import's flags, listed with their files, and removed by path", () => {
  const doc = emptyImports();
  assert.equal(addImport(doc, "war3mapImported\\Horn.mp3"), true);
  assert.equal(addImport(doc, "WAR3MAPIMPORTED\\horn.mp3"), false, "listed already, in any case");
  assert.deepEqual(doc.files, [{ flags: NEW_IMPORT_FLAGS, path: "war3mapImported\\Horn.mp3" }]);
  // A standard-path entry (flags 8) is named without the import folder and found inside it.
  doc.files.push({ flags: 8, path: "Icon.blp" }, { flags: 13, path: "Gone.mdx" });
  const files = filesOf("map/war3mapImported/Horn.mp3", "map/war3mapImported/Icon.blp");
  assert.deepEqual(describeImports(doc, files, IMPORT_FOLDER), [
    { path: "war3mapImported\\Horn.mp3", file: "map/war3mapImported/Horn.mp3", size: 10 },
    { path: "Icon.blp", file: "map/war3mapImported/Icon.blp", size: 10 },
    { path: "Gone.mdx", missing: true },
  ]);
  assert.throws(() => removeImport(doc, files, "Nope.blp", IMPORT_FOLDER), /Nope.blp isn't in the import list/);
  assert.deepEqual(removeImport(doc, files, "war3mapImported/Icon.blp", IMPORT_FOLDER), { entry: { flags: 8, path: "Icon.blp" }, file: "map/war3mapImported/Icon.blp" });
  assert.deepEqual(removeImport(doc, files, "Gone.mdx", IMPORT_FOLDER), { entry: { flags: 13, path: "Gone.mdx" } });
  assert.equal(removeImport(doc, files, "war3mapimported\\horn.mp3", IMPORT_FOLDER).file, "map/war3mapImported/Horn.mp3");
  assert.equal(doc.files.length, 0);
});
