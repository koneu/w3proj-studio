// The parts of we-drive.mjs and we-setup.mjs that don't need the game: the editor's preferences, sorting its windows,
// the farm's copy rule, the snapshot comparison and the lock. Running the editor itself is local only (TESTING.md).

import test from "node:test";
/** we-drive drives the editor through Proton and X11: these checks use its Linux-only paths (Z: drive names, process.getuid). */
const LINUX_ONLY = process.platform !== "linux" && "we-drive runs on Linux only";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { encodePng } from "./pic-compare.mjs";
import { tmpdir } from "node:os";
import { scratchDir } from "../../tests/scratch.mjs";
import { repoPath } from "../src/lib/testhelpers/testutil";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as drive from "./we-drive.mjs";
import { weOutcome } from "./we-compare-core.mjs";
import { addCamerasToMap, classify, closeAction, crashDialogs, CRASH_MESSAGE, DEFAULT_FRAME_CAP, EditorCrashed, fileIsWholeMpq, gpuIcds, isCrashDialog, isWholeMpq, lavapipeIcds, renderEnv, vulkanDriver, pruneArtefacts, wineserverPath, xvfbCommand, editorPrefs, PINNED_MINIMAP_PREFS, PINNED_PREFS, procGone, procState, programName, isReopenedModule, mapAction, NULL_ALSA_CONF, wineOverrides, openCopyName, openQuestion, parseArgs, questionDialogs, Session, setPrefs, textLocale, VIEW_ITEMS, viewChecks, waitExit, winePath, withEditorPrefs } from "./we-drive.mjs";
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
  for (const t of ["Trigger Editor", "Object Editor", "Campaign Editor", "Campaign Editor - [Untitled]", "Campaign Editor - [Z:/c/a.w3n]", "AI Editor", "AI Editor - [Untitled]", "AI Editor - [zork.wai]"]) {
    assert.equal(isReopenedModule(t), true, t);
  }
  // (control: before the fix the AI Editor's titled window, as the editor restores it, wasn't taken for a module and stalled --wait-ready)
  for (const t of ["", "Warning", "Progress", "Warcraft III World Editor", "Trigger Editor - x", "Campaign Editors", "AI Editors", undefined]) {
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

test("parseArgs: --export-options belongs to the next --export-minimap, which clicks only the boxes off their defaults", () => {
  const { steps } = parseArgs(["--map", "m.w3x", "--export-options", "terrain,water,blight,doodads,playable", "--export-minimap", "a.tga", "--export-minimap", "b.tga"]);
  assert.deepEqual(steps.map(([s]) => s), ["--map", "--export-minimap", "--export-minimap"]);
  assert.equal(steps[1][1].file, "a.tga");
  assert.deepEqual(drive.exportBoxClicks(steps[1][1].options), [[16, 144]], "only Include Blight is clicked");
  assert.equal(steps[2][1].options, undefined, "the second export has the dialog's defaults");
  assert.deepEqual(drive.exportBoxClicks(drive.parseExportOptions("units")).map(([, y]) => y), [108, 126, 180, 198, 270]);
  assert.throws(() => parseArgs(["--map", "m.w3x", "--export-options", "blight"]), /needs an --export-minimap/);
  assert.throws(() => parseArgs(["--map", "m.w3x", "--export-options", "fog", "--export-minimap", "a.tga"]), /unknown box fog/);
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

// Tests run bundled elsewhere (not next to this file): found from the working directory up.
const X11_HELPER = repoPath("app", "scripts", "we-x11.py");

/** Skips the test only for a python3 that isn't there or lacks Pillow (the exact import error); any other failure of
 *  the probe fails the test, with what the helper printed. Returns true when the test should end (skipped). */
function skipWithoutPython(t, probe) {
  if (probe.status === 0 && !probe.error) return false;
  if (probe.error?.code === "ENOENT") { t.skip("python3 isn't here"); return true; }
  if (!probe.error && /No module named 'PIL'/.test(probe.stderr ?? "")) { t.skip("python3 has no Pillow"); return true; }
  assert.fail(`the we-x11.py probe failed (status ${probe.status}${probe.error ? `, ${probe.error.message}` : ""}): ${probe.stderr}`);
}

test("we-x11 drag path: even steps from the press to exactly the release point (python, no display)", (t) => {
  const run = (...a) => spawnSync("python3", ["-I", X11_HELPER, "drag", ...a, "--dry"], { encoding: "utf8", timeout: 60_000 });
  if (skipWithoutPython(t, run("0,0", "1,1"))) return;
  const path = JSON.parse(run("100,100", "300,60", "--steps", "4").stdout).path;
  assert.deepEqual(path, [[150, 90], [200, 80], [250, 70], [300, 60]]);
  assert.deepEqual(JSON.parse(run("5,5", "5,5", "--steps", "0").stdout).path, [[5, 5]]);
});

test("parseArgs: --clipboard takes the file the clipboard's text goes into", () => {
  assert.deepEqual(parseArgs(["--start", "--clipboard", "clip.txt"]).steps, [["--start", null], ["--clipboard", "clip.txt"]]);
  assert.throws(() => parseArgs(["--start", "--clipboard"]), /--clipboard needs a value/);
});

test("parseArgs: --keyboard names an X layout (de, us, de(nodeadkeys)) and nothing else", () => {
  assert.equal(parseArgs(["--start"]).opts.keyboard, undefined);
  assert.equal(parseArgs(["--keyboard", "de", "--start"]).opts.keyboard, "de");
  assert.equal(parseArgs(["--keyboard", "de(nodeadkeys)", "--start"]).opts.keyboard, "de(nodeadkeys)");
  assert.throws(() => parseArgs(["--keyboard", "de; touch x", "--start"]), /X layout name/);
  assert.throws(() => parseArgs(["--keyboard", "-print", "--start"]), /X layout name/);
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

test("parseArgs: --looks-every-map is an option (every map gets the looks' cameras), not a step", () => {
  const { opts, steps } = parseArgs(["--looks-every-map", "--map", "a.w3x", "--look", "1,2", "--map", "b.w3x", "--look", "1,2"]);
  assert.equal(opts.looksEveryMap, true);
  assert.deepEqual(steps.map(([s]) => s), ["--map", "--look", "--map", "--look"]);
  assert.equal(parseArgs(["--map", "a.w3x"]).opts.looksEveryMap, undefined, "the first map only, by default");
});

test("parseArgs: --save takes the file to copy the saved map to, and needs a map before it", () => {
  assert.deepEqual(parseArgs(["--map", "m.w3x", "--wait-ready", "--save", "out.w3x", "--close"]).steps,
    [["--map", "m.w3x"], ["--wait-ready", null], ["--save", "out.w3x"], ["--close", null]]);
  assert.throws(() => parseArgs(["--start", "--save", "out.w3x"]), /--save needs --map/);
  assert.throws(() => parseArgs(["--save", "out.w3x", "--map", "m.w3x"]), /--save needs --map/);
  assert.throws(() => parseArgs(["--map", "m.w3x", "--save"]), /needs a value/);
});

test("addCamerasToMap: the looks' cameras go first in war3map.w3c.json, a missing file is made, an unreadable one refused", () => {
  const dir = scratchDir("we-look-");
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
  const dir = scratchDir("we-lock-");
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
  // The literal text TESTING.md quotes (and readers grep for), not the constant compared with itself.
  assert.equal(e.message, "the World Editor crashed; report dismissed without sending");
  assert.equal(CRASH_MESSAGE, e.message);
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

test("--map: a module window the map before left open (the Trigger Editor) restarts the editor instead of opening in it", () => {
  const d = (title) => ({ title, id: 1, rect: [0, 0, 1, 1] });
  assert.equal(mapAction(true, [d("Trigger Editor")]), "restart");
  assert.equal(mapAction(true, [d("Progress"), d("Object Editor")]), "restart");
  assert.equal(mapAction(true, [d("AI Editor - [Untitled]")]), "restart");
  // Controls: other dialogs don't, and with no editor running it is a plain start.
  assert.equal(mapAction(true, [d("Progress"), d("Warning")]), "open");
  assert.equal(mapAction(true, []), "open");
  assert.equal(mapAction(false, [d("Trigger Editor")]), "start");
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
  const left = "[Misc]\nEnforce Water Limits=false\nEnforce Camera Boundaries=0\nReset Fixed Z When Moving Objects=true\nhd=1\n";
  const out = setPrefs(left, "Misc", p);
  assert.match(out, /Enforce Water Limits=true/);
  assert.match(out, /Enforce Camera Boundaries=1/);
  // Ctrl+Shift+H's switch (unit-heights), left on by a run before: back to off.
  assert.match(out, /^Reset Fixed Z When Moving Objects=false$/m);
  const kept = editorPrefs("hd", "fixed", true);
  for (const k of Object.keys(PINNED_PREFS)) assert.equal(k in kept, false, `${k} stays as it was with keep`);
  assert.equal(parseArgs(["--keep-prefs"]).opts.keepPrefs, true);
  assert.equal(parseArgs([]).opts.keepPrefs, undefined);
});

test("--null-audio keeps Wine's ALSA driver and gives it a null device only", () => {
  assert.equal(parseArgs(["--null-audio"]).opts.nullAudio, true);
  assert.equal(parseArgs([]).opts.nullAudio, undefined);
  assert.equal(wineOverrides(true, "x=n"), "winepulse.drv=d;wineoss.drv=d;x=n");
  assert.equal(wineOverrides(false), "winepulse.drv=d;winealsa.drv=d;wineoss.drv=d", "control: without it ALSA is off too");
  assert.match(NULL_ALSA_CONF, /pcm\.!default \{\n {2}type null\n\}/);
});

/** Runs `fn` with the given environment variables set (undefined: removed), restoring them afterwards. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("--frame-cap: 10 frames a second by default, W3PROJ_WE_FRAME_CAP or the option instead, 0 for none; a bad value is refused", () => {
  withEnv({ W3PROJ_WE_FRAME_CAP: undefined }, () => {
    assert.equal(DEFAULT_FRAME_CAP, 10);
    assert.equal(parseArgs([]).opts.frameCap, 10);
    assert.equal(parseArgs(["--frame-cap", "0"]).opts.frameCap, 0, "the old, uncapped behaviour");
    assert.equal(parseArgs(["--frame-cap", "30"]).opts.frameCap, 30);
    for (const bad of ["-1", "2.5", "ten", "", "99999"]) assert.throws(() => parseArgs(["--frame-cap", bad]), /--frame-cap wants a whole number/, bad);
    assert.throws(() => parseArgs(["--frame-cap"]), /needs a value/);
  });
  withEnv({ W3PROJ_WE_FRAME_CAP: "0" }, () => {
    assert.equal(parseArgs([]).opts.frameCap, 0, "the environment's (we-compare's children inherit it)");
    assert.equal(parseArgs(["--frame-cap", "5"]).opts.frameCap, 5, "the option wins over the environment");
  });
  withEnv({ W3PROJ_WE_FRAME_CAP: "x" }, () => assert.throws(() => parseArgs([]), /W3PROJ_WE_FRAME_CAP wants a whole number/));
  withEnv({ W3PROJ_WE_FRAME_CAP: "" }, () => assert.equal(parseArgs([]).opts.frameCap, 10, "empty is unset"));
});

test("--renderer: software (lavapipe) by default, gpu by the option or W3PROJ_WE_RENDERER; anything else is refused", () => {
  withEnv({ W3PROJ_WE_RENDERER: undefined }, () => {
    assert.equal(parseArgs([]).opts.renderer, "software");
    assert.equal(parseArgs(["--renderer", "gpu"]).opts.renderer, "gpu");
    assert.throws(() => parseArgs(["--renderer", "nvidia"]), /--renderer \(or W3PROJ_WE_RENDERER\) wants software or gpu/);
  });
  withEnv({ W3PROJ_WE_RENDERER: "gpu" }, () => {
    assert.equal(parseArgs([]).opts.renderer, "gpu");
    assert.equal(parseArgs(["--renderer", "software"]).opts.renderer, "software", "the option wins");
  });
  withEnv({ W3PROJ_WE_RENDERER: "llvmpipe" }, () => assert.throws(() => parseArgs([]), /wants software or gpu, not "llvmpipe"/));
});

test("renderEnv: the renderer's Vulkan manifests and DXVK's frame limit, 0 written out so the caller's own cap doesn't leak in", () => {
  const icds = { software: () => ["/a/lvp_icd.json"], gpu: () => ["/a/nvidia_icd.json", "/b/intel_icd.json"] };
  assert.deepEqual(renderEnv({ renderer: "software", frameCap: 10 }, icds), { VK_ICD_FILENAMES: "/a/lvp_icd.json", VK_DRIVER_FILES: "/a/lvp_icd.json", DXVK_FRAME_RATE: "10" });
  assert.deepEqual(renderEnv({ renderer: "gpu", frameCap: 0 }, icds), { VK_ICD_FILENAMES: "/a/nvidia_icd.json:/b/intel_icd.json", VK_DRIVER_FILES: "/a/nvidia_icd.json:/b/intel_icd.json", DXVK_FRAME_RATE: "0" });
  assert.equal(renderEnv({}, icds).DXVK_FRAME_RATE, String(DEFAULT_FRAME_CAP), "defaults: software, the default cap");
  assert.equal(renderEnv({}, icds).VK_ICD_FILENAMES, "/a/lvp_icd.json");
  assert.throws(() => renderEnv({ renderer: "hw" }, icds), /--renderer wants software or gpu/);
});

test("gpuIcds: every manifest but lavapipe's; vulkanDriver names the driver a process loaded", () => {
  const listing = { "/a": ["nvidia_icd.json", "lvp_icd.x86_64.json", "README"], "/b": ["lvp_icd.json", "radeon_icd.x86_64.json"] };
  const list = (d) => { if (!listing[d]) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return listing[d]; };
  assert.deepEqual(gpuIcds(["/a", "/none", "/b"], list), ["/a/nvidia_icd.json", "/b/radeon_icd.x86_64.json"]);
  assert.deepEqual(gpuIcds(["/none"], list), [], "control: none");
  const line = (p) => `7f00-7f10 r-xp 00000000 08:02 123 ${p}\n`;
  assert.equal(vulkanDriver(line("/usr/lib/x86_64-linux-gnu/libvulkan_lvp.so") + line("/usr/lib/libLLVM.so.20.1")), "lavapipe");
  assert.equal(vulkanDriver(line("/usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.595.99.02")), "nvidia");
  assert.equal(vulkanDriver(line("/usr/lib/x86_64-linux-gnu/libvulkan_radeon.so")), "other");
  assert.equal(vulkanDriver(line("/usr/lib/x86_64-linux-gnu/libvulkan.so.1")), null, "the loader alone is no driver");
  assert.equal(vulkanDriver(undefined), null);
});

test("Session: the editor's environment has the run's renderer and frame cap; --wait-ready names them", { skip: LINUX_ONLY }, (t) => {
  const r = rig(t);
  r.s.display = ":77";
  assert.equal(r.s.sandboxed("x.exe", []).env.DXVK_FRAME_RATE, String(DEFAULT_FRAME_CAP), "the default cap");
  r.s.opts.frameCap = 0;
  const { env } = r.s.sandboxed("x.exe", []);
  assert.equal(env.DXVK_FRAME_RATE, "0", "uncapped is written, not left to the caller's environment");
  assert.equal(env.VK_ICD_FILENAMES, lavapipeIcds().join(":"));
  assert.deepEqual(r.s.renderInfo({ pid: 0 }), { renderer: "software", frameCap: 0, driver: null });
  assert.equal(r.s.renderInfo({ pid: process.pid }).driver, null, "node has no Vulkan driver loaded");
});

test("withEditorPrefs unticks the minimap's Show Creep Camp Icon before each start (the editor keeps it), unless kept", () => {
  const left = "[Minimap]\r\nShow Creep Camps=true\r\nShow Icons=0\r\n\r\n[Misc]\r\nhd=1\r\n";
  const out = withEditorPrefs(left, "sd", "fixed");
  assert.match(out, /\[Minimap\]\r\nShow Creep Camps=false\r\nShow Icons=0\r\n/);
  assert.equal(PINNED_MINIMAP_PREFS["Show Creep Camps"], "false");
  assert.match(withEditorPrefs(left, "sd", "fixed", true), /Show Creep Camps=true/, "control: --keep-prefs leaves it");
  assert.match(withEditorPrefs("", "sd", "fixed"), /\[Minimap\]\nShow Creep Camps=false/, "a fresh file gets it too");
});

test("parseArgs: --timeout, --sleep and --fps must be numbers (NaN waited forever or not at all)", () => {
  assert.equal(parseArgs(["--timeout", "12.5", "--start"]).opts.timeout, 12.5);
  for (const bad of ["abc", "0", "-5", "", "Infinity", "1e999"]) {
    assert.throws(() => parseArgs(["--timeout", bad, "--start"]), /--timeout wants a number above 0/, bad);
  }
  assert.doesNotThrow(() => parseArgs(["--start", "--sleep", "0", "--sleep", "250"]));
  for (const bad of ["abc", "-1", ""]) assert.throws(() => parseArgs(["--start", "--sleep", bad]), /--sleep wants a number of at least 0/, bad);
  assert.doesNotThrow(() => parseArgs(["--start", "--fps", "2000"]));
  for (const bad of ["x", "0", "-3"]) assert.throws(() => parseArgs(["--start", "--fps", bad]), /--fps wants a number above 0/, bad);
});

test("textLocale: enUS when the install has it, else refused with what it has", () => {
  assert.equal(textLocale("Branch!STRING:0|Tags!STRING:0\nus|Windows x86_64 US? enUS speech?:Windows x86_64 US? enUS text?:\n"), "enUS");
  assert.equal(textLocale("eu|deDE text?:enUS text?\n"), "enUS", "enUS among others");
  assert.throws(() => textLocale("eu|deDE speech?:deDE text?\n"), /needs the game's English text.*deDE/);
  assert.throws(() => textLocale("nothing here"), /no text locale named/);
});

test("procState reads the state after the last ')' of /proc/PID/stat; a zombie or a missing process is gone", () => {
  const stat = (text) => () => text;
  const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(procState(1, stat("123 (we (x) y) Z 1 2 3")), "Z");
  assert.equal(procState(1, stat("123 (Xvfb) S 1 2 3")), "S");
  assert.equal(procState(1, fail("ENOENT")), null);
  assert.equal(procState(1, fail("EACCES")), "?", "unreadable isn't gone");
  assert.equal(procGone(1, stat("1 (a) Z 0")), true);
  assert.equal(procGone(1, fail("ENOENT")), true);
  assert.equal(procGone(1, stat("1 (a) S 0")), false);
  assert.equal(procGone(1, fail("EACCES")), false);
  // The control reads the real /proc: only where there is one (we-drive itself runs on Linux; Windows has no /proc).
  if (existsSync("/proc/self/stat")) assert.equal(procState(process.pid) !== null && !procGone(process.pid), true, "control: this process is there");
});

test("we-x11 settle: two equal pictures in a row, else up to the timeout (python, no display)", (t) => {
  const run = (...a) => spawnSync("python3", ["-I", X11_HELPER, "settle", "--dry", ...a], { encoding: "utf8", timeout: 60_000 });
  if (skipWithoutPython(t, run("--hashes", "a"))) return;
  assert.deepEqual(JSON.parse(run("--hashes", "a,b,b,c", "--interval", "200").stdout), { settled: true, ms: 400, grabs: 3 });
  assert.deepEqual(JSON.parse(run("--hashes", "a,b,c,d,e,f", "--interval", "400", "--timeout", "1000").stdout), { settled: false, ms: 1200, grabs: 4 });
});

// ---- the Session against a fake editor, a fake X server and a fake clock ------------------------------------

/** pids above Linux's largest pid_max (2^22): process.kill on them (the session's group kill) can't hit anything. */
let fakePid = 2 ** 22 + 1000;
class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = fakePid++; }
}

function fakeClock() {
  const c = { t: 1_000_000, now: () => c.t, sleep: async (ms) => { c.t += ms; await new Promise((r) => setImmediate(r)); } };
  return c;
}

const mainWin = (map) => ({ id: 1, title: `Warcraft III World Editor - [Z:/w/maps/${map}]`, class: "steam_app_1", rect: [4, 30, 1352, 937], pid: 5, overrideRedirect: false });
const dialogWin = (id, title, rect = [500, 400, 300, 120]) => ({ id, title, class: "steam_app_1", rect, pid: 5, overrideRedirect: false });

/**
 * A Session in a temporary farm folder (W3PROJ_WE_DIR) with the locale already in its registry: `x.windows` (a list
 * or a function) is what the fake X server shows, every helper call is in `calls`, the wineserver's in `ws`, the
 * editor processes in `children`; `onWineserver(args)` runs inside a wineserver call (as a real exit would happen).
 */
function rig(t, { timeout = 300 } = {}) {
  const dir = scratchDir("we-session-");
  const saved = process.env.W3PROJ_WE_DIR;
  process.env.W3PROJ_WE_DIR = join(dir, "we");
  t.after(() => {
    if (saved === undefined) delete process.env.W3PROJ_WE_DIR; else process.env.W3PROJ_WE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const game = join(dir, "game");
  mkdirSync(game);
  writeFileSync(join(game, ".build.info"), "Tags!STRING:0\nus|enUS text?\n");
  const pfx = join(dir, "we", "prefix", "pfx");
  mkdirSync(pfx, { recursive: true });
  writeFileSync(join(pfx, "user.reg"), String.raw`[Software\\Blizzard Entertainment\\Battle.net\\Launch Options\\W3] 1` + `\n"LOCALE"="enUS"\n`);
  const maps = {};
  for (const n of ["a.w3m", "b.w3m"]) { maps[n] = join(dir, n); writeFileSync(maps[n], `map ${n}`); }
  const r = { dir, pfx, game, maps, calls: [], ws: [], events: [], children: [], windows: [], stats: { pixels: 100, blackPixels: 0 }, onWineserver: null, onSpawn: null };
  r.clock = fakeClock();
  r.x11 = (cmd, ...rest) => {
    r.calls.push([cmd, ...rest]);
    if (cmd === "windows") return { windows: typeof r.windows === "function" ? r.windows() : r.windows };
    if (cmd === "stats") return r.stats;
    if (cmd === "close" && rest[0] === 1) r.windows = [];
    return { pressed: true };
  };
  r.s = new Session({ work: join(dir, "work"), timeout, mode: "sd", dayNight: "fixed", saveAccept: [] }, game, {
    proton: { tool: "/nonexistent", steamRoot: "/nonexistent", appId: "1" },
    clock: r.clock,
    x11: (...a) => r.x11(...a),
    spawnWine: (program, args) => { const c = new FakeChild(); r.children.push(c); r.events.push(`spawn ${basename(program)}`); r.onSpawn?.(c, program, args); return c; },
    wineserver: (args) => { r.ws.push(args.join(" ")); r.events.push(`wineserver ${args.join(" ")}`); r.onWineserver?.(args); return { status: 0 }; },
    procGone: () => false,
  });
  return r;
}

test("Session: an editor's exit that comes after its close doesn't end the next map (every second map failed)", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  r.windows = [mainWin("a.w3m")];
  assert.equal((await r.s.waitReady()).ready, true);
  // As for real: the windows go at the close, the processes during `wineserver -w`, and node hears of the exit only
  // when its event loop next turns.
  const first = r.children[0];
  r.onWineserver = (args) => { if (args[0] === "-w") setImmediate(() => first.emit("exit", 0)); };
  assert.deepEqual((await r.s.close()).closed, true);
  assert.equal(first.exited, true, "the close waited for the editor's own exit");
  await r.s.start(r.maps["b.w3m"]);
  r.windows = [mainWin("b.w3m")];
  const ready = await r.s.waitReady();
  assert.equal(ready.ready, true, JSON.stringify(ready));
  assert.match(ready.title, /b\.w3m/);
  assert.equal(r.s.running(), true);
});

test("Session: an old editor's late exit event doesn't mark the new one as exited", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const first = r.children[0];
  // The old editor is known gone (its flag), but its exit event is still queued when the next start runs.
  first.exited = true;
  r.s.editorExited = true;
  await r.s.start(r.maps["b.w3m"]);
  first.emit("exit", 0);
  assert.equal(r.s.running(), true, "the new editor still counts as running");
  r.children[1].emit("exit", 0);
  assert.equal(r.s.running(), false, "control: its own exit counts");
});

test("Session: start waits for the editor before it to exit, and refuses one that doesn't", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const first = r.children[0];
  // Not a real timer: the fake clock's sleeps (400 of them, one setImmediate each) can all pass within 5 ms of real time.
  setImmediate(() => first.emit("exit", 0));
  r.s.editorExited = true;
  await r.s.start(r.maps["b.w3m"]);
  assert.equal(first.exited, true);
  assert.equal(r.children.length, 2, "the second editor started after the first had exited");
  // One that never exits: refused, not started over it.
  await assert.rejects(r.s.start(r.maps["a.w3m"]), /still running/);
  assert.equal(r.children.length, 2);
});

test("Session: killEditor kills the prefix and waits for its wineserver to go", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  r.ws.length = 0;
  r.s.killEditor();
  assert.deepEqual(r.ws, ["-k", "-w"]);
  assert.equal(r.s.running(), false);
});

test("Session: stop() kills the prefix's wineserver even when no editor was started", (t) => {
  const r = rig(t);
  r.s.stop();
  assert.deepEqual(r.ws, ["-k"], "the locale's reg leaves a wineserver before any editor");
});

test("Session: stop() takes a zombie Xvfb as gone instead of waiting 5 s", (t) => {
  const r = rig(t);
  const asked = [];
  r.s.procGone = (pid) => { asked.push(pid); return true; };
  r.s.xvfb = { pid: fakePid++, exitCode: null, signalCode: null, kill() {} };
  r.s.stop();
  // Asked once, and stop() went on (it returned): a Xvfb taken for running would have waited out its 5 s first.
  assert.deepEqual(asked, [r.s.xvfb.pid]);
});

test("Session: --expect-layout fails waitReady on a main window or palette of another place or size, with one message", async (t) => {
  const r = rig(t);
  r.s.opts.expectLayout = true;
  await r.s.start(r.maps["a.w3m"]);
  const palette = (rect) => ({ id: 7, title: "Terrain Palette", class: "steam_app_1", rect, pid: 5, overrideRedirect: false });
  r.windows = [{ ...mainWin("a.w3m"), rect: [0, 0, 1200, 700] }, palette([1356, 30, 240, 600])];
  const wrong = await r.s.waitReady();
  assert.equal(wrong.ready, false);
  assert.match(wrong.layout, /main window is at 0,0 1200x700, not 4,30 1352x937/);
  r.windows = [mainWin("a.w3m"), palette([1300, 30, 240, 600])];
  assert.match((await r.s.waitReady()).layout, /tool palette is at 1300,30, not 1356,30/);
  // Controls: the measured layout is ready; without the option another size is ready too (a --screen run).
  r.windows = [mainWin("a.w3m"), palette([1356, 30, 240, 600])];
  assert.equal((await r.s.waitReady()).ready, true);
  r.s.opts.expectLayout = false;
  r.windows = [{ ...mainWin("a.w3m"), rect: [0, 0, 1200, 700] }];
  assert.equal((await r.s.waitReady()).ready, true);
});

test("--expect-layout: the real waitReady line of a wrong layout fails every spec in we-compare's outcome, a right one doesn't", async (t) => {
  const r = rig(t);
  r.s.opts.expectLayout = true;
  await r.s.start(r.maps["a.w3m"]);
  // The line main() prints for --wait-ready ({ step, ...result }), read back the way we-compare reads it.
  const line = async () => JSON.parse(JSON.stringify({ step: "--wait-ready", ...(await r.s.waitReady()) }));
  r.windows = [{ ...mainWin("a.w3m"), rect: [0, 0, 1200, 700] }];
  const bad = await line();
  assert.equal(bad.ready, false);
  const out = weOutcome(2, [{ step: "--map" }, bad]);
  assert.equal(out.errors.length, 2);
  for (const e of out.errors) assert.match(e, /^World Editor: the editor's main window is at 0,0 1200x700/);
  assert.deepEqual(out.rerun, []);
  // Control: the measured layout gives no error from the ready line.
  r.windows = [mainWin("a.w3m")];
  const good = await line();
  assert.equal(good.ready, true);
  assert.deepEqual(weOutcome(1, [{ step: "--map" }, good]).errors, ["World Editor: no save (the run stopped before it)"]);
});

test("Session: --pref keys are written into the preferences before each start, after we-drive's own", async (t) => {
  const r = rig(t);
  r.s.opts.prefs = [drive.parsePref("Misc/Enforce Water Limits=false"), drive.parsePref("Terrain Cursor/Color=3")];
  await r.s.start(r.maps["a.w3m"]);
  const file = join(r.pfx, "drive_c", "users", "steamuser", "Documents", "Warcraft III", "WorldEditPreferences.txt");
  const text = readFileSync(file, "utf8");
  assert.match(text, /^Enforce Water Limits=false$/m, "the --pref wins over the pinned default");
  assert.doesNotMatch(text, /^Enforce Water Limits=true$/m);
  assert.match(text, /\[Terrain Cursor\]\nColor=3/);
  assert.match(text, /^Has Been Run=true$/m, "control: we-drive's own keys are still there");
});

test("we-drive options: --pref, --expect-layout and the --numlock step are checked before anything starts", () => {
  const { opts, steps } = parseArgs(["--pref", "Misc/Enforce Water Limits=false", "--pref", "Misc/Undo Limit=0", "--expect-layout", "--start", "--numlock", "on", "--numlock", "status"]);
  assert.deepEqual(opts.prefs, [{ section: "Misc", key: "Enforce Water Limits", value: "false" }, { section: "Misc", key: "Undo Limit", value: "0" }]);
  assert.equal(opts.expectLayout, true);
  assert.deepEqual(steps, [["--start", null], ["--numlock", "on"], ["--numlock", "status"]]);
  assert.throws(() => parseArgs(["--start", "--numlock", "yes"]), /--numlock wants on, off or status/);
  for (const bad of ["Misc", "Misc/=1", "Misc/Key", "/Key=1", "Mi[sc/K=1", "Misc/ Key=1"]) assert.throws(() => drive.parsePref(bad), /--pref wants Section\/Key=value/, bad);
  assert.deepEqual(drive.parsePref("Misc/Key=a=b"), { section: "Misc", key: "Key", value: "a=b" }, "a value may hold =");
  assert.throws(() => parseArgs(["--expect-layout", "--screen", "1200x700", "--start"]), /leave out --screen/);
  assert.equal(parseArgs(["--expect-layout", "--screen", "1600x1000", "--start"]).opts.expectLayout, true, "control: the measured size");
});

test("withExtraPrefs sets each --pref in its section, a later one of the same key winning; layoutProblem reads the recorded layout", () => {
  const text = drive.withExtraPrefs("[Misc]\nhd=1\n", [drive.parsePref("Misc/hd=0"), drive.parsePref("Misc/hd=2"), drive.parsePref("New/k=v")]);
  assert.equal(text, "[Misc]\nhd=2\n\n[New]\nk=v\n");
  assert.equal(drive.withExtraPrefs("[Misc]\nhd=1\n", []), "[Misc]\nhd=1\n");
  // The layout of TESTING.md "Layout" (main window 4,30 1352x937, palette 1356,30) is fine; no palette is fine too.
  const main = { title: "Warcraft III World Editor - [x]", rect: [4, 30, 1352, 937] };
  assert.equal(drive.layoutProblem(main, [{ title: "Terrain Palette", rect: [1356, 30, 240, 600] }]), null);
  assert.equal(drive.layoutProblem(main, []), null);
  assert.match(drive.layoutProblem(null, []), /no main window/);
  assert.match(drive.layoutProblem({ ...main, rect: [4, 30, 1352, 900] }, []), /1352x900/);
  assert.deepEqual(drive.LAYOUT.main, [4, 30, 1352, 937]);
});

test("Session: waitReady wants this map's name in the title, not the map before's", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["b.w3m"]);
  const t0 = r.clock.t;
  r.windows = () => [mainWin(r.clock.t - t0 < 6000 ? "a.w3m" : "b.w3m")];
  const ready = await r.s.waitReady();
  assert.equal(ready.ready, true);
  assert.match(ready.title, /b\.w3m/);
  assert.ok(r.clock.t - t0 >= 9000, "not ready while the title still named a.w3m");
});

test("Session: waitReady isn't ready while a reopened module window covers the view, and closes it again", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const t0 = r.clock.t;
  // The first closes come too early: the editor takes the window's close only 5 s after the start.
  let open = true;
  const closes = [];
  const base = r.x11;
  r.x11 = (cmd, ...rest) => {
    if (cmd === "close" && rest[0] === 50) { closes.push(r.clock.t - t0); if (r.clock.t - t0 >= 5000) open = false; return { pressed: true }; }
    return base(cmd, ...rest);
  };
  r.windows = () => [mainWin("a.w3m"), ...(open ? [dialogWin(50, "Trigger Editor", [300, 100, 900, 600])] : [])];
  const ready = await r.s.waitReady();
  assert.equal(ready.ready, true, JSON.stringify(ready));
  assert.equal(open, false, "the window is closed when ready is reported");
  assert.ok(closes.length >= 2, `closed again: ${closes}`);
  assert.ok(r.clock.t - t0 >= 5000, "not ready while the module window was open");
});

test("Session: a module window that ignores the close is raised over by the main window, and ready waits for the picture", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const t0 = r.clock.t;
  let raised = 0;
  const base = r.x11;
  r.x11 = (cmd, ...rest) => {
    if (cmd === "close" && rest[0] === 50) return { pressed: true }; // ignored, as the editor's restored module does
    if (cmd === "focus") { raised++; r.stats = { pixels: 100, blackPixels: 0, mean: [120, 90, 40] }; return { focused: true }; }
    return base(cmd, ...rest);
  };
  // The module covers the view (a grey 240 picture) until the main window has been raised.
  r.stats = { pixels: 100, blackPixels: 0, mean: [240, 240, 240] };
  r.windows = () => [mainWin("a.w3m"), dialogWin(50, "Object Editor", [300, 100, 900, 600])];
  const ready = await r.s.waitReady();
  assert.equal(ready.ready, true, JSON.stringify(ready));
  assert.ok(raised >= 1, "the main window was raised");
  assert.ok(r.clock.t - t0 >= 9000, "not ready before the close had been tried for a while");
  // the control: with the view still grey after the raise, it isn't ready
  const c = rig(t, { timeout: 30 });
  await c.s.start(c.maps["a.w3m"]);
  const cb = c.x11;
  c.x11 = (cmd, ...rest) => (cmd === "close" ? { pressed: true } : cb(cmd, ...rest));
  c.stats = { pixels: 100, blackPixels: 0, mean: [240, 240, 240] };
  c.windows = () => [mainWin("a.w3m"), dialogWin(50, "Object Editor", [300, 100, 900, 600])];
  assert.equal((await c.s.waitReady()).ready, false);
});

test("Session: waitReady gives up at the timeout and stops when the editor exits", async (t) => {
  const r = rig(t, { timeout: 2 });
  await r.s.start(r.maps["a.w3m"]);
  r.windows = [];
  const t0 = r.clock.t;
  const res = await r.s.waitReady();
  assert.equal(res.ready, false);
  assert.equal(res.timeout, 2);
  assert.ok(r.clock.t - t0 >= 2000 && r.clock.t - t0 < 4000);
  r.children[0].emit("exit", 1);
  await assert.rejects(r.s.waitReady(), /exited while starting/);
});

test("Session: each start answers its own welcome dialog (the clicked list starts empty)", async (t) => {
  const r = rig(t);
  const saved = process.env.W3PROJ_WE_ACCEPT_TERMS;
  delete process.env.W3PROJ_WE_ACCEPT_TERMS;
  t.after(() => { if (saved !== undefined) process.env.W3PROJ_WE_ACCEPT_TERMS = saved; });
  const welcome = dialogWin(77, "Welcome to the Warcraft III World Editor", [300, 100, 900, 600]);
  const clicks = () => r.calls.filter(([c, at]) => c === "click" && at === "773,570").length;
  for (const map of ["a.w3m", "b.w3m"]) {
    await r.s.start(r.maps[map]);
    r.windows = [mainWin(map), welcome];
    assert.equal((await r.s.waitReady()).ready, true);
    r.s.editorExited = true;
    r.children.at(-1).emit("exit", 0);
  }
  assert.equal(clicks(), 2, "a welcome with the same window id in the next editor is clicked again");
});

test("Session: save answers a Reminder once, and copies the file once it stood still", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const t0 = r.clock.t;
  let written = false;
  r.windows = () => {
    if (r.clock.t - t0 < 3000) return [mainWin("a.w3m"), dialogWin(9, "Reminder")];
    if (!written) { writeFileSync(r.s.copy, fakeMap("saved by the editor")); written = true; }
    return [mainWin("a.w3m")];
  };
  const dest = join(r.dir, "out.w3m");
  const res = await r.s.save(dest);
  assert.equal(res.saved, true, JSON.stringify(res));
  assert.deepEqual(res.answered, ["Reminder"]);
  assert.equal(r.calls.filter(([c, ...rest]) => c === "key" && rest.includes(9)).length, 1, "Return once, not on every poll");
  assert.deepEqual(readFileSync(dest), fakeMap("saved by the editor"));
  // The one write seen: its size, and that it was a whole map then.
  assert.deepEqual(res.writes.map((w) => [w.size, w.whole]), [[fakeMap("saved by the editor").length, true]]);
  assert.ok(res.writes[0].ms >= 3000, `the write came after the Reminder (${res.writes[0].ms} ms)`);
});

test("Session: a save that writes nothing with no dialog open fails long before the timeout; a Reminder that stays is reported", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  r.windows = [mainWin("a.w3m")];
  const t0 = r.clock.t;
  const res = await r.s.save(join(r.dir, "out.w3m"));
  assert.equal(res.saved, false);
  assert.match(res.error, /wrote nothing/);
  assert.ok(r.clock.t - t0 < 120000, `${r.clock.t - t0} ms, the timeout is 300 s`);
  r.windows = [mainWin("a.w3m"), dialogWin(9, "Reminder")];
  const stuck = await r.s.save(join(r.dir, "out.w3m"));
  assert.equal(stuck.saved, false);
  assert.deepEqual(stuck.dialogs.map((d) => d.title), ["Reminder"]);
  assert.equal(r.calls.filter(([c, ...rest]) => c === "key" && rest.includes(9)).length, 1);
});

test("Session: a dead Xvfb is said as such, not as a refused display", (t) => {
  const r = rig(t);
  r.s.display = ":9";
  r.s.xvfb = { pid: fakePid++, exitCode: null, signalCode: "SIGSEGV" };
  r.s.xvfbExited = true;
  assert.throws(() => r.s.windows(), /Xvfb died \(display :9, SIGSEGV\)/);
  assert.equal(r.calls.length, 0, "the helper wasn't asked");
  r.s.xvfbExited = false;
  r.s.procGone = () => true;
  assert.throws(() => r.s.windows(), /Xvfb died/, "a zombie before its exit event");
  r.s.procGone = () => false;
  assert.ok(r.s.windows(), "control: a live Xvfb");
});

test("waitExit: true once the child's exit was seen, false after the time", async () => {
  const clock = fakeClock();
  const c = new FakeChild();
  setTimeout(() => { c.exited = true; }, 5);
  assert.equal(await waitExit(c, 60000, { now: clock.now, sleep: async (ms) => { clock.t += ms; await new Promise((r) => setTimeout(r, 2)); } }), true);
  assert.equal(await waitExit(new FakeChild(), 1000, clock), false);
});

// ---- review round 2026-11-17: save, crash checks, sandbox, cleanup ------------------------------------------

/** A map file as the editor writes it: the 512-byte HM3W header, then an MPQ header whose hash table (16 entries)
 *  and block table (1 entry) follow it; `tag` makes two of them differ. `cut` bytes are missing at the end. */
function fakeMap(tag = "", cut = 0) {
  const buf = Buffer.alloc(512 + 32 + 16 * 16 + 16 + 64);
  buf.write("HM3W", 0, "latin1");
  buf.write(tag.slice(0, 200), 8, "latin1");
  const o = 512;
  buf.writeUInt32LE(0x1a51504d, o);
  buf.writeUInt32LE(32, o + 4);
  buf.writeUInt32LE(buf.length - o, o + 8);
  buf.writeUInt32LE(32, o + 16); // hash table
  buf.writeUInt32LE(32 + 256, o + 20); // block table
  buf.writeUInt32LE(16, o + 24);
  buf.writeUInt32LE(1, o + 28);
  return cut ? buf.subarray(0, buf.length - cut) : buf;
}

test("isWholeMpq: a whole map is one, a cut one or a file without the header isn't; a real map from the fixtures is", () => {
  const whole = fakeMap("x");
  assert.equal(isWholeMpq(whole, whole.length), true);
  assert.equal(isWholeMpq(whole, whole.length - 100), false, "the tables run past a file cut short");
  const moved = Buffer.concat([Buffer.alloc(100), whole]);
  assert.equal(isWholeMpq(moved, moved.length), false, "the header only at a multiple of 512");
  assert.equal(isWholeMpq(Buffer.from("map a.w3m"), 9), false);
  assert.equal(isWholeMpq(Buffer.alloc(0), 0), false);
  const real = repoPath("tests", "fixtures", "we-compare", "camera-bounds.w3m");
  assert.equal(fileIsWholeMpq(real), true, "control: a map the editor saved");
  const dir = scratchDir("we-mpq-");
  try {
    const cut = join(dir, "cut.w3m");
    const bytes = readFileSync(real);
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    assert.equal(fileIsWholeMpq(cut), false, "half of the real map");
    assert.equal(fileIsWholeMpq(join(dir, "none.w3m")), false, "no file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Session: save waits while a Progress window is open, though the file stands still meanwhile", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const t0 = r.clock.t;
  // The editor writes the first part at once, shows "Progress" for 8 s with the file still, writes the rest, closes it.
  let polls = 0;
  r.windows = () => {
    const at = r.clock.t - t0;
    // The first call is save's own look for the main window, before Ctrl+S.
    if (++polls === 1) return [mainWin("a.w3m")];
    if (at < 8000) {
      // A whole archive already (the MPQ check alone can't tell): only the open window says it isn't done.
      if (!existsSync(`${r.s.copy}.part`)) { writeFileSync(r.s.copy, fakeMap("first part")); writeFileSync(`${r.s.copy}.part`, ""); }
      return [mainWin("a.w3m"), dialogWin(12, "Progress")];
    }
    if (!existsSync(`${r.s.copy}.done`)) { writeFileSync(r.s.copy, fakeMap("all of it")); writeFileSync(`${r.s.copy}.done`, ""); }
    return [mainWin("a.w3m")];
  };
  const dest = join(r.dir, "out.w3m");
  const res = await r.s.save(dest);
  assert.equal(res.saved, true, JSON.stringify(res));
  assert.deepEqual(readFileSync(dest), fakeMap("all of it"), "not the part written before the Progress window closed");
  assert.deepEqual(res.waitedFor, ["Progress"]);
  assert.ok(r.clock.t - t0 >= 10000, `${r.clock.t - t0} ms`);
});

test("Session: a save whose file stands still but isn't a whole MPQ is reported, not copied", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  let polls = 0;
  r.windows = () => {
    // The first call is save's own look for the main window, before Ctrl+S.
    if (++polls === 2) writeFileSync(r.s.copy, fakeMap("cut", 300));
    return [mainWin("a.w3m")];
  };
  const dest = join(r.dir, "out.w3m");
  const res = await r.s.save(dest);
  assert.equal(res.saved, false);
  assert.match(res.error, /isn't a whole MPQ/);
  assert.equal(existsSync(dest), false);
});

const crashWin = dialogWin(66, "Blizzard Error");

test("Session: a click, drag or move reads the windows first: a crash dialog is found and nothing clicked", (t) => {
  const r = rig(t);
  r.s.editor = new FakeChild();
  r.windows = [mainWin("a.w3m"), crashWin];
  for (const cmd of ["click", "drag", "move"]) {
    r.calls.length = 0;
    assert.throws(() => r.s.act(cmd, "10,10"), (e) => e instanceof EditorCrashed);
    assert.deepEqual(r.calls.filter(([c]) => c === cmd), [], `no ${cmd}`);
    assert.deepEqual(r.calls[0], ["windows"]);
  }
  r.windows = [mainWin("a.w3m")];
  r.calls.length = 0;
  r.s.act("click", "10,10");
  assert.deepEqual(r.calls.map(([c]) => c), ["windows", "click"], "control: without the dialog it clicks");
});

test("Session: --sleep reads the windows every second and stops at a crash dialog when it comes", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const t0 = r.clock.t;
  r.windows = () => [mainWin("a.w3m"), ...(r.clock.t - t0 >= 2500 ? [crashWin] : [])];
  await assert.rejects(r.s.sleepWatching(60000), (e) => e instanceof EditorCrashed);
  assert.ok(r.clock.t - t0 <= 3000, `found after ${r.clock.t - t0} ms of a 60 s sleep`);
  r.windows = [mainWin("a.w3m")];
  const t1 = r.clock.t;
  await r.s.sleepWatching(2500);
  assert.equal(r.clock.t - t1, 2500, "control: a quiet sleep lasts its time exactly");
  await r.s.sleepWatching(0);
  assert.equal(r.clock.t - t1, 2500, "--sleep 0 doesn't wait");
});

test("Session: ensureLocale gives up on a reg that doesn't finish (killed), and on one that couldn't start", async (t) => {
  const r = rig(t);
  writeFileSync(join(r.pfx, "user.reg"), "WINE REGISTRY Version 2\n");
  const t0 = r.clock.t;
  await assert.rejects(r.s.ensureLocale(), /didn't finish within 120 s/);
  assert.ok(r.clock.t - t0 >= 120000);
  assert.deepEqual(r.ws, ["-k", "-w"], "the prefix killed and waited for");
  r.onSpawn = (c) => setImmediate(() => c.emit("error", Object.assign(new Error("spawn bwrap ENOENT"), { code: "ENOENT" })));
  await assert.rejects(r.s.ensureLocale(), /spawn bwrap ENOENT/);
  // The control: a reg that writes the key and exits 0.
  r.onSpawn = (c) => setImmediate(() => {
    writeFileSync(join(r.pfx, "user.reg"), String.raw`[Software\\Blizzard Entertainment\\Battle.net\\Launch Options\\W3] 1` + `\n"LOCALE"="enUS"\n`);
    c.emit("exit", 0);
  });
  await r.s.ensureLocale();
});

test("Session: start kills a leftover wineserver of the prefix before the first Wine program; a failed spawn ends the editor", async (t) => {
  const r = rig(t);
  writeFileSync(join(r.pfx, "user.reg"), "");
  r.onSpawn = (c, program) => {
    if (program === "reg") setImmediate(() => {
      writeFileSync(join(r.pfx, "user.reg"), String.raw`[Software\\Blizzard Entertainment\\Battle.net\\Launch Options\\W3] 1` + `\n"LOCALE"="enUS"\n`);
      c.emit("exit", 0);
    });
  };
  await r.s.start(r.maps["a.w3m"]);
  assert.deepEqual(r.events.slice(0, 3), ["wineserver -k", "wineserver -w", "spawn reg"]);
  assert.equal(r.events.at(-1), "spawn World Editor.exe");
  assert.equal(r.s.running(), true);
  r.children.at(-1).emit("error", new Error("spawn bwrap EAGAIN"));
  assert.equal(r.s.running(), false, "an editor that never started isn't waited for as running");
});

test("Session: close types n into a dialog that stays at most 3 times, 5 s apart; the Warning is answered once and closes", async (t) => {
  const r = rig(t, { timeout: 30 });
  await r.s.start(r.maps["a.w3m"]);
  // The main window ignores the close; an untitled box stays.
  r.x11 = (cmd, ...rest) => { r.calls.push([cmd, ...rest]); return cmd === "windows" ? { windows: r.windows } : { pressed: true }; };
  r.windows = [mainWin("a.w3m"), dialogWin(30, "")];
  const res = await r.s.close();
  assert.equal(res.closed, false);
  assert.equal(res.timeout, true);
  const typed = r.calls.filter(([c, , id]) => c === "key" && id === 30).length;
  assert.equal(typed, 3, `typed ${typed} times in 30 s (every poll would be 60)`);
  assert.deepEqual(res.answered ?? [], [], "a timeout lists nothing");
  // The Warning goes with its first n.
  const w = rig(t);
  await w.s.start(w.maps["a.w3m"]);
  let gone = false;
  w.x11 = (cmd, ...rest) => {
    w.calls.push([cmd, ...rest]);
    if (cmd === "windows") return { windows: gone ? [] : [mainWin("a.w3m"), dialogWin(31, "Warning")] };
    if (cmd === "key" && rest[1] === 31) gone = true;
    return { pressed: true };
  };
  w.onWineserver = (args) => { if (args[0] === "-w") setImmediate(() => w.children.at(-1).emit("exit", 0)); };
  const ok = await w.s.close();
  assert.equal(ok.closed, true, JSON.stringify(ok));
  assert.deepEqual(ok.answered, ["Warning"]);
});

test("Session: openMap answers Save changes? with No, picks the copy's row, and returns once the map loads", async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  let phase = "main";
  const open = dialogWin(40, "Open Document", [400, 100, 600, 800]);
  r.x11 = (cmd, ...rest) => {
    r.calls.push([cmd, ...rest]);
    if (cmd === "windows") {
      const w = [mainWin(phase === "loading" ? "a.w3m" : "a.w3m")];
      if (phase === "asked") w.push(dialogWin(41, "Warning"));
      if (phase === "list") w.push(open);
      if (phase === "loading") w.push(dialogWin(42, "Progress"));
      return { windows: w };
    }
    if (cmd === "key" && rest.at(-1) === "ctrl+o") phase = "asked";
    else if (cmd === "key" && rest[1] === 41) phase = "list";
    else if (cmd === "click" && rest[0] === `${400 + 482},${100 + 787}`) phase = "loading";
    return { pressed: true };
  };
  const res = await r.s.openMap(r.maps["b.w3m"]);
  assert.equal(res.loading, true);
  assert.deepEqual(res.answered, ["Warning"]);
  assert.deepEqual(r.calls.filter(([c, , id]) => c === "key" && id === 41).map((k) => k.at(-1)), ["n"], "No, once");
  assert.ok(r.calls.some(([c, at]) => c === "click" && at === `${400 + 88},${100 + 105}`), "the list's first row");
  assert.equal(readFileSync(res.copy, "utf8"), "map b.w3m");
  assert.match(basename(res.copy), /^we-open-1-b\.w3m$/);
  assert.equal(r.s.mapName, "we-open-1-b.w3m");
  // The control: a list that never opens is an error (--map then restarts the editor).
  r.x11 = (cmd, ...rest) => { r.calls.push([cmd, ...rest]); return cmd === "windows" ? { windows: [mainWin("a.w3m")] } : { pressed: true }; };
  await assert.rejects(r.s.openMap(r.maps["b.w3m"]), /no "Open Document" list opened/);
});

test("Session: exportMinimap types a file in the work folder, copies the TGA it wrote, and removes its own", { skip: LINUX_ONLY }, async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const exp = dialogWin(50, "Export Minimap", [500, 300, 300, 320]), saveAs = dialogWin(51, "Save As", [450, 250, 500, 400]);
  let shown = [], typed = null;
  r.x11 = (cmd, ...rest) => {
    r.calls.push([cmd, ...rest]);
    if (cmd === "windows") return { windows: [mainWin("a.w3m"), ...shown] };
    if (cmd === "click" && rest[0] === `${4 + 61},${30 + 168}`) shown = [exp];
    else if (cmd === "click" && rest[0] === `${500 + 39},${300 + 20}`) shown = [exp, saveAs];
    else if (cmd === "type") typed = rest.at(-1);
    else if (cmd === "key" && rest.at(-1) === "Return") shown = [exp];
    else if (cmd === "click" && rest[0] === `${500 + 225},${300 + 291}`) {
      writeFileSync(typed.slice(2).split("\\").join("/"), "TGA bytes");
      shown = [];
    }
    return { pressed: true };
  };
  const dest = join(r.dir, "mini.tga");
  const res = await r.s.exportMinimap(dest);
  assert.equal(res.exported, true, JSON.stringify(res));
  assert.equal(readFileSync(dest, "utf8"), "TGA bytes");
  const own = typed.slice(2).split("\\").join("/");
  assert.ok(own.startsWith(join(r.dir, "work")), own);
  assert.equal(existsSync(own), false, "the work folder's copy is gone");
  // The control: an error box after OK is reported, not answered.
  const base = r.x11;
  r.x11 = (cmd, ...rest) => {
    if (cmd === "click" && rest[0] === `${500 + 225},${300 + 291}`) { r.calls.push([cmd, ...rest]); shown = [exp, dialogWin(52, "Error")]; return { pressed: true }; }
    return base(cmd, ...rest);
  };
  const keys = r.calls.length;
  const bad = await r.s.exportMinimap(dest);
  assert.equal(bad.exported, false);
  assert.deepEqual(bad.dialogs.map((d) => d.title), ["Error"]);
  assert.ok(!r.calls.slice(keys).some(([c, , id]) => (c === "key" || c === "type") && id === 52), "nothing typed into it");
});

test("Session: viewItem clicks the item, waits for the view to settle (not a fixed 3 s), and reads the menu again", async (t) => {
  const r = rig(t);
  r.s.opts.mode = "hd";
  await r.s.start(r.maps["a.w3m"]);
  const menu = { id: 60, title: "", class: null, rect: [82, 52, 250, 500], pid: 5, overrideRedirect: true };
  const lighting = VIEW_ITEMS.find((v) => v.item === "Lighting").y;
  let menuOpen = false, on = true, clickedAt = null, settledAt = null, readAfter = null;
  r.x11 = (cmd, ...rest) => {
    r.calls.push([cmd, ...rest]);
    if (cmd === "windows") return { windows: [mainWin("a.w3m"), ...(menuOpen ? [menu] : [])] };
    if (cmd === "click" && rest[0] === `${4 + 78},${30 + 11}`) { menuOpen = true; if (clickedAt !== null && readAfter === null) readAfter = r.clock.t; }
    else if (cmd === "click" && rest[0] === `${82 + 60},${52 + lighting}`) { on = !on; menuOpen = false; clickedAt = r.clock.t; }
    else if (cmd === "key" && rest[0] === "Escape") menuOpen = false;
    else if (cmd === "settle") { settledAt = r.clock.t; return { settled: true, ms: 1000 }; }
    else if (cmd === "shot") {
      const [file, , rect] = rest;
      const [, , w, h] = rect.split(",").map(Number);
      const rgba = new Uint8Array(w * h * 4).fill(240);
      if (on) for (let y = lighting - 3; y < lighting + 3; y++) for (let x = 4; x < 12; x++) rgba.fill(10, (y * w + x) * 4, (y * w + x) * 4 + 3);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, encodePng(w, h, rgba));
    }
    return { pressed: true };
  };
  const res = await r.s.viewItem("Lighting", "off");
  assert.deepEqual(res, { item: "Lighting", state: "off", clicks: 1 });
  assert.ok(settledAt !== null && settledAt > clickedAt, "the view settled after the click");
  const settle = r.calls.find(([c]) => c === "settle");
  assert.deepEqual(settle.slice(1, 3), ["--rect", r.s.viewRect(mainWin("a.w3m")).join(",")]);
  assert.ok(readAfter - clickedAt < 3000, `read again ${readAfter - clickedAt} ms after the click (the fixed wait was 3000)`);
});

test("lavapipeIcds: every lvp_icd*.json of the loader's folders (Ubuntu's name and the per-architecture ones)", () => {
  const listing = { "/a": ["nvidia_icd.json", "lvp_icd.x86_64.json", "lvp_icd.i686.json"], "/b": ["lvp_icd.json"] };
  const list = (d) => { if (!listing[d]) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return listing[d]; };
  assert.deepEqual(lavapipeIcds(["/a", "/none", "/b"], list), ["/a/lvp_icd.i686.json", "/a/lvp_icd.x86_64.json", "/b/lvp_icd.json"]);
  assert.deepEqual(lavapipeIcds(["/none"], list), [], "control: none");
});

test("xvfbCommand: Xvfb under setpriv's death signal when it's there, else plainly", () => {
  assert.deepEqual(xvfbCommand(["-displayfd", "3"], true), ["setpriv", ["--pdeathsig", "KILL", "--", "Xvfb", "-displayfd", "3"]]);
  assert.deepEqual(xvfbCommand(["-displayfd", "3"], false), ["Xvfb", ["-displayfd", "3"]]);
});

test("wineserverPath: files/bin, else dist/bin (older Proton builds), else null", () => {
  assert.equal(wineserverPath("/p", (f) => f === "/p/files/bin/wineserver"), "/p/files/bin/wineserver");
  assert.equal(wineserverPath("/p", (f) => f === "/p/dist/bin/wineserver"), "/p/dist/bin/wineserver");
  assert.equal(wineserverPath("/p", () => false), null);
});

test("Session: the sandbox mounts the machine read-only and only the farm, its prefix, the work folder, the runtime dir and /tmp writable", { skip: LINUX_ONLY }, (t) => {
  const r = rig(t);
  mkdirSync(join(r.dir, "work"), { recursive: true });
  mkdirSync(join(r.dir, "we", "install"), { recursive: true });
  r.s.display = ":77";
  const { bw, env } = r.s.sandboxed("x.exe", []);
  assert.deepEqual(bw.slice(0, 3), ["--ro-bind", "/", "/"]);
  assert.ok(!bw.some((a, i) => a === "--bind" && bw[i + 1] === "/"), "no writable /");
  const writable = bw.flatMap((a, i) => (a === "--bind" ? [bw[i + 1]] : []));
  assert.deepEqual(writable.filter((p) => p.startsWith(r.dir)).sort(), [join(r.dir, "we", "install"), join(r.dir, "we", "prefix"), join(r.dir, "work")].sort());
  assert.ok(writable.includes("/tmp"));
  assert.ok(!writable.includes(process.env.HOME), "not the home folder");
  assert.ok(bw.includes("--die-with-parent") && bw.includes("--unshare-net"));
  assert.ok(!bw.includes("--unshare-pid"), "the crash check reads the editor's /proc/<pid>");
  assert.ok(bw.indexOf("--args") > bw.lastIndexOf("--bind"), "the read-only hardlinks (--args) come after the farm's writable mount");
  assert.equal(env.DISPLAY, ":77");
  assert.equal(env.XDG_CACHE_HOME, join(r.dir, "we", "prefix", "cache"), "caches in a writable folder, not the read-only home");
});

test("pruneArtefacts: the old minimap TGAs go, the newest dialog pictures stay, nothing else is touched", () => {
  const dir = scratchDir("we-prune-");
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `dialog-save-${1000 + i}.png`), "p");
    for (let i = 0; i < 5; i++) utimesSync(join(dir, `dialog-save-${1000 + i}.png`), 1000 + i, 1000 + i);
    writeFileSync(join(dir, "minimap-123.tga"), "t");
    for (const keep of ["editor.log", "mine.png", "minimap.tga", "dialog-notes.txt"]) writeFileSync(join(dir, keep), "k");
    mkdirSync(join(dir, "maps"));
    const removed = pruneArtefacts(dir, 2);
    assert.deepEqual(removed.sort(), ["dialog-save-1000.png", "dialog-save-1001.png", "dialog-save-1002.png", "minimap-123.tga"]);
    assert.deepEqual(readdirSync(dir).sort(), ["dialog-notes.txt", "dialog-save-1003.png", "dialog-save-1004.png", "editor.log", "maps", "mine.png", "minimap.tga"]);
    assert.deepEqual(pruneArtefacts(join(dir, "none")), [], "no folder yet");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Session: the real spawnWine starts the run's log afresh, then adds to it; a failed spawn is an error on the child, not a crash", async (t) => {
  const r = rig(t);
  const s = r.s;
  mkdirSync(join(r.dir, "work"), { recursive: true });
  writeFileSync(s.log, "the run before\n");
  // bwrap can't be found (PATH and the working folder don't exist): node reports an "error" event, which without
  // spawnWine's listener would end the process.
  s.sandboxed = () => ({ bw: ["--version"], env: { PATH: "/nonexistent" }, fdArgs: Buffer.alloc(0) });
  const spawnOnce = () => new Promise((ok) => {
    const child = Session.prototype.spawnWine.call(s, "x", []);
    child.on("error", () => ok(child));
  });
  const first = await spawnOnce();
  assert.ok(first.spawnError && first.exited, "marked on the child");
  assert.equal(readFileSync(s.log, "utf8"), "", "the run before's log is gone");
  writeFileSync(s.log, "this run's reg\n");
  await spawnOnce();
  assert.equal(readFileSync(s.log, "utf8"), "this run's reg\n", "the second program of the run adds to it");
});

test("Session: idle waits for a dialog to appear and fill, asking the helper for the pictures", { skip: LINUX_ONLY }, async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const t0 = r.clock.t;
  // A dialog opens at 1 s and its list is drawn until 1.6 s (its picture's hash changes); the main window never counts.
  r.windows = () => {
    const dt = r.clock.t - t0;
    const main = { ...mainWin("a.w3m"), md5: "never read" };
    if (dt < 1000) return [main];
    return [main, { ...dialogWin(9, "Sound Editor"), md5: `list${Math.min(Math.floor((dt - 1000) / 100), 6)}` }];
  };
  // (The dialog's first sign comes after 1 s: a quiet editor before it is why --idle has a minimum.)
  const res = await r.s.idle("the Sound Editor", { minMs: 1200 });
  const dt = r.clock.t - t0;
  assert.ok(dt >= 2000 && dt < 2300, `idle came ${dt} ms after the start: 400 ms after the last change at 1.6 s`);
  assert.ok(res.polls > 20);
  assert.ok(r.calls.filter(([c]) => c === "windows").every((c) => c.includes("--pics")), "pictures asked in the same call as the list");
  // A window set that keeps changing: the error names what it waited for.
  let n = 0;
  r.windows = () => [mainWin("a.w3m"), dialogWin(9, `Progress ${n++}`)];
  await assert.rejects(r.s.idle("the Trigger Editor to open", { timeoutMs: 2000 }), /waiting for the Trigger Editor to open: the windows \(.*Progress \d+/);
});

test("Session: idle with a window title waits for that window, and the error names it", { skip: LINUX_ONLY }, async (t) => {
  const r = rig(t);
  await r.s.start(r.maps["a.w3m"]);
  const t0 = r.clock.t;
  r.windows = () => [mainWin("a.w3m"), ...(r.clock.t - t0 >= 3000 ? [dialogWin(9, "Sound Editor")] : [])];
  await r.s.idle('a window titled "Sound Editor"', { window: "Sound Editor", minMs: 0 });
  assert.ok(r.clock.t - t0 >= 3400, "400 ms after the window came, not after the start");
  r.windows = () => [mainWin("a.w3m")];
  await assert.rejects(r.s.idle('a window titled "Object Editor"', { window: "Object Editor", timeoutMs: 1000 }), /waiting for a window titled "Object Editor"/);
});

test("parseArgs: --wait-window takes a title, --idle none", () => {
  const o = parseArgs(["--key", "F5", "--wait-window", "Sound Editor", "--idle"]);
  assert.deepEqual(o.steps, [["--key", "F5"], ["--wait-window", "Sound Editor"], ["--idle", null]]);
  assert.throws(() => parseArgs(["--wait-window"]));
});

test("parseArgs: --idle is a step without a value", () => {
  const o = parseArgs(["--key", "F5", "--idle", "--sleep", "100"]);
  assert.deepEqual(o.steps.map(([s]) => s), ["--key", "--idle", "--sleep"]);
});
