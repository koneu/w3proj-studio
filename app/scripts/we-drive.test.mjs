// The parts of we-drive.mjs and we-setup.mjs that don't need the game: the editor's preferences, sorting its windows,
// the farm's copy rule, the snapshot comparison and the lock. Running the editor itself is local only (TESTING.md).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, editorPrefs, setPrefs, winePath } from "./we-drive.mjs";
import { compare, isCopied, takeLock, userCompatData } from "./we-setup.mjs";

const PREFS = ["[Misc]", "assetMode=-1", "Has Been Run=false", "hd=1", "Undo Limit=0", "", "[Test Map]", "hd=0", "teen=0", ""].join("\r\n");

test("setPrefs changes keys of one section in place, adds the missing ones there, and leaves the rest", () => {
  const out = setPrefs(PREFS, "Misc", { hd: "0", "Has Been Run": "true", Units: "0" });
  assert.equal(out, ["[Misc]", "assetMode=-1", "Has Been Run=true", "hd=0", "Undo Limit=0", "Units=0", "", "[Test Map]", "hd=0", "teen=0", ""].join("\r\n"));
  assert.equal(setPrefs(out, "Misc", { hd: "0", "Has Been Run": "true", Units: "0" }), out, "setting the same again changes nothing");
});

test("setPrefs makes the section when the file is empty or lacks it", () => {
  assert.equal(setPrefs("", "Misc", { hd: "1" }), "[Misc]\nhd=1\n");
  assert.equal(setPrefs("[Video]\nx=1\n", "Misc", { hd: "1" }), "[Video]\nx=1\n\n[Misc]\nhd=1\n");
});

test("editorPrefs: sd turns the Reforged switches off, hd on; first-start questions and interface sounds are off", () => {
  const sd = editorPrefs("sd", "cycle"), hd = editorPrefs("hd", "fixed");
  for (const k of ["assetMode", "hd", "Buildings", "Environment", "EnvOld", "Heroes", "Icons", "Textures", "Units", "Vfx"]) {
    assert.equal(sd[k], "0", `sd ${k}`);
    assert.equal(hd[k], "1", `hd ${k}`);
  }
  assert.equal(sd["Has Been Run"], "true");
  assert.equal(sd["Editor User Interface Sound"], "0");
  assert.equal(sd["Fixed Day Night Cycle"], "0");
  assert.equal(hd["Fixed Day Night Cycle"], "1");
  assert.throws(() => editorPrefs("ultra", "cycle"), /sd or hd/);
  assert.throws(() => editorPrefs("hd", "noon"), /cycle or fixed/);
});

test("classify tells the main window, the palettes, dialogs and menus apart", () => {
  const w = (title, rect, extra = {}) => ({ id: rect[0] + 1, title, rect, overrideRedirect: false, ...extra });
  const windows = [
    w("", [0, 0, 1, 1], { overrideRedirect: true }),
    w("Tool Palette", [1356, 30, 240, 600]),
    w("Warcraft III World Editor - [Z:/m/a.w3x]", [4, 30, 1352, 937]),
    w("Warcraft III World Editor", [547, 409, 506, 208]),
    w("Warning", [563, 475, 473, 76]),
    w("", [65, 49, 243, 483], { overrideRedirect: true }),
  ];
  const c = classify(windows);
  assert.equal(c.main.title, "Warcraft III World Editor - [Z:/m/a.w3x]");
  assert.deepEqual(c.palettes.map((x) => x.title), ["Tool Palette"]);
  assert.deepEqual(c.dialogs.map((x) => x.title), ["Warcraft III World Editor", "Warning"], "a small window with the editor's title is an error box, not the main window");
  assert.deepEqual(c.menus.map((x) => x.rect), [[65, 49, 243, 483]]);
  assert.equal(classify(windows.slice(3)).main, null);
});

test("winePath puts a Linux path on Wine's Z: drive", () => {
  assert.equal(winePath("/home/u/maps/a b.w3x"), String.raw`Z:\home\u\maps\a b.w3x`);
});

test("the farm copies only what the editor writes; everything else is a hardlink", () => {
  for (const p of ["Data/data/0000000035.idx", "Data/data/shmem", "Data/ecache/data.000", "Data/ecache/0300000001.idx", ".battle.net/ecache/shmem"]) assert.ok(isCopied(p), p);
  for (const p of ["Data/data/data.000", "Data/indices/0a.index", "_retail_/x86_64/World Editor.exe", ".build.info", "Data/config/3a/b4/x"]) assert.ok(!isCopied(p), p);
});

test("userCompatData finds the Steam prefix around an install", () => {
  assert.equal(userCompatData("/s/steamapps/compatdata/4104009084/pfx/drive_c/Program Files (x86)/Warcraft III"), "/s/steamapps/compatdata/4104009084");
  assert.equal(userCompatData("/games/Warcraft III"), null);
});

test("compare fails only on changes under the guarded paths", () => {
  const e = (sha) => ({ size: 1, mtime: "1", ctime: "1", ino: "1", sha256: sha });
  const a = { files: { "/p/install/a": e("x"), "/p/install/b": e("y"), "/p/logs/l": e("z") } };
  const b = { files: { "/p/install/a": e("x"), "/p/install/c": e("w"), "/p/logs/l": e("q") } };
  const r = compare(a, b, ["/p/install"]);
  assert.deepEqual(r.guardedChanged.sort(), ["/p/install/b", "/p/install/c"]);
  assert.deepEqual(r.elsewhereChanged, ["/p/logs/l"]);
  assert.deepEqual(compare(a, a, ["/p/install"]).guardedChanged, []);
  assert.deepEqual(compare(a, { files: { ...a.files, "/p/installer": e("n") } }, ["/p/install"]).guardedChanged, [], "a sibling with the same prefix isn't guarded");
});

test("the lock: a second run waits and gives up; a lock whose process is gone is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "we-lock-"));
  const before = process.env.W3PROJ_WE_DIR;
  process.env.W3PROJ_WE_DIR = dir;
  try {
    const release = await takeLock(() => {});
    assert.ok(existsSync(join(dir, "lock", "owner.json")));
    const said = [];
    await assert.rejects(takeLock((m) => said.push(m), 1500), /still holds/);
    assert.match(said.join("\n"), /waiting for the World Editor run/);
    release();
    assert.ok(!existsSync(join(dir, "lock")));
    // A process id that can't be running.
    mkdirSync(join(dir, "lock"));
    writeFileSync(join(dir, "lock", "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, repo: "elsewhere", since: "then" }));
    const took = [];
    const again = await takeLock((m) => took.push(m), 5000);
    assert.match(took.join("\n"), /took over the World Editor lock of elsewhere/);
    again();
  } finally {
    if (before === undefined) delete process.env.W3PROJ_WE_DIR; else process.env.W3PROJ_WE_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
