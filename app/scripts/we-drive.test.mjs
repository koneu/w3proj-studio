// The parts of we-drive.mjs and we-setup.mjs that don't need the game: the editor's preferences, sorting its windows,
// the farm's copy rule, the snapshot comparison and the lock. Running the editor itself is local only (TESTING.md).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addCamerasToMap, classify, closeAction, crashDialogs, CRASH_MESSAGE, EditorCrashed, isCrashDialog, editorPrefs, PINNED_PREFS, programName, isReopenedModule, mapAction, openCopyName, openQuestion, parseArgs, questionDialogs, setPrefs, VIEW_ITEMS, viewChecks, winePath } from "./we-drive.mjs";
import { lookName, PARK_NAMES } from "./we-camera.mjs";
import { compare, isCopied, lockPath, takeLock, userCompatData } from "./we-setup.mjs";

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
  const de = editorPrefs("de", "fixed");
  assert.equal(de.assetMode, "2", "de is the editor's third Asset Mode entry");
  assert.equal(de.hd, "1");
  assert.equal(editorPrefs("hd", "fixed").assetMode, "1");
  assert.equal(editorPrefs("sd", "fixed").assetMode, "0");
  assert.throws(() => editorPrefs("ultra", "cycle"), /sd, hd or de/);
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
  assert.deepEqual(questionDialogs([d("Trigger Editor"), d("Object Editor"), d("Warning")]).map((x) => x.title), ["Warning"], "a module window open during a save isn't a question");
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

test("parseArgs: --drag takes its two positions (and a duration) as one value; --drag-mod belongs to the next drag", () => {
  assert.deepEqual(parseArgs(["--map", "m.w3x", "--drag", "375,200:570,255", "--key", "ctrl+c"]).steps, [["--map", "m.w3x"], ["--drag", { from: "375,200", to: "570,255", ms: 400 }], ["--key", "ctrl+c"]]);
  assert.deepEqual(parseArgs(["--drag-mod", "alt", "--drag", "1,2:3,4@900", "--drag", "5,6:7,8"]).steps, [["--drag", { from: "1,2", to: "3,4", ms: 900, mod: "alt" }], ["--drag", { from: "5,6", to: "7,8", ms: 400 }]]);
  for (const bad of ["1,2", "1,2:3", "1,2:3,4@5", "1,2:3,4@x", "-1,2:3,4", ""]) assert.throws(() => parseArgs(["--drag", bad]), /--drag/, bad);
  assert.throws(() => parseArgs(["--drag-mod", "meta", "--drag", "1,2:3,4"]), /--drag-mod wants/);
  assert.throws(() => parseArgs(["--drag-mod", "alt"]), /needs a --drag/);
  assert.deepEqual(parseArgs(["--drag-button", "3", "--drag", "1,2:3,4", "--drag", "5,6:7,8"]).steps, [["--drag", { from: "1,2", to: "3,4", ms: 400, button: 3 }], ["--drag", { from: "5,6", to: "7,8", ms: 400 }]]);
  assert.throws(() => parseArgs(["--drag-button", "4", "--drag", "1,2:3,4"]), /--drag-button wants/);
  assert.throws(() => parseArgs(["--drag-button", "2"]), /needs a --drag/);
});

test("we-x11 drag path: even steps from the press to exactly the release point (python, no display)", (t) => {
  const run = (...a) => spawnSync("python3", ["-I", join(dirname(fileURLToPath(import.meta.url)), "we-x11.py"), "drag", ...a, "--dry"], { encoding: "utf8" });
  const probe = run("0,0", "1,1");
  if (probe.status !== 0) return t.skip("python3 with Pillow isn't here");
  const path = JSON.parse(run("100,100", "300,60", "--steps", "4").stdout).path;
  assert.deepEqual(path, [[150, 90], [200, 80], [250, 70], [300, 60]]);
  assert.deepEqual(JSON.parse(run("5,5", "5,5", "--steps", "0").stdout).path, [[5, 5]]);
});

test("parseArgs: --screen sets the display's size, a held key keeps its @MS in the step", () => {
  assert.equal(parseArgs(["--start"]).opts.screen, undefined);
  assert.deepEqual(parseArgs(["--screen", "1200x700", "--start"]).opts.screen, [1200, 700]);
  assert.throws(() => parseArgs(["--screen", "1200,700", "--start"]), /WxH/);
  assert.deepEqual(parseArgs(["--start", "--key", "ctrl+Up@1500"]).steps, [["--start", null], ["--key", "ctrl+Up@1500"]]);
});

test("parseArgs: --close-modules is a step without a value", () => {
  assert.deepEqual(parseArgs(["--start", "--close-modules", "--sleep", "5"]).steps, [["--start", null], ["--close-modules", null], ["--sleep", "5"]]);
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
  const lock = join(dir, "machine.lock");
  const save = { we: process.env.W3PROJ_WE_DIR, lock: process.env.W3PROJ_WE_LOCK };
  process.env.W3PROJ_WE_LOCK = lock;
  try {
    // Two holders with different farm folders: the lock is the same one.
    process.env.W3PROJ_WE_DIR = join(dir, "farm-a");
    const release = await takeLock(() => {});
    assert.ok(existsSync(join(lock, "owner.json")));
    process.env.W3PROJ_WE_DIR = join(dir, "farm-b");
    const said = [];
    await assert.rejects(takeLock((m) => said.push(m), 1500), /still holds/);
    assert.equal(said.length, 1, "said once");
    assert.match(said[0], /waiting for the World Editor run of .*process \d+, since \d{4}-/);
    release();
    assert.ok(!existsSync(lock));
    // A process id that can't be running.
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, repo: "elsewhere", since: "then" }));
    const took = [];
    const again = await takeLock((m) => took.push(m), 5000);
    assert.match(took.join("\n"), /took over the World Editor lock of elsewhere/);
    again();
  } finally {
    for (const [k, v] of [["W3PROJ_WE_DIR", save.we], ["W3PROJ_WE_LOCK", save.lock]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock's place is per user, outside every farm", () => {
  const save = { we: process.env.W3PROJ_WE_DIR, lock: process.env.W3PROJ_WE_LOCK };
  delete process.env.W3PROJ_WE_LOCK;
  try {
    process.env.W3PROJ_WE_DIR = join(tmpdir(), "farm-x");
    const a = lockPath();
    process.env.W3PROJ_WE_DIR = join(tmpdir(), "farm-y");
    assert.equal(lockPath(), a);
    assert.ok(!a.startsWith(join(tmpdir(), "farm-")));
  } finally {
    for (const [k, v] of [["W3PROJ_WE_DIR", save.we], ["W3PROJ_WE_LOCK", save.lock]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const win = (title, extra = {}) => ({ id: 1, title, class: null, rect: [0, 0, 400, 300], overrideRedirect: false, ...extra });

test("isCrashDialog recognises the crash report by title, class or owning process, and nothing the editor shows itself", () => {
  for (const t of ["Warcraft III Crash Report", "Blizzard Error", "Error Report", "BugSplat", "Send Error Report to Blizzard"]) {
    assert.ok(isCrashDialog(win(t)), t);
  }
  assert.ok(isCrashDialog(win("", { class: "BlizzardError" })));
  assert.ok(isCrashDialog(win("Report"), "BlizzardError.exe"), "by the owning program");
  for (const t of ["Warning", "Progress", "Reminder", "Warcraft III World Editor - [x.w3x]", "Trigger Editor", "Terrain Palette", ""]) {
    assert.ok(!isCrashDialog(win(t)), t);
  }
  assert.ok(!isCrashDialog(win("Crash", { overrideRedirect: true })), "a menu or tooltip is no dialog");
  // Seen for real: a worktree called we-crash-dialog in the map's path made the main window a "crash".
  assert.ok(!isCrashDialog(win("Warcraft III World Editor - [Z:/home/u/.worktrees/we-crash-dialog/target/maps/m.w3m]")), "the map's path");
  assert.ok(isCrashDialog(win("Fatal error - [m.w3x]")), "control: the title outside the path still counts");
  assert.ok(!isCrashDialog(null), "control: nothing");
});

test("crashDialogs picks the crash window out of a recorded list; classify keeps the rest", () => {
  const main = win("Warcraft III World Editor - [m.w3x]", { id: 2, rect: [4, 30, 1352, 937] });
  const crash = win("Blizzard Error", { id: 3 });
  assert.deepEqual(crashDialogs([main, win("Warning", { id: 4 })]), []);
  assert.deepEqual(crashDialogs([main, crash, win("Warning", { id: 4 })]).map((w) => w.id), [3]);
  assert.deepEqual(crashDialogs([win("x", { id: 5 })], () => "crashpad_handler").map((w) => w.id), [5]);
});

// The window list and command lines recorded on 2026-11-13 (View > Light Ranges on, main window closed; paths shortened).
const REAL_EDITOR_CMDLINE = ["Z:\\home\\u\\we-crash-dialog\\install\\_retail_\\x86_64\\World Editor.exe", "-launch", "-loadfile",
  "Z:\\tmp\\crash-report\\maps\\light_map.w3m"].join("\0") + "\0";
const REAL_CRASH_CMDLINE = ["Z:\\home\\u\\we-crash-dialog\\install\\_retail_\\x86_64\\BlizzardError.exe", "-product", "Warcraft III World Editor",
  "-reopen", "Z:\\home\\u\\install\\Warcraft III Launcher.exe", "-attachment",
  "C:/users/steamuser/Documents/Warcraft III/Errors/2026-11-13 06.24.35 fdb01594/War3.dmp"].join("\0") + "\0";
const REAL_CRASH = { id: 37748737, title: "Warcraft III World Editor", class: "steam_app_4104009084", rect: [538, 306, 523, 414], pid: 3749590, overrideRedirect: false };
const REAL_XALIA = { id: 27262981, title: "", class: "steam_app_4104009084", rect: [545, 427, 509, 158], pid: 3743617, overrideRedirect: true };
const REAL_MAIN = { id: 33554433, title: "Warcraft III World Editor - [Z:/tmp/crash-report/maps/light_map.w3m]", class: "steam_app_4104009084", rect: [4, 30, 1352, 937], pid: 3743646, overrideRedirect: false };
const REAL_PALETTE = { id: 33554434, title: "Tool Palette", class: "steam_app_4104009084", rect: [1356, 30, 240, 600], pid: 3743646, overrideRedirect: false };

test("programName is argv[0]'s file name, whatever the arguments or folders say", () => {
  assert.equal(programName(REAL_CRASH_CMDLINE), "BlizzardError.exe");
  assert.equal(programName(REAL_EDITOR_CMDLINE), "World Editor.exe");
  assert.equal(programName("/usr/bin/crashpad_handler\0--x\0"), "crashpad_handler");
  assert.equal(programName(""), "");
});

test("the real crash dialog is found by its program, and the real editor's windows are not", () => {
  const cmdlines = { 3749590: REAL_CRASH_CMDLINE, 3743646: REAL_EDITOR_CMDLINE, 3743617: "xalia.exe\0" };
  const programOf = (w) => programName(cmdlines[w.pid] ?? "");
  assert.deepEqual(crashDialogs([REAL_MAIN, REAL_PALETTE, REAL_XALIA], programOf), [], "a running editor, 'crash' in its folders and map path");
  assert.deepEqual(crashDialogs([REAL_CRASH, REAL_XALIA], programOf).map((w) => w.id), [REAL_CRASH.id]);
  assert.deepEqual(crashDialogs([REAL_CRASH, REAL_XALIA]), [], "control: its title and class alone are the editor's");
  // With the whole command line instead of the program name, the editor's own folders would trip it.
  assert.ok(isCrashDialog(REAL_MAIN, REAL_EDITOR_CMDLINE), "control: the arguments do mention crash-report");
});

test("closeAction never types into a dialog it can't vouch for", () => {
  const main = win("Warcraft III World Editor - [m.w3x]", { pid: 10 });
  assert.equal(closeAction(win("Warning"), main), "no");
  assert.equal(closeAction(win("Warning"), null), "no");
  assert.equal(closeAction(win(""), main), "no");
  assert.equal(closeAction(win("Warcraft III World Editor"), main), "no");
  assert.equal(closeAction(win("Warning", { pid: 10 }), main), "no", "the editor's own question");
  assert.equal(closeAction(win(""), null), "crash", "an untitled dialog after the main window went is not the question");
  assert.equal(closeAction(win("Warcraft III World Editor"), null), "crash");
  assert.equal(closeAction(REAL_CRASH, null), "crash", "the real dialog, after the main window went");
  assert.equal(closeAction(REAL_CRASH, REAL_MAIN), "crash", "the real dialog's title is the editor's, but its process isn't");
  assert.equal(closeAction(win("Warning", { pid: 11 }), main), "crash", "another process's window is never answered");
  assert.equal(closeAction(win("Something else"), main), "report", "control: unknown dialogs are reported, not answered");
});

test("EditorCrashed carries the message we-drive prints", () => {
  const e = new EditorCrashed([{ title: "Blizzard Error" }]);
  assert.equal(e.message, CRASH_MESSAGE);
  assert.match(CRASH_MESSAGE, /crashed on close; report dismissed without sending|crashed; report dismissed without sending/);
  assert.equal(e.crashed, true);
});

test("--open: parsed as a step, refused before any --map or --start; --map and --open mix", () => {
  const r = parseArgs(["--map", "a.w3x", "--wait-ready", "--save", "a2.w3x", "--open", "b.w3x", "--wait-ready", "--map", "c.w3x", "--close"]);
  assert.deepEqual(r.steps.map(([s]) => s), ["--map", "--wait-ready", "--save", "--open", "--wait-ready", "--map", "--close"]);
  assert.deepEqual(r.steps[3], ["--open", "b.w3x"]);
  assert.throws(() => parseArgs(["--open", "b.w3x"]), /--open needs --map or --start before it/);
  assert.throws(() => parseArgs(["--open", "b.w3x", "--map", "a.w3x"]), /--open needs --map or --start before it/, "control: order matters");
  assert.throws(() => parseArgs(["--map", "a.w3x", "--open"]), /--open needs a value/);
  assert.doesNotThrow(() => parseArgs(["--start", "--open", "b.w3x"]));
});

test("--map: starts the editor when none runs, opens in it when one does", () => {
  assert.equal(mapAction(false), "start");
  assert.equal(mapAction(true), "open");
});

test("openQuestion: 'Save changes?' (Warning) is answered No, or Yes on request; other dialogs are errors; the loading window is ignored", () => {
  const w = (title, id = 1) => ({ title, id, rect: [0, 0, 1, 1] });
  assert.deepEqual(openQuestion([], false), {});
  assert.deepEqual(openQuestion([w("Progress")], false), {}, "the loading window isn't a question");
  assert.deepEqual(openQuestion([w("")], false), {}, "an untitled window isn't either");
  assert.equal(openQuestion([w("Warning", 7)], false).answer.key, "n");
  assert.equal(openQuestion([w("Warning", 7)], false).answer.dialog.id, 7);
  assert.equal(openQuestion([w("Warning", 7)], true).answer.key, "y");
  assert.equal(openQuestion([w("Error")], false).error.title, "Error", "control: an unknown dialog is reported, not answered");
  assert.equal(openQuestion([w("Error"), w("Warning")], false).answer.key, "n", "the question wins when both are open");
});

test("openCopyName: one name per open (the editor's title names the map), the map's own name kept", () => {
  assert.equal(openCopyName(1, "/x/y/R.w3x"), "we-open-1-R.w3x");
  assert.notEqual(openCopyName(1, "/a/input.w3x"), openCopyName(2, "/b/input.w3x"), "control: the same file name twice still differs");
});

test("editorPrefs pins the persisted toggles to the editor's defaults, unless kept", () => {
  const p = editorPrefs("hd", "fixed");
  assert.equal(p["Enforce Water Limits"], "true");
  assert.equal(p["Enforce Camera Boundaries"], "1");
  const left = "[Misc]\nEnforce Water Limits=false\nEnforce Camera Boundaries=0\nhd=1\n";
  const out = setPrefs(left, "Misc", p);
  assert.match(out, /Enforce Water Limits=true/);
  assert.match(out, /Enforce Camera Boundaries=1/);
  const kept = editorPrefs("hd", "fixed", true);
  for (const k of Object.keys(PINNED_PREFS)) assert.equal(k in kept, false, `${k} stays as it was with keep`);
  assert.equal(parseArgs(["--keep-prefs"]).opts.keepPrefs, true);
  assert.equal(parseArgs([]).opts.keepPrefs, undefined);
});
