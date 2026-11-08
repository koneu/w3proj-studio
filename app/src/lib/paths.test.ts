import test from "node:test";
import assert from "node:assert/strict";
import { gameProgram, isAbsolutePath, isFullPath, joinPath } from "./paths";

test("gameProgram: the path set for it wins; else the program in the game's folder", () => {
  assert.equal(gameProgram(undefined, "C:\\Program Files (x86)\\Warcraft III", "World Editor.exe"), "C:\\Program Files (x86)\\Warcraft III\\_retail_\\x86_64\\World Editor.exe");
  const steam = "/home/u/.steam/steamapps/compatdata/1/pfx/drive_c/Program Files (x86)/Warcraft III";
  assert.equal(gameProgram(undefined, steam, "Warcraft III.exe"), `${steam}/_retail_/x86_64/Warcraft III.exe`);
  assert.equal(gameProgram("D:\\WE\\World Editor.exe", steam, "World Editor.exe"), "D:\\WE\\World Editor.exe");
  assert.equal(gameProgram("  ", steam, "Warcraft III.exe"), `${steam}/_retail_/x86_64/Warcraft III.exe`);
});

test("isFullPath: a full path on either system; a project path isn't one", () => {
  for (const p of ["C:\\maps", "c:/maps", "\\\\server\\share", "/home/u/maps", "/"]) assert.equal(isFullPath(p, false), true, p);
  for (const p of ["map/war3map.j", "maps\\x", "", "C:", "war3map.j"]) assert.equal(isFullPath(p, false), false, p);
});

test("isFullPath on Windows: a leading slash is the current drive's root, not a full path", () => {
  for (const p of ["C:\\maps", "c:/maps", "\\\\server\\share"]) assert.equal(isFullPath(p, true), true, p);
  for (const p of ["/tmp", "/", "map/x"]) assert.equal(isFullPath(p, true), false, p);
});

// Project roots come from the backend in the system's own form: `C:\…` or `\\server\…` on Windows, `/…` on Linux.
// A file path inside the project is always written with `/`.

test("joinPath: a Windows root gets backslashes", () => {
  assert.equal(joinPath("C:\\maps\\a", "map/war3map.w3e.txt"), "C:\\maps\\a\\map\\war3map.w3e.txt");
  assert.equal(joinPath("C:\\maps\\a\\", "map/x"), "C:\\maps\\a\\map\\x");
  assert.equal(joinPath("\\\\server\\share\\a", "map/x"), "\\\\server\\share\\a\\map\\x");
});

test("joinPath: a Linux root gets slashes, and no backslash ends up in the path", () => {
  // A backslash is an ordinary character in a Linux file name: `/home/u/a\map\x` is one file next to the project.
  assert.equal(joinPath("/home/u/a", "map/war3map.w3e.txt"), "/home/u/a/map/war3map.w3e.txt");
  assert.equal(joinPath("/home/u/a/", "map/x"), "/home/u/a/map/x");
  assert.equal(joinPath("/home/u/a", "map\\x"), "/home/u/a/map/x");
  assert.equal(joinPath("/", "w3proj.toml"), "/w3proj.toml");
});

test("joinPath: several parts, and parts with either separator", () => {
  assert.equal(joinPath("/home/u/a", "build", "checkpoints", "x.w3x"), "/home/u/a/build/checkpoints/x.w3x");
  assert.equal(joinPath("C:\\a", "build/checkpoints", "x.w3x"), "C:\\a\\build\\checkpoints\\x.w3x");
  assert.equal(joinPath("C:\\", "a"), "C:\\a");
  assert.equal(joinPath("/home/u/a"), "/home/u/a");
});

test("isAbsolutePath: absolute in the root's system, relative otherwise", () => {
  assert.equal(isAbsolutePath("C:\\x\\y", "C:\\maps\\a"), true);
  assert.equal(isAbsolutePath("\\\\server\\x", "C:\\maps\\a"), true);
  assert.equal(isAbsolutePath("map/x", "C:\\maps\\a"), false);
  assert.equal(isAbsolutePath("/home/u/b/x", "/home/u/a"), true);
  assert.equal(isAbsolutePath("map/x", "/home/u/a"), false);
  // On Windows a leading slash isn't a full path, so it stays relative to the project as before.
  assert.equal(isAbsolutePath("/map/x", "C:\\maps\\a"), false);
});
