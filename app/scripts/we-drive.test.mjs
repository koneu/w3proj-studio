// The parts of we-drive.mjs and we-setup.mjs that don't need the game: the editor's preferences, sorting its windows,
// the farm's copy rule, the snapshot comparison and the lock. Running the editor itself is local only (TESTING.md).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCamerasToMap, classify, editorPrefs, isReopenedModule, parseArgs, questionDialogs, setPrefs, VIEW_ITEMS, viewChecks, winePath } from "./we-drive.mjs";
import { lookName, PARK_NAMES } from "./we-camera.mjs";
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

test("questionDialogs: the loading windows (untitled, \"Progress\") aren't questions; titled dialogs are", () => {
  const d = (title) => ({ id: 1, title, rect: [600, 400, 300, 100] });
  assert.deepEqual(questionDialogs([d(""), d("Progress")]), [], "a big map's \"Loading Units n/300\" window is waited for");
  assert.deepEqual(questionDialogs([d("Progress"), d("Warning"), d("Warcraft III World Editor")]).map((x) => x.title), ["Warning", "Warcraft III World Editor"]);
  assert.deepEqual(questionDialogs([d("Progress report")]).map((x) => x.title), ["Progress report"], "only the loading window's own title");
});

test("isReopenedModule: the modules the editor opens again, the Campaign Editor by the start of its title", () => {
  for (const t of ["Trigger Editor", "Object Editor", "Campaign Editor", "Campaign Editor - [Untitled]", "Campaign Editor - [Z:/c/a.w3n]"]) {
    assert.equal(isReopenedModule(t), true, t);
  }
  for (const t of ["", "Warning", "Progress", "Warcraft III World Editor", "Trigger Editor - x", "Campaign Editors", undefined]) {
    assert.equal(isReopenedModule(t), false, String(t));
  }
});

test("viewChecks reads the View menu's check marks from a picture of its check column", () => {
  const width = 18, height = 480;
  const column = { width, height, rgba: new Uint8Array(width * height * 4).fill(240) };
  // A mark (dark pixels) in the rows of Lighting and Lock to Game View Settings; one stray dark pixel in Sky's.
  const ink = (y0, n) => { for (let i = 0; i < n; i++) { const o = ((y0 + Math.floor(i / 6)) * width + 6 + (i % 6)) * 4; column.rgba[o] = column.rgba[o + 1] = column.rgba[o + 2] = 20; } };
  const at = (name) => VIEW_ITEMS.find((v) => v.item === name).y;
  ink(at("Lighting") - 3, 18);
  ink(at("Lock to Game View Settings") - 3, 18);
  ink(at("Sky"), 1);
  const checks = viewChecks({ ...column, rgba: column.rgba });
  assert.deepEqual(checks.filter((c) => c.checked).map((c) => c.item), ["Lighting", "Lock to Game View Settings"]);
  assert.equal(checks.find((c) => c.item === "Sky").dark, 1);
  assert.equal(checks.length, VIEW_ITEMS.length);
  assert.ok(VIEW_ITEMS.every((v, i) => i === 0 || v.y - VIEW_ITEMS[i - 1].y >= 16), "the rows don't overlap");
});

test("parseArgs: the day and night fixed by default; --compare-ready refuses a turning day", () => {
  assert.equal(parseArgs(["--start"]).opts.dayNight, "fixed");
  assert.equal(parseArgs(["--day-night", "cycle", "--start"]).opts.dayNight, "cycle");
  assert.deepEqual(parseArgs(["--map", "m.w3x", "--compare-ready"]).steps.map(([s]) => s), ["--map", "--compare-ready"]);
  assert.throws(() => parseArgs(["--day-night", "cycle", "--map", "m.w3x", "--compare-ready"]), /day and night fixed/);
});

test("parseArgs: the looks are parsed up front, need a map before them, and are numbered in order", () => {
  const { looks, steps } = parseArgs(["--map", "m.w3x", "--wait-ready", "--look", "center", "--shot", "a.png", "--look", "100,200,2000"]);
  assert.deepEqual(looks.map((l) => [l.center, l.x, l.y, l.distance]), [[true, null, null, 3000], [false, 100, 200, 2000]]);
  assert.deepEqual(steps.filter(([s]) => s === "--look").map(([, v]) => v), ["center", "100,200,2000"]);
  assert.throws(() => parseArgs(["--look", "1,2", "--map", "m.w3x"]), /--map before it/);
  assert.throws(() => parseArgs(["--start", "--look", "1,2"]), /needs --map/);
  assert.throws(() => parseArgs(["--map", "m.w3x", "--look", "1"]), /a look is/);
  assert.throws(() => parseArgs(["--map", "m.w3x", ...Array.from({ length: 17 }, () => ["--look", "1,2"]).flat()]), /at most 16/);
});

test("parseArgs: --save takes the file to copy the saved map to, and needs a map before it", () => {
  assert.deepEqual(parseArgs(["--map", "m.w3x", "--wait-ready", "--save", "out.w3x", "--close"]).steps,
    [["--map", "m.w3x"], ["--wait-ready", null], ["--save", "out.w3x"], ["--close", null]]);
  assert.throws(() => parseArgs(["--start", "--save", "out.w3x"]), /--save needs --map/);
  assert.throws(() => parseArgs(["--save", "out.w3x", "--map", "m.w3x"]), /--save needs --map/);
  assert.throws(() => parseArgs(["--map", "m.w3x", "--save"]), /needs a value/);
});

test("addCamerasToMap: the looks' cameras go first in war3map.w3c.json, a missing file is made, an unreadable one refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "we-look-"));
  try {
    const copy = join(dir, "m.w3x"), project = join(dir, "p");
    writeFileSync(copy, "map");
    const looks = parseArgs(["--map", copy, "--look", "center", "--look", "10,20,1500"]).looks;
    // A stand-in for the CLI: unpack writes the project's files, pack keeps the cameras it finds.
    const cli = (files) => {
      let packed = null;
      const run = (args) => {
        if (args[0] === "unpack") {
          assert.deepEqual([args[1], args[2], args[3], args[4]], [copy, project, "--game", "none"]);
          mkdirSync(join(project, "map"), { recursive: true });
          for (const [name, text] of Object.entries(files)) writeFileSync(join(project, "map", name), text);
        } else if (args[0] === "pack") {
          assert.deepEqual(args, ["pack", project, "--output", copy]);
          packed = JSON.parse(readFileSync(join(project, "map", "war3map.w3c.json"), "utf8"));
        }
      };
      return { run, packed: () => packed };
    };
    const w3e = "W3E version 11\ncorners 5 3\noffset -128 -64\n";
    const own = { format: "w3proj.cameras/1", version: 0, localAngles: true, cameras: [{ targetX: 1, targetY: 2, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, farZ: 5000, nearZ: 100, localPitch: 0, localYaw: 0, localRoll: 0, name: "Intro" }] };
    const withOwn = cli({ "war3map.w3e.txt": w3e, "war3map.w3c.json": JSON.stringify(own) });
    const { looks: resolved, parks } = addCamerasToMap(withOwn.run, copy, project, looks);
    assert.deepEqual(resolved.map((l) => [l.x, l.y, l.distance]), [[128, 64, 3000], [10, 20, 1500]]);
    assert.deepEqual(parks.map((p) => [p.x, p.y]), [[-128, -64], [384, 192]], "parking cameras at the terrain's corners");
    assert.deepEqual(withOwn.packed().cameras.map((c) => c.name), [lookName(0), lookName(1), ...PARK_NAMES, "Intro"]);
    assert.deepEqual([withOwn.packed().cameras[0].targetX, withOwn.packed().cameras[0].targetY], [128, 64]);

    const none = cli({ "war3map.w3e.txt": w3e });
    addCamerasToMap(none.run, copy, project, looks);
    assert.equal(none.packed().version, 3, "no camera file: one is made");
    assert.equal(none.packed().cameras.length, 4);

    const unreadable = cli({ "war3map.w3e.txt": w3e, "war3map.w3c": "\u0007garbage" });
    assert.throws(() => addCamerasToMap(unreadable.run, copy, project, looks), /can't be read by the cameras codec/);
    assert.equal(unreadable.packed(), null, "nothing is packed over the copy");

    const noTerrain = cli({});
    assert.throws(() => addCamerasToMap(noTerrain.run, copy, project, looks), /needs the terrain's size/);
    // Without a centre look, no terrain is needed (and there are no parking cameras).
    assert.deepEqual(addCamerasToMap(noTerrain.run, copy, project, looks.slice(1)).parks, []);
    assert.deepEqual(noTerrain.packed().cameras.map((c) => c.targetX), [10]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
