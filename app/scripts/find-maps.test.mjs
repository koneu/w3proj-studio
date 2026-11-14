// find-maps.mjs (twin-check's map list): the maps of a folder as `w3proj verify` finds them. Projects below the folder
// (folders holding w3proj.toml) are left out with what they packed (build/, checkpoints), also when those were written
// with Windows separators on Linux; a project folder given directly is searched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { findMaps } from "./find-maps.mjs";

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "w3proj-find-maps-"));
  for (const f of files) {
    const path = join(root, ...f.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  return root;
}

const listed = (root, args) => findMaps(args).map((p) => relative(root, p).split(sep).join("/"));

test("projects' build outputs and checkpoints are left out, maps beside them are not", (t) => {
  const files = [
    "a.w3x",
    "c.w3n",
    "maps/b.W3M",
    "proj/w3proj.toml",
    "proj/build/Proj.w3x",
    "proj/build/checkpoints/Proj-1.w3x",
    "proj/map/notes.txt",
    "other/deep/d.w3x",
  ];
  // On Linux a backslash is part of a name: a project packed with Windows separators leaves these next to it.
  const misnamed = process.platform === "win32" ? [] : ["proj\\build\\checkpoints\\Proj-2.w3x", "x\\y.w3x"];
  const root = tree([...files, ...misnamed]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const want = ["a.w3x", "maps/b.W3M", "other/deep/d.w3x"];
  // "x\y.w3x": no project "x" beside it, so it's a map with an odd name and stays.
  if (misnamed.length) want.push("x\\y.w3x");
  assert.deepEqual(listed(root, [root]).sort(), want.sort());

  // A project given directly is searched, but its build folder is still left out.
  assert.deepEqual(listed(root, [join(root, "proj")]), []);
  // The control: a folder named build given directly is searched.
  assert.deepEqual(listed(root, [join(root, "proj", "build")]).sort(), ["proj/build/Proj.w3x", "proj/build/checkpoints/Proj-1.w3x"]);
  // A map named directly is checked whatever it is.
  assert.deepEqual(listed(root, [join(root, "proj", "build", "Proj.w3x")]), ["proj/build/Proj.w3x"]);
});
