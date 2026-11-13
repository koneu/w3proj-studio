// Drives the real Warcraft III World Editor (Linux, through Proton) through a list of steps given on the command
// line, as app-drive.mjs drives Studio: open a map, wait until it's shown, take pictures of the terrain view, press
// keys, click, list the windows, switch game view, close without saving. For comparing Studio with the original.
//
// LOCAL ONLY: it needs the installed game, Proton (Steam's build for the game's prefix), Xvfb, bubblewrap, a C
// compiler, python3 with python-xlib and Pillow, and Mesa's lavapipe, and is no part of CI or the commit gate. When
// one of them is missing it prints {"skipped": why} and exits 0 without starting anything.
//
//   node scripts/we-drive.mjs [options] <steps>
//
// Options:
//   --game DIR          the game's folder (default: W3PROJ_GAME, .game-path)
//   --work DIR          scratch folder (default: target/we-drive of this checkout): map copies, the editor's log
//   --timeout S         how long --wait-ready and --close wait (default 300)
//   --screen WxH        the hidden display's size (default 1600x1000; the positions below are measured there). The
//                       editor sizes its main window by the display, the terrain view following it, which gives
//                       other view sizes (moving the window by X doesn't: the editor doesn't lay out again). It
//                       seems to keep that size in its prefix for the next run: read the view from --wait-ready
//   --mode sd|hd        the editor's graphics (default hd): written into its preferences before the start
//   --day-night cycle|fixed   whether the editor's day and night turn (its own default) or stand still (default fixed:
//                       a turning day changes the brightness from one run to the next, which spoils comparisons)
//
// Steps (in the order given; each prints one JSON line):
//   --map FILE          start the editor with a copy of this map (`World Editor.exe -launch -loadfile Z:\…`)
//   --start             start the editor without a map
//   --wait-ready        wait until the map is shown: the main window has the map's name, no dialog is open, and the
//                       terrain view has drawn. A dialog that stays open (an error, "no longer a melee map", …) is
//                       reported with its title and a picture of the screen, and the run stops, rather than hanging.
//                       The "Progress" window ("Loading Units n/300") isn't a question: it's waited for, up to --timeout
//   --compare-ready     --wait-ready, then game view on, with the day and night fixed (--day-night cycle is refused;
//                       the editor then stands at 06:00): the state to compare with Studio's lit view, app-drive's
//                       --compare-ready lit (TESTING.md, "Comparing pictures")
//   --compare-ready-unlit  --wait-ready, then game view off and View > Lighting off: the pair of app-drive's
//                       --compare-ready unlit
//   --look SPEC         look through a camera: SPEC is x,y[,distance[,aoa[,fov[,rotation]]]] or center[,distance…]
//                       (the terrain's centre); missing values are the editor's opening camera (3000, 304, 70, 90).
//                       Every --look of the run becomes a camera object in we-drive's copy of the map before the
//                       editor starts (unpacked with the release CLI, war3map.w3c.json changed, packed again; the
//                       map's own cameras stay, after them), and this step shows it as TESTING.md records: the camera
//                       layer (m), its row in the palette, View Selected Camera. Prints the camera, and Studio's
//                       equivalent for app-drive's --camera when there is one (we-camera.mjs)
//   --shot FILE.png     picture of the terrain view (the main window's 3D area)
//   --shot-window FILE  picture of the main window
//   --shot-screen FILE  picture of the whole display (dialogs included)
//   --key KEY[@MS]      press a key in the editor ("v", "Escape", "Up", "ctrl+z"; X keysym names); @MS holds it down
//                       that long (the X server's autorepeat runs meanwhile), e.g. "ctrl+Up@2000"//   --click X,Y         click at a position of the display (fixed size, so positions stay put)
//   --drag X,Y:X,Y[@MS] press the left button at the first position, move to the second in 20 steps over MS (400) and
//                       let go (a box select, a doodad move)
//   --drag-mod MOD      hold alt, shift or ctrl during the next --drag (e.g. Alt-move on the Select tab)
//   --move X,Y          move the pointer there without a click (e.g. to the terrain view's edge, which scrolls it)
//   --wheel N[@X,Y]     turn the mouse wheel over the terrain view (its middle, or at X,Y of the display): N notches,
//                       positive zooms in
//   --windows           list the editor's windows: title, rect, and which are dialogs
//   --game-view STATE   "on", "off" or "status": the state of View > Lock to Game View Settings, read from the
//                       picture of the View menu's check mark; on/off press V until it matches, and check again.
//                       Also reports cornerRedPixels, the pinkish red of a "Game View Settings" note in the view's
//                       top-right corner (this build doesn't draw one here: it stays 0 either way)
//   --view-menu         the View menu's items, their shortcuts and check marks (read from a picture of the open menu)
//   --view NAME=STATE   set a View menu item ("Lighting=off", "Info Display=off") by clicking it, "NAME=status" reads it.
//                       With game view on the items above it are greyed: their marks then read as unchecked
//   --fps MS            how often the terrain view's picture changes during MS (it animates day and night)
//   --sleep MS          wait
//   --save FILE         save the map (Ctrl+S; the "Reminder" about the default map name answered with Return) and copy
//                       what the editor wrote to FILE. Another dialog is reported (with a picture), not answered
//   --close             quit without saving: closes the main window and answers "don't save" questions
//                       (a crash-report dialog is never answered: the editor is killed, "crashed": true, nothing sent)
//
// Whatever happens, the editor (wineserver -k for its prefix) and the Xvfb display are stopped at the end.
//
// Isolation (fixed, not options): the editor runs from the farm of we-setup.mjs (shared by all worktrees, one run at a
// time by its lock), in that folder's Wine prefix, inside bubblewrap with the user's Steam prefix (the real install
// included) and every hardlink of the farm mounted read-only. It shows nothing on the user's screen (a display of its
// own, 1600x1000), renders through lavapipe (the NVIDIA driver can't present into Xvfb), and plays no sound: Wine's
// audio drivers are off, PulseAudio and PipeWire are pointed at nothing, and their sockets and /dev/snd are hidden.
// Before each start the editor's preferences in that prefix get no first-start questions, no interface sounds, the
// graphics mode and the day and night setting (editorPrefs); the install's text locale goes into its registry.
//
// Examples:
//   node scripts/we-drive.mjs --map ../smoketest_maps/cliff.w3m --wait-ready --shot ../target/we-shots/cliff.png --close
//   node scripts/we-drive.mjs --map m.w3x --wait-ready --game-view on --shot a.png --game-view off --shot b.png --close
//   node scripts/we-drive.mjs --map m.w3x --compare-ready --look center --shot c.png --look 1000,-500 --shot d.png --close

import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { farmDir, gameDir, linkedFiles, missing, prefixDir, setup, shimPath, takeLock, userCompatData } from "./we-setup.mjs";
import { addLookCameras, fartherPark, parkingLooks, parseLook, resolveLook, studioCamera, terrainHead } from "./we-camera.mjs";
import { ensureCli } from "./appctl.mjs";
import { decodePng } from "./pic-compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const HELPER = join(here, "we-x11.py");
const SIZE = [1600, 1000];
/** Mesa's software Vulkan: the NVIDIA driver can't present into Xvfb. */
const LAVAPIPE = "/usr/share/vulkan/icd.d/lvp_icd.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The layout of the main window, measured in the 1600x1000 display (the editor opens it at 4,30, 1352x937):
// the terrain view starts 152,49 into it and leaves 168 across and 93 down for the panels, toolbar and status bar.
const VIEW_INSET = { x: 152, y: 49, w: 168, h: 93 };
// The View menu: its title in the menu bar, and the check mark of "Lock to Game View Settings" in the open menu.
const VIEW_MENU = { x: 78, y: 11 };
/** The check-mark column of the open View menu, from the menu's corner, and a row's half height. */
const VIEW_CHECK = { x: 2, w: 18, half: 8 };
/**
 * The View menu's items (this build, English): name, shortcut, and the middle of the row from the menu's top
 * (measured in a picture of the open menu, 2026-11-08). Terrain and Grid open submenus and have no check mark.
 */
export const VIEW_ITEMS = Object.freeze([
  ["Terrain", "Ctrl+T", 14], ["Foliage", "Ctrl+F", 31], ["Doodads", "Ctrl+D", 48], ["Units", "Ctrl+U", 65],
  ["Water", "W", 82], ["Blight", "H", 99], ["Shadows", "S", 116], ["Lighting", "L", 133], ["Weather", "E", 150],
  ["Sky", "K", 167], ["Fog Effects", "F", 184], ["Light Ranges", "Ctrl+Shift+L", 201], ["Bloom", "Q", 218],
  ["Ambient Occlusion", "O", 235], ["Grid", "G", 261], ["Camera Bounds", "B", 278], ["Pathing - Ground", "P", 295],
  ["Pathing - Naval", "N", 312], ["Info Display", "I", 329], ["Regions", "Ctrl+R", 346], ["Camera Objects", "Ctrl+M", 363],
  ["Lock to Game View Settings", "V", 389], ["Lock to Game Camera", "C", 406], ["Letterbox Mode", "X", 423],
  ["Snap to Game Camera", "Ctrl+Shift+C", 440], ["Free Camera Mode", "Alt+C", 457], ["Preview DoF", "Shift+C", 474],
].map(([item, key, y]) => Object.freeze({ item, key, y })));

/**
 * The check states of the View menu from a picture of its check-mark column (decoded: { width, height, rgba }, its
 * top the menu's top): an item is checked when its row has 8 or more dark pixels (the mark; the empty column is the
 * menu's light grey).
 */
export function viewChecks(column, items = VIEW_ITEMS) {
  return items.map(({ item, key, y }) => {
    let dark = 0;
    for (let row = Math.max(0, y - VIEW_CHECK.half); row < Math.min(column.height, y + VIEW_CHECK.half); row++) {
      for (let x = 0; x < column.width; x++) {
        const o = (row * column.width + x) * 4;
        if (column.rgba[o] + column.rgba[o + 1] + column.rgba[o + 2] < 200) dark++;
      }
    }
    return { item, key, checked: dark >= 8, dark };
  });
}
// The first-start dialog's Continue button, from the dialog's corner.
const WELCOME = { title: "Welcome to the Warcraft III World Editor", button: { x: 473, y: 470 } };
/** The editor's module windows: it opens those that were open when it was last closed again at the start. */
const REOPENED_MODULES = new Set(["Trigger Editor", "Object Editor", "Sound Editor", "Import Manager", "AI Editor", "Campaign Editor", "Object Manager", "Asset Manager"]);
/** Whether a window is one of those modules. The Campaign Editor's title names its campaign ("Campaign Editor -
 *  [Untitled]" when it reopens with none), so it goes by the start of the title. */
export const isReopenedModule = (title) => REOPENED_MODULES.has(title) || /^Campaign Editor\b/.test(title ?? "");
// The tool palette (at 1356,30 in the display): the first row of the camera layer's list, the rows' height, and
// View Selected Camera, from the palette's corner (TESTING.md, "Applying a camera object").
const CAMERA_PALETTE = { row: { x: 40, y: 147 }, rowHeight: 13, view: { x: 120, y: 89 } };
/** As many looks as the palette's list shows without scrolling (it has room for more; this is what was tried). */
const MAX_LOOKS = 16;

const VALUE_STEPS = new Set(["--map", "--save", "--shot", "--shot-window", "--shot-screen", "--key", "--click", "--drag", "--drag-mod", "--move", "--wheel", "--game-view", "--fps", "--sleep", "--look", "--view"]);
const FLAG_STEPS = new Set(["--start", "--wait-ready", "--compare-ready", "--compare-ready-unlit", "--windows", "--view-menu", "--close"]);

/** The title of the editor's loading window ("Loading Units n/300"): it stays while a big map loads. */
const PROGRESS_TITLE = "Progress";

/**
 * The dialogs among `unknown` (those answerKnown didn't answer) that are questions: a dialog with a title, except
 * the loading window. An untitled window and the "Progress" window come and go while the map loads.
 */
export function questionDialogs(unknown) {
  return unknown.filter((d) => d.title && d.title !== PROGRESS_TITLE);
}

/**
 * Whether a window is the editor's crash-report dialog (it has "Send to Blizzard" ticked and a text box; we-drive must
 * never type into it or send it). By title or class, or by the program that owns it (`program`, the file name of the
 * owning process's argv[0], best effort). Deliberately broad: a false hit only costs the run, a miss could send
 * something to Blizzard.
 *
 * Seen for real (2026-11-13, View > Light Ranges on, then the main window closed): the dialog is titled exactly
 * "Warcraft III World Editor", its class is the editor's own ("steam_app_<appid>"), and it belongs to BlizzardError.exe
 * (`-product Warcraft III World Editor -reopen …\Warcraft III Launcher.exe -attachment …\War3.dmp …`); it comes
 * after the main window is gone. So the program is what tells it apart; title and class are a fallback. A title's
 * "[…]" part (the map's path in the main window's title) is left out, and so is everything but the program's own
 * name: a folder called "we-crash-dialog" in the map's or the farm's path once made the main window count as a crash.
 */
const CRASH_TITLE = /crash|error report|bug ?report|bugsplat|blizzard error|send .*(report|blizzard)|unhandled|unexpected error|fatal|has stopped|stopped working|assert/i;
const CRASH_CLASS = /crash|blizzard.?error|bugsplat|error.?report|bug.?report/i;
const CRASH_PROCESS = /blizzarderror|blizzardcrash|crashpad|crash.?report|crash.?handler|bugsplat|errorreport|werfault/i;
export function isCrashDialog(w, program = "") {
  if (!w || w.overrideRedirect) return false;
  const title = (w.title ?? "").replace(/\[.*\]/g, "");
  return CRASH_TITLE.test(title) || CRASH_CLASS.test(w.class ?? "") || CRASH_PROCESS.test(program ?? "");
}

/** The file name of a program from a process's NUL-separated /proc/PID/cmdline (its argv[0]; Wine's are Windows
 *  paths, "Z:\…\BlizzardError.exe"). Its arguments are left out: they hold paths that may say anything. */
export function programName(cmdline) {
  const argv0 = (cmdline ?? "").split("\0")[0];
  return argv0.split(/[\\/]/).pop();
}

/** The crash dialogs among the raw window list (`programOf` gives the program name of a window's process). */
export function crashDialogs(windows, programOf = () => "") {
  return windows.filter((w) => !w.overrideRedirect && w.rect[2] > 1 && w.rect[3] > 1 && isCrashDialog(w, programOf(w)));
}

/**
 * What --close does with a dialog, `main` being the editor's main window or null. A window of another process than the
 * main window's is never answered ("crash": the real crash dialog has the editor's title and class). "Save changes?"
 * (titled "Warning") gets "n"; an untitled one or one titled like the editor gets "n" only while the editor's main
 * window is still there. With the main window gone it could be a crash reporter nobody recognised: "crash", nothing is
 * typed into it and the editor is killed. Anything else is "report".
 */
export function closeAction(dialog, main) {
  if (main && dialog.pid && main.pid && dialog.pid !== main.pid) return "crash";
  if (dialog.title === "Warning") return "no";
  const editorLike = dialog.title === "" || dialog.title.startsWith("Warcraft III World Editor");
  if (editorLike) return main ? "no" : "crash";
  return "report";
}

/** The line we-drive prints when it found the crash dialog. */
export const CRASH_MESSAGE = "the World Editor crashed; report dismissed without sending";

export class EditorCrashed extends Error {
  constructor(dialogs, screen) {
    super(CRASH_MESSAGE);
    this.crashed = true;
    this.dialogs = dialogs;
    this.screen = screen;
  }
}

function programOfPid(w) {
  if (!w.pid) return "";
  try { return programName(readFileSync(`/proc/${w.pid}/cmdline`, "utf8")); } catch { return ""; }
}

/** "X,Y:X,Y[@MS]" of --drag into { from, to, ms }; the pointer positions are whole numbers of the display. */
export function parseDrag(arg) {
  const m = /^(\d+),(\d+):(\d+),(\d+)(?:@(\d+))?$/.exec(arg ?? "");
  if (!m) throw new Error("--drag wants X,Y:X,Y[@MS]");
  const ms = m[5] === undefined ? 400 : Number(m[5]);
  if (ms < 20 || ms > 60000) throw new Error("--drag: MS must be 20 to 60000");
  return { from: `${m[1]},${m[2]}`, to: `${m[3]},${m[4]}`, ms };
}

export const DRAG_MODS = Object.freeze(["alt", "shift", "ctrl"]);

export function parseArgs(argv) {
  const opts = { game: null, work: join(repo, "target", "we-drive"), timeout: 300, mode: "hd", dayNight: "fixed" };
  let dayNightGiven = false;
  const steps = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--game") opts.game = resolve(value());
    else if (a === "--work") opts.work = resolve(value());
    else if (a === "--timeout") opts.timeout = Number(value());
    else if (a === "--mode") opts.mode = value();
    else if (a === "--screen") {
      const m = /^(\d+)x(\d+)$/.exec(value());
      if (!m) throw new Error("--screen wants WxH");
      opts.screen = [Number(m[1]), Number(m[2])];
    }
    else if (a === "--day-night") { opts.dayNight = value(); dayNightGiven = true; }
    else if (VALUE_STEPS.has(a)) steps.push([a, value()]);
    else if (FLAG_STEPS.has(a)) steps.push([a, null]);
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument ${a} (see the top of we-drive.mjs)`);
  }
  if (dayNightGiven && opts.dayNight === "cycle" && steps.some(([s]) => s === "--compare-ready")) {
    throw new Error("--compare-ready takes pictures with the day and night fixed: leave out --day-night cycle");
  }
  // --drag-mod belongs to the next --drag; each --drag is parsed (and refused) here.
  let pendingMod = null;
  for (let i = 0; i < steps.length; i++) {
    const [step, v] = steps[i];
    if (step === "--drag-mod") {
      if (!DRAG_MODS.includes(v)) throw new Error(`--drag-mod wants ${DRAG_MODS.join(", ")}`);
      pendingMod = v;
      steps.splice(i--, 1);
    } else if (step === "--drag") {
      steps[i] = [step, { ...parseDrag(v), ...(pendingMod ? { mod: pendingMod } : {}) }];
      pendingMod = null;
    }
  }
  if (pendingMod) throw new Error("--drag-mod needs a --drag after it");
  // Every look's camera goes into the map before the editor starts: parsed (and refused) here, numbered by order.
  const looks = steps.filter(([s]) => s === "--look").map(([, v]) => parseLook(v));
  if (looks.length > MAX_LOOKS) throw new Error(`at most ${MAX_LOOKS} --look steps in one run`);
  if (looks.length && steps.findIndex(([s]) => s === "--look") < steps.findIndex(([s]) => s === "--map")) {
    throw new Error("--look needs --map before it (its cameras go into the map)");
  }
  if (looks.length && !steps.some(([s]) => s === "--map")) throw new Error("--look needs --map (its cameras go into the map)");
  const firstSave = steps.findIndex(([s]) => s === "--save"), firstMap = steps.findIndex(([s]) => s === "--map");
  if (firstSave >= 0 && (firstMap < 0 || firstMap > firstSave)) throw new Error("--save needs --map before it (the editor saves over we-drive's copy of the map)");
  return { opts, steps, looks };
}

/**
 * Puts the looks' cameras into `copy`, a copy of a map: unpacks it with the release CLI into `project`, adds the
 * cameras to war3map.w3c.json (or makes the file), and packs it over the copy. A camera file the CLI couldn't read
 * (kept as war3map.w3c) is refused, not replaced. Two parking cameras follow the looks' (we-camera.mjs parkingLooks).
 * Returns { looks, parks }: the looks with their targets filled in, and the parking cameras (none when the terrain
 * couldn't be read). `cli` is the CLI's path, or a function taking its arguments (the tests' stand-in).
 */
export function addCamerasToMap(cli, copy, project, looks) {
  rmSync(project, { recursive: true, force: true });
  const run = typeof cli === "function" ? cli : (args) => {
    const r = spawnSync(cli, args, { encoding: "utf8", timeout: 600000 });
    if (r.status !== 0) throw new Error(`w3proj ${args[0]} failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n").pop()}`);
  };
  // The game's TriggerData isn't needed: the triggers stay as the map has them.
  run(["unpack", copy, project, "--game", "none"]);
  const map = join(project, "map");
  const w3e = join(map, "war3map.w3e.txt");
  const head = existsSync(w3e) ? terrainHead(readFileSync(w3e, "utf8")) : null;
  const resolved = looks.map((l) => {
    if (l.center && !head) throw new Error("--look center needs the terrain's size, and the CLI couldn't read war3map.w3e");
    return resolveLook(l, head);
  });
  // Without the terrain's size there are no parking cameras: the selected camera's circle stays in the picture.
  const parks = head ? parkingLooks(head) : [];
  const json = join(map, "war3map.w3c.json"), raw = join(map, "war3map.w3c");
  let doc = null;
  if (existsSync(json)) doc = JSON.parse(readFileSync(json, "utf8"));
  else if (existsSync(raw)) throw new Error("the map's war3map.w3c can't be read by the cameras codec: not replacing it");
  writeFileSync(json, `${JSON.stringify(addLookCameras(doc, resolved, parks), null, 2)}\n`);
  run(["pack", project, "--output", copy]);
  return { looks: resolved, parks };
}

/** The Proton build Steam uses for the game's prefix, as app/src-tauri/src/proton.rs finds it. */
export function protonFor(game) {
  const compat = userCompatData(game);
  if (!compat) throw new Error(`${game} isn't in a Steam prefix`);
  const info = readFileSync(join(compat, "config_info"), "utf8");
  const line = info.split(/\r?\n/).map((l) => l.trim()).find((l) => /\/(files|dist)\//.test(l));
  if (!line) throw new Error(`no Proton build named in ${join(compat, "config_info")}`);
  const tool = line.slice(0, line.search(/\/(files|dist)\//));
  if (!existsSync(join(tool, "proton"))) throw new Error(`the Proton build ${tool} isn't there any more`);
  const library = dirname(dirname(dirname(compat)));
  const isSteam = (p) => existsSync(join(p, "steam.sh")) || existsSync(join(p, "ubuntu12_32"));
  let steamRoot = library;
  if (!isSteam(library)) {
    const link = join(process.env.HOME ?? "", ".steam", "root");
    if (existsSync(link) && isSteam(link)) steamRoot = link;
  }
  return { tool, steamRoot, appId: basename(compat) };
}

/** A Linux path as the Windows program sees it. */
export const winePath = (p) => `Z:${p.split("/").join("\\")}`;

/** The text locale the install has (from .build.info's tags, e.g. "enUS text?"), else enUS. */
function textLocale(game) {
  const m = /\b([a-z]{2}[A-Z]{2}) text\?/.exec(readFileSync(join(game, ".build.info"), "utf8"));
  return m ? m[1] : "enUS";
}

function x11(display, ...args) {
  const r = spawnSync("python3", ["-I", HELPER, "--display", display, ...args.map(String)], { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) throw new Error(`we-x11 ${args[0]}: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

/** The Reforged switches of the editor's preferences, one per kind of asset. */
const ASSET_KINDS = ["Buildings", "Environment", "EnvOld", "Heroes", "Icons", "Textures", "Units", "Vfx"];

/**
 * The [Misc] keys we-drive sets in WorldEditPreferences.txt: no first-start questions, no interface sounds, the
 * graphics mode (`sd` or `hd`: assetMode, hd and the per-kind switches; see TESTING.md for how that was told apart),
 * and whether the editor's day and night turn (`cycle`) or stand still (`fixed`).
 */
export function editorPrefs(mode, dayNight) {
  if (mode !== "sd" && mode !== "hd") throw new Error("--mode wants sd or hd");
  if (dayNight !== "cycle" && dayNight !== "fixed") throw new Error("--day-night wants cycle or fixed");
  const on = mode === "hd" ? "1" : "0";
  return {
    "Has Been Run": "true",
    "Editor User Interface Sound": "0",
    "Play Splash Sound": "0",
    assetMode: on,
    hd: on,
    ...Object.fromEntries(ASSET_KINDS.map((k) => [k, on])),
    "Fixed Day Night Cycle": dayNight === "fixed" ? "1" : "0",
  };
}

/**
 * Sets keys in one section of an INI-like text (the editor's preferences): a key that is there gets the new value in
 * its place, a missing one goes at the end of the section, a missing section at the end of the text. Every other
 * line stays as it was, line endings included.
 */
export function setPrefs(text, section, values) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const head = `[${section}]`;
  let start = lines.findIndex((l) => l.trim() === head);
  if (start < 0) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(head);
    start = lines.length - 1;
    lines.push("");
  }
  let end = lines.findIndex((l, i) => i > start && /^\[.*\]\s*$/.test(l.trim()));
  if (end < 0) end = lines.length;
  const left = new Map(Object.entries(values));
  for (let i = start + 1; i < end; i++) {
    const eq = lines[i].indexOf("=");
    if (eq < 0) continue;
    const key = lines[i].slice(0, eq);
    if (left.has(key)) { lines[i] = `${key}=${left.get(key)}`; left.delete(key); }
  }
  // New keys after the section's last key, before the blank line that ends it.
  let at = end;
  while (at > start + 1 && lines[at - 1] === "") at--;
  lines.splice(at, 0, ...[...left].map(([k, v]) => `${k}=${v}`));
  return lines.join(eol);
}

/** Sorts the editor's windows: the main window, the palettes, and everything else (dialogs). */
export function classify(windows) {
  const visible = windows.filter((w) => !w.overrideRedirect && w.rect[2] > 1 && w.rect[3] > 1);
  const main = visible.find((w) => w.title.startsWith("Warcraft III World Editor") && w.rect[2] > 800) ?? null;
  const palettes = visible.filter((w) => w !== main && /Palette$/.test(w.title));
  const dialogs = visible.filter((w) => w !== main && !palettes.includes(w));
  const menus = windows.filter((w) => w.overrideRedirect && w.rect[2] > 1 && w.rect[3] > 1);
  return { main, palettes, dialogs, menus };
}

class Session {
  constructor(opts, game) {
    this.opts = opts;
    this.game = game;
    this.proton = protonFor(game);
    this.display = null;
    this.xvfb = null;
    this.editor = null;
    this.mapName = null;
    this.startedAt = 0;
    this.log = join(opts.work, "editor.log");
  }

  async startDisplay() {
    const size = this.opts.screen ?? SIZE;
    const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", `${size[0]}x${size[1]}x24`, "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    this.xvfb = xvfb;
    const n = await new Promise((ok, fail) => {
      let got = "";
      const t = setTimeout(() => fail(new Error("Xvfb didn't start")), 15000);
      xvfb.stdio[3].on("data", (d) => {
        got += d;
        if (got.includes("\n")) { clearTimeout(t); ok(got.trim()); }
      });
      xvfb.on("exit", (code) => { clearTimeout(t); fail(new Error(`Xvfb exited (${code})`)); });
    });
    this.display = `:${n}`;
  }

  /** The environment and the sandbox the editor's processes run in. */
  sandboxed(program, args) {
    const user = userCompatData(this.game);
    const run = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
    const ro = [user, ...linkedFiles()];
    const fdArgs = Buffer.from(ro.flatMap((p) => ["--ro-bind", p, p]).map((s) => `${s}\0`).join(""));
    const bw = ["--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc",
      // No sound: no ALSA devices, no PulseAudio or PipeWire sockets.
      "--tmpfs", "/dev/snd",
      // No network: nothing of this machine (a crash report included) can leave it. The editor works offline.
      "--unshare-net"];
    for (const p of ["pulse"]) if (existsSync(join(run, p))) bw.push("--tmpfs", join(run, p));
    for (const p of ["pipewire-0", "pipewire-0-manager"]) if (existsSync(join(run, p))) bw.push("--ro-bind", "/dev/null", join(run, p));
    bw.push("--args", "3", join(this.proton.tool, "proton"), "run", program, ...args);
    const env = { ...process.env };
    delete env.PIPEWIRE_REMOTE;
    Object.assign(env, {
      DISPLAY: this.display,
      STEAM_COMPAT_DATA_PATH: prefixDir(),
      STEAM_COMPAT_CLIENT_INSTALL_PATH: this.proton.steamRoot,
      SteamAppId: this.proton.appId,
      SteamGameId: this.proton.appId,
      VK_ICD_FILENAMES: LAVAPIPE,
      VK_DRIVER_FILES: LAVAPIPE,
      WINEDEBUG: "-all",
      // English system dialogs whatever the user's language, so their buttons' keys are known ("n" is No).
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      WINEDLLOVERRIDES: ["winepulse.drv=d", "winealsa.drv=d", "wineoss.drv=d", process.env.WINEDLLOVERRIDES].filter(Boolean).join(";"),
      PULSE_SERVER: "unix:/nonexistent",
      PIPEWIRE_RUNTIME_DIR: "/nonexistent",
      LD_PRELOAD: shimPath(),
    });
    return { bw, env, fdArgs };
  }

  spawnWine(program, args) {
    mkdirSync(this.opts.work, { recursive: true });
    const { bw, env, fdArgs } = this.sandboxed(program, args);
    const out = openSync(this.log, "a");
    const child = spawn("bwrap", bw, { cwd: join(farmDir(), "_retail_", "x86_64"), env, stdio: ["ignore", out, out, "pipe"], detached: true });
    closeSync(out);
    child.stdio[3].end(fdArgs);
    return child;
  }

  wineserver(...args) {
    return spawnSync(join(this.proton.tool, "files", "bin", "wineserver"), args, { env: { ...process.env, WINEPREFIX: join(prefixDir(), "pfx") }, stdio: "ignore", timeout: 60000 });
  }

  /** The install's text locale in the prefix's registry, where the launcher would put it (else the editor
   *  falls back to the system's language, which the install may not have, and shows WESTRING_… names). */
  async ensureLocale() {
    const reg = join(prefixDir(), "pfx", "user.reg");
    const locale = textLocale(this.game);
    const has = () => {
      if (!existsSync(reg)) return false;
      // user.reg writes the key as [Software\\Blizzard Entertainment\\Battle.net\\Launch Options\\W3] (doubled).
      const text = readFileSync(reg, "utf8"), key = String.raw`[Software\\Blizzard Entertainment\\Battle.net\\Launch Options\\W3]`;
      const at = text.indexOf(key);
      if (at < 0) return false;
      const end = text.indexOf("\n[", at + key.length);
      return text.slice(at, end < 0 ? undefined : end).includes(`"LOCALE"="${locale}"`);
    };
    if (has()) return;
    const child = this.spawnWine("reg", ["add", "HKCU\\Software\\Blizzard Entertainment\\Battle.net\\Launch Options\\W3", "/v", "LOCALE", "/t", "REG_SZ", "/d", locale, "/f"]);
    const code = await new Promise((ok) => child.on("exit", ok));
    this.wineserver("-w");
    if (code !== 0 || !has()) throw new Error(`couldn't set the editor's locale in the prefix (reg exited ${code}; see ${this.log})`);
  }

  /** The editor's preferences in the prefix, before each start: the keys we-drive needs set, the rest as the editor
   *  left it (a first start writes the whole file). */
  writePrefs() {
    const dir = join(prefixDir(), "pfx", "drive_c", "users", "steamuser", "Documents", "Warcraft III");
    const file = join(dir, "WorldEditPreferences.txt");
    mkdirSync(dir, { recursive: true });
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const after = setPrefs(before, "Misc", editorPrefs(this.opts.mode, this.opts.dayNight));
    if (after !== before) writeFileSync(file, after);
  }

  /** Starts the editor, with a copy of `map` if given; `looks` are the run's --look cameras to put into the copy. */
  async start(map, looks = []) {
    if (this.editor) throw new Error("the editor is already running (one map per run)");
    const exe = join(farmDir(), "_retail_", "x86_64", "World Editor.exe");
    const args = ["-launch"];
    if (map) {
      const dir = join(this.opts.work, "maps");
      mkdirSync(dir, { recursive: true });
      const copy = join(dir, basename(map));
      copyFileSync(map, copy);
      this.copy = copy;
      if (looks.length) ({ looks: this.looks, parks: this.parks } = addCamerasToMap(ensureCli(), copy, join(this.opts.work, "look-project"), looks));
      args.push("-loadfile", winePath(copy));
      this.mapName = basename(map);
    }
    await this.ensureLocale();
    this.writePrefs();
    this.startedAt = Date.now();
    this.editor = this.spawnWine(exe, args);
    this.editor.on("exit", () => { this.editorExited = true; });
  }

  /** The editor's windows. If one is the crash-report dialog, the editor and its prefix's processes (the reporter
   *  included) are killed without touching it and EditorCrashed is thrown. Every step reads windows through here. */
  windows() {
    const all = x11(this.display, "windows").windows;
    const crash = crashDialogs(all, programOfPid);
    if (crash.length) this.crashed(crash.map((w) => ({ title: w.title, class: w.class, program: programOfPid(w) })));
    return classify(all);
  }

  /** The crash dialog was seen: a picture of the screen (read from the X server, nothing sent to the dialog), then the
   *  editor is killed and EditorCrashed thrown. */
  crashed(dialogs) {
    let screen;
    try { screen = this.dialogShot("crash"); } catch { /* the picture is a bonus; the kill isn't */ }
    this.killEditor();
    this.crash = dialogs;
    throw new EditorCrashed(dialogs, screen);
  }

  /** Kills everything the editor started (its crash reporter too) instead of answering anything. */
  killEditor() {
    this.wineserver("-k");
    try { process.kill(-this.editor.pid, "SIGKILL"); } catch { /* gone */ }
    this.editorExited = true;
  }

  viewRect(main) {
    const [x, y, w, h] = main.rect;
    return [x + VIEW_INSET.x, y + VIEW_INSET.y, w - VIEW_INSET.w, h - VIEW_INSET.h];
  }

  shot(file, rect) {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    return x11(this.display, "shot", resolve(file), ...(rect ? ["--rect", rect.join(",")] : []));
  }

  /** Answers the dialogs we-drive knows (the first start's welcome); returns the ones it doesn't. */
  answerKnown(dialogs) {
    const rest = [];
    this.clicked ??= new Map();
    for (const d of dialogs) {
      // The welcome asks to accept Blizzard's terms. The user accepted them in their own install, which the farm is made
      // from, and said on 2026-11-08 that we-drive may accept them in its own prefix. W3PROJ_WE_ACCEPT_TERMS=0 makes it
      // report the dialog instead, like any dialog we-drive doesn't know.
      if (d.title === WELCOME.title && process.env.W3PROJ_WE_ACCEPT_TERMS !== "0") {
        // Once, then again only if it's still there 15 s later (it stays until the editor has loaded the map).
        if (Date.now() - (this.clicked.get(d.id) ?? 0) > 15000) {
          x11(this.display, "click", `${d.rect[0] + WELCOME.button.x},${d.rect[1] + WELCOME.button.y}`);
          this.clicked.set(d.id, Date.now());
          this.answered = [...(this.answered ?? []), d.title];
        }
      } else if (isReopenedModule(d.title)) {
        // A module window the editor opens again because a run before closed the editor with it open (the farm's
        // prefix is shared): closed, once per window, so the map's view is what's shown.
        if (!this.clicked.has(d.id)) {
          x11(this.display, "close", d.id);
          this.clicked.set(d.id, Date.now());
          this.answered = [...(this.answered ?? []), d.title];
        }
      } else rest.push(d);
    }
    return rest;
  }

  dialogShot(name) {
    const file = join(this.opts.work, `dialog-${name}-${Date.now()}.png`);
    this.shot(file);
    return file;
  }

  async waitReady() {
    if (!this.editor) throw new Error("the editor isn't running: add --map or --start first");
    const deadline = Date.now() + this.opts.timeout * 1000;
    let readySince = 0, dialogSince = 0, mainAt = null, progressPolls = 0;
    for (;;) {
      if (this.editorExited) throw new Error(`the editor exited while starting (see ${this.log})`);
      const { main, dialogs } = this.windows();
      if (main && !mainAt) mainAt = Date.now() - this.startedAt;
      const unknown = this.answerKnown(dialogs);
      // A loading window (no title, or "Progress") comes and goes while the map loads; a titled dialog that stays is
      // a question. While one is open the map isn't ready (below), so a long load waits up to the timeout.
      const questions = questionDialogs(unknown);
      // How long the loading window was seen (polls of 0.5 s and more), for the report.
      if (unknown.some((d) => d.title === PROGRESS_TITLE)) progressPolls++;
      if (questions.length) {
        dialogSince ||= Date.now();
        if (Date.now() - dialogSince > 3000) {
          return { ready: false, dialogs: questions.map((d) => ({ title: d.title, rect: d.rect })), screen: this.dialogShot("wait") };
        }
      } else dialogSince = 0;
      const titled = main && (!this.mapName || main.title.includes("["));
      let drawn = false;
      if (titled && !unknown.length) {
        // The middle of the view (counting the whole of it in Python takes seconds).
        const [vx, vy, vw, vh] = this.viewRect(main);
        const s = x11(this.display, "stats", "--rect", [vx + Math.round(vw / 2) - 150, vy + Math.round(vh / 2) - 100, 300, 200].join(","));
        // Black until the view has drawn (dark ground, like Lordaeron's grass at night, isn't black).
        drawn = s.blackPixels < s.pixels * 0.5;
      }
      if (drawn) {
        readySince ||= Date.now();
        if (Date.now() - readySince > 3000) {
          return { ready: true, title: main.title, mainWindowMs: mainAt, readyMs: Date.now() - this.startedAt, view: this.viewRect(main), answered: this.answered ?? [], progressPolls };
        }
      } else readySince = 0;
      if (Date.now() > deadline) {
        return { ready: false, timeout: this.opts.timeout, title: main?.title ?? null, dialogs: unknown.map((d) => ({ title: d.title, rect: d.rect })), screen: this.dialogShot("timeout") };
      }
      await sleep(500);
    }
  }

  /**
   * Saves the map (File > Save, Ctrl+S) and copies what the editor wrote to `dest`. The "Reminder" box (a map still
   * named "Just another Warcraft III map") is answered with Return. Done when the map's copy has changed, no dialog is
   * open and the file stood still for 2 s; another dialog is reported with a picture of the screen, not answered.
   */
  async save(dest) {
    if (!this.copy) throw new Error("--save needs --map before it (the editor saves over we-drive's copy of the map)");
    const { main } = this.mainOrThrow();
    const stamp = () => { try { const s = statSync(this.copy); return `${s.mtimeMs}:${s.size}`; } catch { return null; } };
    const before = stamp();
    x11(this.display, "key", "--window", main.id, "ctrl+s");
    const deadline = Date.now() + this.opts.timeout * 1000, answered = [];
    let last = before, stillSince = 0;
    while (Date.now() < deadline) {
      await sleep(500);
      if (this.editorExited) throw new Error(`the editor exited while saving (see ${this.log})`);
      const questions = questionDialogs(this.windows().dialogs);
      const reminder = questions.find((d) => d.title === "Reminder");
      if (reminder) {
        x11(this.display, "key", "--window", reminder.id, "Return");
        answered.push(reminder.title);
        stillSince = 0;
        continue;
      }
      if (questions.length) return { saved: false, dialogs: questions.map((d) => ({ title: d.title, rect: d.rect })), screen: this.dialogShot("save") };
      const now = stamp();
      if (now !== last) { last = now; stillSince = 0; continue; }
      if (now !== before && now !== null) {
        stillSince ||= Date.now();
        if (Date.now() - stillSince >= 2000) {
          mkdirSync(dirname(resolve(dest)), { recursive: true });
          copyFileSync(this.copy, resolve(dest));
          return { saved: true, file: resolve(dest), bytes: statSync(this.copy).size, answered };
        }
      }
    }
    return { saved: false, timeout: this.opts.timeout, screen: this.dialogShot("save") };
  }

  mainOrThrow() {
    const w = this.windows();
    if (!w.main) throw new Error("no main window of the editor");
    return w;
  }

  /** Opens the View menu; returns its window. */
  async openViewMenu() {
    const { main } = this.mainOrThrow();
    x11(this.display, "click", `${main.rect[0] + VIEW_MENU.x},${main.rect[1] + VIEW_MENU.y}`);
    let menu = null;
    for (let i = 0; i < 20 && !menu; i++) {
      await sleep(150);
      menu = this.windows().menus.find((m) => m.rect[3] > 300) ?? null;
    }
    if (!menu) throw new Error("the View menu didn't open");
    await sleep(200);
    return menu;
  }

  async closeMenu() {
    x11(this.display, "key", "Escape");
    x11(this.display, "key", "Escape");
    await sleep(200);
  }

  /** The View menu's items and their check marks (from a picture of its check-mark column). */
  async viewMenu() {
    const menu = await this.openViewMenu();
    const file = join(this.opts.work, "view-menu-checks.png");
    try {
      this.shot(file, [menu.rect[0] + VIEW_CHECK.x, menu.rect[1], VIEW_CHECK.w, menu.rect[3]]);
      return viewChecks(decodePng(readFileSync(file)));
    } finally {
      await this.closeMenu();
    }
  }

  /** Sets a View menu item on or off by clicking it in the menu (checked again afterwards); "status" only reads. */
  async viewItem(name, want) {
    if (!["on", "off", "status"].includes(want)) throw new Error("--view wants NAME=on, NAME=off or NAME=status");
    const spec = VIEW_ITEMS.find((v) => v.item.toLowerCase() === name.toLowerCase());
    if (!spec) throw new Error(`no View menu item "${name}" (${VIEW_ITEMS.map((v) => v.item).join(", ")})`);
    const state = async () => (await this.viewMenu()).find((v) => v.item === spec.item).checked;
    let on = await state(), clicks = 0;
    while (want !== "status" && on !== (want === "on")) {
      if (clicks >= 2) throw new Error(`View > ${spec.item} is still ${on ? "on" : "off"} after clicking it ${clicks} times`);
      const menu = await this.openViewMenu();
      x11(this.display, "click", `${menu.rect[0] + 60},${menu.rect[1] + spec.y}`);
      clicks++;
      await sleep(this.opts.mode === "hd" ? 3000 : 1000);
      on = await state();
    }
    return { item: spec.item, state: on ? "on" : "off", clicks };
  }

  /** Lock to Game View Settings, from the View menu's check mark. */
  async gameViewState() {
    const item = (await this.viewMenu()).find((v) => v.item === "Lock to Game View Settings");
    return { on: item.checked, checkDarkPixels: item.dark };
  }

  async gameView(want) {
    if (!["on", "off", "status"].includes(want)) throw new Error("--game-view wants on, off or status");
    let st = await this.gameViewState();
    const presses = [];
    while (want !== "status" && st.on !== (want === "on")) {
      if (presses.length >= 3) throw new Error(`game view is still ${st.on ? "on" : "off"} after pressing V ${presses.length} times`);
      x11(this.display, "key", "v");
      await sleep(500);
      st = await this.gameViewState();
      presses.push(st.on ? "on" : "off");
    }
    // The user's test: "Game View Settings" in pinkish red in the view's top-right corner.
    const { main } = this.windows();
    const [vx, vy, vw] = this.viewRect(main);
    const corner = x11(this.display, "stats", "--rect", [vx + vw - 260, vy, 260, 40].join(","));
    return { gameView: st.on ? "on" : "off", pressedV: presses.length, checkDarkPixels: st.checkDarkPixels, cornerRedPixels: corner.redPixels };
  }

  /** Shows the camera of look `i` (row i of the camera palette): camera layer, its row, View Selected Camera. */
  async look(i) {
    const look = this.looks?.[i];
    if (!look) throw new Error(`no camera for look ${i + 1} in the map (was it started with --map?)`);
    const { main } = this.mainOrThrow();
    x11(this.display, "key", "--window", main.id, "m");
    await sleep(500);
    const palette = this.windows().palettes.find((p) => p.rect[0] > main.rect[0] + main.rect[2] / 2);
    if (!palette) throw new Error("no tool palette right of the main window");
    const [px, py] = palette.rect;
    const row = (r) => x11(this.display, "click", `${px + CAMERA_PALETTE.row.x},${py + CAMERA_PALETTE.row.y + r * CAMERA_PALETTE.rowHeight}`);
    row(i);
    await sleep(300);
    x11(this.display, "click", `${px + CAMERA_PALETTE.view.x},${py + CAMERA_PALETTE.view.y}`);
    // The selected camera's circle is in the middle of the picture: selecting the parking camera farther away (only
    // selected, not viewed) moves it out.
    let parked = null;
    if (this.parks?.length) {
      await sleep(300);
      parked = fartherPark(look, this.parks);
      row(this.looks.length + parked);
    }
    // The view draws about 14 frames a second in SD and 2 in HD.
    await sleep(this.opts.mode === "hd" ? 4000 : 1500);
    let studio = null;
    try { studio = studioCamera(look); } catch { /* not fitted for this angle or field of view */ }
    const camera = studio && Object.entries(studio).map(([k, v]) => `${k}=${v}`).join(",");
    const selected = parked === null ? null : [this.parks[parked].x, this.parks[parked].y];
    return { row: i, look: { x: look.x, y: look.y, distance: look.distance, aoa: look.aoa, fov: look.fov, rotation: look.rotation }, studioCamera: camera, selectedParkingCamera: selected };
  }

  async close() {
    if (!this.editor || this.editorExited) return { closed: true, answered: [] };
    const answered = [];
    try {
      return await this.closeSteps(answered);
    } catch (e) {
      if (e instanceof EditorCrashed) return { closed: true, crashed: true, answered, dialogs: e.dialogs, message: CRASH_MESSAGE, screen: e.screen };
      throw e;
    }
  }

  async closeSteps(answered) {
    const { main } = this.windows();
    if (main) x11(this.display, "close", main.id);
    const deadline = Date.now() + Math.min(this.opts.timeout, 120) * 1000;
    while (Date.now() < deadline) {
      await sleep(500);
      const w = this.windows();
      if (!w.main && !w.dialogs.length && !w.palettes.length) {
        this.wineserver("-w");
        return { closed: true, answered };
      }
      for (const d of w.dialogs) {
        // "Save changes to …?" is a message box titled "Warning" (Yes, No, Cancel): "n" is its "No".
        const action = closeAction(d, w.main);
        if (action === "crash") this.crashed([{ title: d.title, class: d.class, program: programOfPid(d) }]);
        if (action === "no") {
          x11(this.display, "key", "--window", d.id, "n");
          answered.push(d.title || "(untitled)");
        } else {
          return { closed: false, dialogs: [{ title: d.title, rect: d.rect }], screen: this.dialogShot("close") };
        }
      }
    }
    return { closed: false, timeout: true, screen: this.dialogShot("close") };
  }

  stop() {
    if (this.editor) {
      this.wineserver("-k");
      try { process.kill(-this.editor.pid, "SIGKILL"); } catch { /* gone */ }
    }
    if (this.xvfb && this.xvfb.exitCode === null && this.xvfb.signalCode === null) {
      this.xvfb.kill("SIGTERM");
      // Waited for (synchronously, as this also runs from a signal handler): gone within 5 s, else killed.
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        try { process.kill(this.xvfb.pid, 0); } catch { return; }
        spawnSync("sleep", ["0.1"]);
      }
      try { process.kill(this.xvfb.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
}

async function main() {
  const { opts, steps, looks } = parseArgs(process.argv.slice(2));
  if (opts.help || !steps.length) {
    console.log("usage: node scripts/we-drive.mjs [options] <steps>; the steps and options are listed at the top of the file");
    return 0;
  }
  const out = (o) => console.log(JSON.stringify(o));
  const game = gameDir(opts.game ?? undefined);
  let why = missing(game);
  if (!why && !existsSync(LAVAPIPE)) why = `no lavapipe Vulkan driver (${LAVAPIPE}; Debian/Ubuntu: mesa-vulkan-drivers)`;
  if (!why) {
    try { protonFor(game); } catch (e) { why = e.message; }
  }
  if (why) {
    out({ skipped: why });
    console.error(`we-drive: skipped, ${why} (local only: it needs the installed game, Proton, Xvfb, bubblewrap)`);
    return 0;
  }
  setup(game);
  const release = await takeLock((m) => console.error(`we-drive: ${m}`));
  const s = new Session(opts, game);
  const stopAll = () => { s.stop(); release(); };
  const onSignal = () => { stopAll(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let failed = false, lookIndex = 0;
  try {
    await s.startDisplay();
    for (const [step, arg] of steps) {
      try {
        if (step === "--map") {
          const map = resolve(arg);
          if (!existsSync(map)) throw new Error(`no map at ${map}`);
          await s.start(map, looks);
          out({ step, map, display: s.display, ...(looks.length ? { cameras: looks.length } : {}) });
        } else if (step === "--start") {
          await s.start(null);
          out({ step, display: s.display });
        } else if (step === "--wait-ready") {
          const r = await s.waitReady();
          out({ step, ...r });
          if (!r.ready) { failed = true; break; }
        } else if (step === "--compare-ready") {
          if (opts.dayNight !== "fixed") throw new Error("--compare-ready wants the day and night fixed");
          const r = await s.waitReady();
          if (!r.ready) { out({ step, ...r }); failed = true; break; }
          out({ step, ...r, dayNight: opts.dayNight, ...(await s.gameView("on")) });
        } else if (step === "--compare-ready-unlit") {
          const r = await s.waitReady();
          if (!r.ready) { out({ step, ...r }); failed = true; break; }
          const gv = await s.gameView("off");
          out({ step, ...r, ...gv, lighting: (await s.viewItem("Lighting", "off")).state });
        } else if (step === "--look") {
          out({ step, ...(await s.look(lookIndex++)) });
        } else if (step === "--view-menu") {
          out({ step, items: await s.viewMenu() });
        } else if (step === "--view") {
          const eq = arg.lastIndexOf("=");
          if (eq < 1) throw new Error("--view wants NAME=on|off|status");
          out({ step, ...(await s.viewItem(arg.slice(0, eq), arg.slice(eq + 1))) });
        } else if (step === "--shot") {
          const { main } = s.mainOrThrow();
          out({ step, ...s.shot(arg, s.viewRect(main)) });
        } else if (step === "--shot-window") {
          const { main } = s.mainOrThrow();
          out({ step, ...s.shot(arg, main.rect) });
        } else if (step === "--shot-screen") {
          out({ step, ...s.shot(arg, null) });
        } else if (step === "--key") {
          // To the open dialog if there is one, else to the main window (without a window manager the keyboard
          // stays with whatever was clicked last, e.g. the tool palette).
          // KEY@MS holds it down MS (the X server's autorepeat runs meanwhile).
          const m = /^(.+?)(?:@(\d+))?$/.exec(arg);
          const w = s.windows();
          const to = w.dialogs.at(-1) ?? w.main;
          x11(s.display, "key", ...(to ? ["--window", to.id] : []), m[1], ...(m[2] ? ["--hold", m[2]] : []));
          await sleep(300);
          out({ step, key: m[1], ...(m[2] ? { holdMs: Number(m[2]) } : {}), dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--click") {
          if (!/^\d+,\d+$/.test(arg)) throw new Error("--click wants X,Y");
          x11(s.display, "click", arg);
          await sleep(300);
          out({ step, at: arg, dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--drag") {
          x11(s.display, "drag", arg.from, arg.to, "--ms", arg.ms, ...(arg.mod ? ["--mod", arg.mod] : []));
          await sleep(300);
          out({ step, from: arg.from, to: arg.to, ms: arg.ms, ...(arg.mod ? { mod: arg.mod } : {}), dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--move") {
          if (!/^\d+,\d+$/.test(arg)) throw new Error("--move wants X,Y");
          x11(s.display, "move", arg);
          out({ step, at: arg });
        } else if (step === "--wheel") {
          // Mouse wheel over the terrain view (its middle, or N@X,Y at a position of the display): positive zooms in
          // (button 4), negative out (button 5).
          const m = /^(-?\d+)(?:@(\d+),(\d+))?$/.exec(arg);
          const n = m ? Number(m[1]) : NaN;
          if (!Number.isInteger(n) || n === 0) throw new Error("--wheel wants a whole number of notches, not 0, and optionally @X,Y");
          const { main } = s.mainOrThrow();
          const [vx, vy, vw, vh] = s.viewRect(main);
          const at = m[2] ? `${m[2]},${m[3]}` : `${vx + Math.round(vw / 2)},${vy + Math.round(vh / 2)}`;
          for (let i = 0; i < Math.abs(n); i++) {
            x11(s.display, "click", at, "--button", n > 0 ? 4 : 5);
            await sleep(100);
          }
          await sleep(500);
          out({ step, notches: n, at });
        } else if (step === "--windows") {
          const w = s.windows();
          const brief = (x) => ({ title: x.title, rect: x.rect });
          out({ step, main: w.main && brief(w.main), palettes: w.palettes.map(brief), dialogs: w.dialogs.map(brief), menus: w.menus.map(brief) });
        } else if (step === "--game-view") {
          out({ step, ...(await s.gameView(arg)) });
        } else if (step === "--fps") {
          const { main } = s.mainOrThrow();
          out({ step, ...x11(s.display, "frames", Number(arg), "--rect", s.viewRect(main).join(",")) });
        } else if (step === "--sleep") {
          await sleep(Number(arg));
          out({ step });
        } else if (step === "--save") {
          const r = await s.save(arg);
          out({ step, ...r });
          if (!r.saved) { failed = true; break; }
        } else if (step === "--close") {
          const r = await s.close();
          out({ step, ...r });
          if (!r.closed) { failed = true; break; }
        }
      } catch (e) {
        failed = true;
        out({ step, arg, error: e.message, ...(e.crashed ? { crashed: true, dialogs: e.dialogs, screen: e.screen } : {}) });
        break;
      }
    }
    return failed ? 1 : 0;
  } finally {
    stopAll();
  }
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "we-drive.mjs") {
  try {
    process.exit(await main());
  } catch (e) {
    console.error(`we-drive: ${e.message}`);
    process.exit(1);
  }
}
