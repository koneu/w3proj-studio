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
//   --keyboard LAYOUT   the display's keyboard layout (setxkbmap, e.g. de) before the editor starts. --key names keysyms,
//                       so under de the key named z is the physical key US keyboards call Y
//   --mode sd|hd|de     the editor's graphics (default hd; de = the 3.0 art): written into its preferences before the start
//   --save-accept T1,T2  titles of dialogs --save answers with Return besides "Reminder" (e.g. "Warning": the notice that the
//                       map is no longer a melee map); another dialog still stops the save
//   --keep-prefs        leave Enforce Water Limits, Enforce Camera Boundaries and the minimap's Show Creep Camp Icon in
//                       the preferences as they are (default: written as the editor's defaults before each start, so a
//                       run doesn't depend on the last one)
//   --day-night cycle|fixed   whether the editor's day and night turn (its own default) or stand still (default fixed:
//                       a turning day changes the brightness from one run to the next, which spoils comparisons)
//   --pref S/KEY=VALUE  a key of WorldEditPreferences.txt written before each start of the editor (after we-drive's
//                       own, --keep-prefs or not), e.g. "Misc/Enforce Water Limits=false"; repeatable
//   --expect-layout     --wait-ready fails ("layout": why) when the main window isn't at 4,30 1352x937 or the tool
//                       palette not at 1356,30: the layout spec clicks are measured in (we-compare passes it)
//
// Steps (in the order given; each prints one JSON line):
//   --map FILE          start the editor with a copy of this map (`World Editor.exe -launch -loadfile Z:\…`)
//                       Another --map while the editor runs opens the map in it (as --open; if that fails, the editor is
//                       stopped and started again with the map: "via": "open" or "restart" says which); after a --close
//                       it starts the editor again. One display, one lock, one setup for several maps (we-compare.mjs);
//                       the --look cameras go into the first map only
//   --open FILE         open this map in the running editor (a copy in the prefix's Documents/Warcraft III/Maps; Ctrl+O, its row in
//                       the editor's Open list, OK;
//                       a "Save changes?" question about the map before is answered No: put --save before it to keep
//                       that map's changes), then --wait-ready as after --map. Each further map costs its load time,
//                       not an editor start
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
//                       layer (m), its row in the palette, View Selected Camera, then waits until two pictures of
//                       the view a frame apart are the same (at most 10 s; "viewSettled"). Prints the camera, and Studio's
//                       equivalent for app-drive's --camera when there is one (we-camera.mjs)
//   --shot FILE.png     picture of the terrain view (the main window's 3D area)
//   --shot-window FILE  picture of the main window
//   --shot-screen FILE  picture of the whole display (dialogs included)
//   --clipboard FILE    the clipboard's text into FILE (what Wine gives X: its own CRLF line ends are not visible
//                       there); prints the byte count, "bytes": null with a "reason" when there is none (no owner,
//                       refused, timeout, incremental)
//   --key KEY[@MS]      press a key in the editor ("v", "Escape", "Up", "ctrl+z"; X keysym names; "A" or ":" with Shift,
//                       "+" the plus key); @MS holds it down that long (the X server's autorepeat runs meanwhile), e.g.
//                       "ctrl+Up@2000"
//   --numlock on|off|status   Num Lock as the X server holds it (it stays across editors on one display): on/off press
//                       Num_Lock only when it differs, and fail when it still does; the number pad's digits (KP_6, the
//                       nudge) want it on. Unlike a blind "--key Num_Lock" it doesn't depend on the step before
//   --click X,Y         click at a position of the display (fixed size, so positions stay put)
//   --double-click X,Y  the same, twice in a row (a list row's own dialog: Advanced > Adjust Map String IDs)
//   --drag X,Y:X,Y[@MS] press the left button at the first position, move to the second in 20 steps over MS (400) and
//                       let go (a box select, a doodad move)
//   --drag-mod MOD      hold alt, shift or ctrl during the next --drag (e.g. Alt-move on the Select tab)
//   --drag-button N     the next --drag uses mouse button 2 (middle) or 3 (right) instead of the left one
//   --move X,Y          move the pointer there without a click (e.g. to the terrain view's edge, which scrolls it)
//   --wheel N[@X,Y]     turn the mouse wheel over the terrain view (its middle, or at X,Y of the display): N notches,
//                       positive zooms in
//   --close-modules     close the module windows this run opened (Sound Editor after F5, …): the next map of a run
//                       (--map/--open) starts from the map's own view, and a window left open ended one (sound-order-sort)
//   --windows           list the editor's windows: title, rect, and which are dialogs
//   --game-view STATE   "on", "off" or "status": the state of View > Lock to Game View Settings, read from the
//                       picture of the View menu's check mark; on/off press V until it matches, and check again.
//                       Also reports cornerRedPixels, the pinkish red of a "Game View Settings" note in the view's
//                       top-right corner (this build doesn't draw one here: it stays 0 either way)
//   --view-menu         the View menu's items, their shortcuts and check marks (read from a picture of the open menu)
//   --view NAME=STATE   set a View menu item ("Lighting=off", "Info Display=off") by clicking it, "NAME=status" reads it.
//                       With game view on the items above it are greyed: their marks then read as unchecked
//   --fps MS            how often the terrain view's picture changes during MS (it animates day and night)
//   --sleep MS          wait (the windows read every second meanwhile: a crash dialog stops the run when it comes)
//   --save FILE         save the map (Ctrl+S; the "Reminder" about the default map name answered with Return) and copy
//                       what the editor wrote to FILE. Another dialog is reported (with a picture), not answered
//   --export-minimap FILE   File > Export Minimap… with the dialog's defaults (256, terrain, water, doodads, Playable
//                       Area Only); the TGA it writes is copied to FILE. Another dialog is reported, not answered
//   --type TEXT         type TEXT into the open dialog (else the main window), Shift where a character needs it; printable
//                       ASCII only (a text with another character types nothing and fails)
//   --close             quit without saving: closes the main window and answers "don't save" questions
//                       (a crash-report dialog is never answered: the editor is killed, "crashed": true, nothing sent)
//
// Whatever happens, the editor (wineserver -k for its prefix) and the Xvfb display are stopped at the end (an uncaught
// error and a closed stdout included). Killed past that (SIGKILL), bwrap's --die-with-parent takes Proton along, and
// the next run's start kills the prefix's leftover wineserver first.
//
// Isolation (fixed, not options): the editor runs from the farm of we-setup.mjs (shared by all worktrees, one run at a
// time by its lock), in that folder's Wine prefix, inside bubblewrap with the whole machine mounted read-only except the
// farm, its prefix, the work folder, the runtime dir and /tmp (writableDirs), and the user's Steam prefix (the real
// install included) and every hardlink of the farm read-only within those. It shows nothing on the user's screen (a display of its
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
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { farmDir, gameDir, linkedFiles, missing, prefixDir, setup, shimPath, takeLock, userCompatData } from "./we-setup.mjs";
import { addLookCameras, fartherPark, parkingLooks, parseLook, resolveLook, studioCamera, terrainHead } from "./we-camera.mjs";
import { ensureCli } from "./appctl.mjs";
import { decodePng } from "./pic-compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const HELPER = join(here, "we-x11.py");
const SIZE = [1600, 1000];
/** Where the Vulkan loader looks for drivers' manifests. */
const ICD_DIRS = ["/usr/share/vulkan/icd.d", "/etc/vulkan/icd.d"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The layout of the main window, measured in the 1600x1000 display (the editor opens it at 4,30, 1352x937):
// the terrain view starts 152,49 into it and leaves 168 across and 93 down for the panels, toolbar and status bar.
const VIEW_INSET = { x: 152, y: 49, w: 168, h: 93 };
// The View menu: its title in the menu bar, and the check mark of "Lock to Game View Settings" in the open menu.
const VIEW_MENU = { x: 78, y: 11 };
/** File > Export Minimap… (from the main window's corner), and in its dialog (from the dialog's corner) the Image File
 *  button and OK (measured 2026-11-13). The dialog opens with the editor's defaults: 256, terrain, water, doodads,
 *  Playable Area Only. */
const EXPORT_MINIMAP = { file: { x: 14, y: 11 }, item: { x: 61, y: 168 }, imageFile: { x: 39, y: 20 }, ok: { x: 225, y: 291 } };
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
const MODULE_RECLOSE_MS = 3000;
/** How long a module window may stay after the closes before the main window is taken as raised over it. */
const MODULE_STUCK_MS = 9000;
const REOPENED_MODULES = new Set(["Trigger Editor", "Object Editor", "Sound Editor", "Import Manager", "AI Editor", "Campaign Editor", "Object Manager", "Asset Manager"]);
/** Whether a window is one of those modules. The Campaign Editor's and the AI Editor's title name their file ("Campaign
 *  Editor - [Untitled]", "AI Editor - [Untitled]" when it reopens with none), so it goes by the start of the title. */
export const isReopenedModule = (title) => REOPENED_MODULES.has(title) || /^(Campaign|AI) Editor\b/.test(title ?? "");
// The tool palette (at 1356,30 in the display): the first row of the camera layer's list, the rows' height, and
// View Selected Camera, from the palette's corner (TESTING.md, "Applying a camera object").
const CAMERA_PALETTE = { row: { x: 40, y: 147 }, rowHeight: 13, view: { x: 120, y: 89 } };
/** As many looks as the palette's list shows without scrolling (it has room for more; this is what was tried). */
const MAX_LOOKS = 16;

const VALUE_STEPS = new Set(["--map", "--open", "--save", "--export-minimap", "--shot", "--shot-window", "--shot-screen", "--clipboard", "--key", "--numlock", "--type", "--click", "--double-click", "--drag", "--drag-mod", "--drag-button", "--move", "--wheel", "--game-view", "--fps", "--sleep", "--look", "--view"]);

/** The main window and the tool palette in the 1600x1000 display, where every spec's clicks were measured (TESTING.md
 *  "Layout"). */
export const LAYOUT = Object.freeze({ main: Object.freeze([4, 30, 1352, 937]), palette: Object.freeze([1356, 30]) });

/**
 * What is wrong with the editor's layout for clicks measured in LAYOUT, or null: the main window's place and size,
 * and a tool palette's corner (`main`, `palettes` as classify gives them). For --expect-layout (we-compare).
 */
export function layoutProblem(main, palettes, want = LAYOUT) {
  if (!main) return "the editor's layout can't be checked: no main window";
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (!same(main.rect, want.main)) return `the editor's main window is at ${main.rect.slice(0, 2).join(",")} ${main.rect[2]}x${main.rect[3]}, not ${want.main.slice(0, 2).join(",")} ${want.main[2]}x${want.main[3]}: the spec's clicks were measured in that layout (the 1600x1000 display; does the farm's prefix keep another window size? TESTING.md "Layout")`;
  const p = palettes.find((w) => w.rect[0] >= main.rect[0] + main.rect[2] / 2);
  if (p && !same(p.rect.slice(0, 2), want.palette)) return `the editor's tool palette is at ${p.rect.slice(0, 2).join(",")}, not ${want.palette.join(",")}: the spec's palette clicks were measured there`;
  return null;
}

/** A --pref value "Section/Key=value" into { section, key, value } (the key may hold spaces and "-"; not "="). */
export function parsePref(v) {
  const m = /^([^/[\]\r\n]+)\/([^=\r\n]+)=([^\r\n]*)$/.exec(v ?? "");
  if (!m || m[2] !== m[2].trim()) throw new Error(`--pref wants Section/Key=value ("Misc/Enforce Water Limits=false"), not ${JSON.stringify(v)}`);
  return { section: m[1], key: m[2], value: m[3] };
}
const FLAG_STEPS = new Set(["--start", "--wait-ready", "--compare-ready", "--compare-ready-unlit", "--windows", "--close-modules", "--view-menu", "--close"]);

/** File > Open's own list (Ctrl+O), its title, and from its corner the first row and the OK button (measured 2026-11-13). */
const OPEN_DIALOG = "Open Document";
const OPEN_LIST = { row: { x: 88, y: 105 }, ok: { x: 482, y: 787 } };

/** The title of the editor's loading window ("Loading Units n/300"): it stays while a big map loads. */
const PROGRESS_TITLE = "Progress";

/**
 * The dialogs among `unknown` (those answerKnown didn't answer) that are questions: a dialog with a title, except
 * the loading window and the editor's module windows. An untitled window and the "Progress" window come and go while
 * the map loads; a module (the Trigger Editor a step opened for its JassHelper menu) stays open during a save.
 */
export function questionDialogs(unknown) {
  return unknown.filter((d) => d.title && d.title !== PROGRESS_TITLE && !isReopenedModule(d.title));
}

/**
 * What --map does: "start" when no editor is running, "open" (File > Open in the running editor, with a restart as the
 * fallback when that fails) when one is. `running`: an editor was started and hasn't exited.
 */
export function mapAction(running) {
  return running ? "open" : "start";
}

/**
 * What File > Open does with the dialogs it meets (`dialogs` without the file dialog and the loading window): the
 * question "Save changes?" (a message box titled "Warning") is answered "n" (No), or "y" with `save`; any other titled
 * dialog is an error of the open. Returns { answer: { dialog, key } } , { error: dialog } or {} for nothing to do.
 */
export function openQuestion(dialogs, save = false) {
  const open = questionDialogs(dialogs);
  const q = open.find((d) => d.title === "Warning");
  if (q) return { answer: { dialog: q, key: save ? "y" : "n" } };
  return open.length ? { error: open[0] } : {};
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
  const opts = { game: null, work: join(repo, "target", "we-drive"), timeout: 300, mode: "hd", dayNight: "fixed", saveAccept: [] };
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
    else if (a === "--timeout") opts.timeout = positiveNumber("--timeout", value());
    else if (a === "--mode") opts.mode = value();
    else if (a === "--save-accept") opts.saveAccept.push(...value().split(",").filter(Boolean));
    else if (a === "--screen") {
      const m = /^(\d+)x(\d+)$/.exec(value());
      if (!m) throw new Error("--screen wants WxH");
      opts.screen = [Number(m[1]), Number(m[2])];
    }
    else if (a === "--keyboard") {
      const layout = value();
      if (!/^[a-z]{2,8}(\([a-z0-9_]+\))?$/.test(layout)) throw new Error("--keyboard wants an X layout name like de or us");
      opts.keyboard = layout;
    }
    else if (a === "--keep-prefs") opts.keepPrefs = true;
    else if (a === "--pref") (opts.prefs ??= []).push(parsePref(value()));
    else if (a === "--expect-layout") opts.expectLayout = true;
    else if (a === "--day-night") { opts.dayNight = value(); dayNightGiven = true; }
    else if (VALUE_STEPS.has(a)) steps.push([a, value()]);
    else if (FLAG_STEPS.has(a)) steps.push([a, null]);
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument ${a} (see the top of we-drive.mjs)`);
  }
  if (opts.expectLayout && opts.screen && (opts.screen[0] !== SIZE[0] || opts.screen[1] !== SIZE[1])) throw new Error("--expect-layout checks the layout of the 1600x1000 display: leave out --screen");
  for (const [step, v] of steps) if (step === "--numlock" && !["on", "off", "status"].includes(v)) throw new Error("--numlock wants on, off or status");
  if (dayNightGiven && opts.dayNight === "cycle" && steps.some(([s]) => s === "--compare-ready")) {
    throw new Error("--compare-ready takes pictures with the day and night fixed: leave out --day-night cycle");
  }
  // --drag-mod belongs to the next --drag; each --drag is parsed (and refused) here.
  let pendingMod = null, pendingButton = null;
  for (let i = 0; i < steps.length; i++) {
    const [step, v] = steps[i];
    if (step === "--drag-button") {
      if (!["1", "2", "3"].includes(v)) throw new Error("--drag-button wants 1, 2 or 3");
      pendingButton = Number(v);
      steps.splice(i--, 1);
    } else if (step === "--drag-mod") {
      if (!DRAG_MODS.includes(v)) throw new Error(`--drag-mod wants ${DRAG_MODS.join(", ")}`);
      pendingMod = v;
      steps.splice(i--, 1);
    } else if (step === "--drag") {
      steps[i] = [step, { ...parseDrag(v), ...(pendingMod ? { mod: pendingMod } : {}), ...(pendingButton && pendingButton !== 1 ? { button: pendingButton } : {}) }];
      pendingMod = null;
      pendingButton = null;
    }
  }
  // A number that isn't one would wait forever (NaN never passes a deadline) or not at all.
  for (const [step, v] of steps) {
    if (step === "--sleep") positiveNumber("--sleep", v, { orEqual: true });
    else if (step === "--fps") positiveNumber("--fps", v);
  }
  if (pendingMod) throw new Error("--drag-mod needs a --drag after it");
  if (pendingButton) throw new Error("--drag-button needs a --drag after it");
  // Every look's camera goes into the map before the editor starts: parsed (and refused) here, numbered by order.
  const looks = steps.filter(([s]) => s === "--look").map(([, v]) => parseLook(v));
  if (looks.length > MAX_LOOKS) throw new Error(`at most ${MAX_LOOKS} --look steps in one run`);
  if (looks.length && steps.findIndex(([s]) => s === "--look") < steps.findIndex(([s]) => s === "--map")) {
    throw new Error("--look needs --map before it (its cameras go into the map)");
  }
  if (looks.length && !steps.some(([s]) => s === "--map")) throw new Error("--look needs --map (its cameras go into the map)");
  const firstOpen = steps.findIndex(([s]) => s === "--open"), firstStart = steps.findIndex(([s]) => s === "--map" || s === "--start");
  if (firstOpen >= 0 && (firstStart < 0 || firstStart > firstOpen)) throw new Error("--open needs --map or --start before it (it opens the map in the running editor)");
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

/**
 * Mesa's software Vulkan (lavapipe; the NVIDIA driver can't present into Xvfb): every lvp_icd*.json manifest in the
 * loader's folders, as distributions name it "lvp_icd.json" (Ubuntu) or per architecture ("lvp_icd.x86_64.json",
 * Debian 12, Fedora). All of them go to the loader, which takes the one of the editor's architecture. [] when none.
 */
export function lavapipeIcds(dirs = ICD_DIRS, list = (d) => readdirSync(d)) {
  const found = [];
  for (const d of dirs) {
    let names;
    try { names = list(d); } catch { continue; }
    for (const n of [...names].sort()) if (/^lvp_icd.*\.json$/.test(n)) found.push(posix.join(d, n));
  }
  return found;
}

/** Whether util-linux's setpriv is there (it is on every usual distribution). */
const hasSetpriv = () => spawnSync("setpriv", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * How Xvfb is started: through `setpriv --pdeathsig KILL`, which execs it in the same process (the pid we-drive
 * keeps is Xvfb's) with the kernel's death signal set, so a we-drive killed past its cleanup (SIGKILL) doesn't leave
 * the display behind. Without setpriv, plainly.
 */
export function xvfbCommand(args, setpriv = hasSetpriv()) {
  return setpriv ? ["setpriv", ["--pdeathsig", "KILL", "--", "Xvfb", ...args]] : ["Xvfb", args];
}

/** The sandbox's $XDG_CACHE_HOME: in the farm's prefix folder (writable there, shared by the runs like the prefix). */
export const sandboxCache = () => join(prefixDir(), "cache");

/** The Proton build's wineserver: `files/bin` (newer builds) or `dist/bin` (older ones, as protonFor accepts), or null. */
export function wineserverPath(tool, exists = existsSync) {
  for (const sub of ["files", "dist"]) {
    const p = posix.join(tool, sub, "bin", "wineserver");
    if (exists(p)) return p;
  }
  return null;
}

/** A Linux path as the Windows program sees it. */
/** The folder the editor's Open list shows: the prefix's Documents/Warcraft III/Maps. */
export const openMapsDir = () => join(prefixDir(), "pfx", "drive_c", "users", "steamuser", "Documents", "Warcraft III", "Maps");
/** The name of the n-th opened copy there: unique per open, so the editor's title says which map it shows. */
export const openCopyName = (n, map) => `we-open-${n}-${basename(map)}`;
export const winePath = (p) => `Z:${p.split("/").join("\\")}`;

/**
 * The text locale we-drive runs the editor in, from the install's .build.info tags ("enUS text?"): enUS, the only
 * one it can drive (it finds dialogs by their English titles: "Warning", "Reminder", "Save As", "Open Document",
 * "Progress", the View menu's rows). An install with enUS among its text locales gets enUS; one without (or no tag at
 * all) is refused with the locales it has, rather than run into dialogs it can't read.
 */
export function textLocale(buildInfo) {
  const have = [...new Set([...buildInfo.matchAll(/\b([a-z]{2}[A-Z]{2}) text\?/g)].map((m) => m[1]))];
  if (have.includes("enUS")) return "enUS";
  throw new Error(`we-drive needs the game's English text (enUS): it finds the editor's dialogs by their English titles, and this install has ${have.length ? have.join(", ") : "no text locale named in .build.info"}`);
}

function x11(display, ...args) {
  const r = spawnSync("python3", ["-I", HELPER, "--display", display, ...args.map(String)], { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) throw new Error(`we-x11 ${args[0]}: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

/** A process's state letter from /proc/PID/stat ("R", "S", "Z" a zombie, …), null when there's no such process, "?"
 *  when it couldn't be read for another reason (not taken as gone). */
export function procState(pid, read = (p) => readFileSync(p, "utf8")) {
  let stat;
  try { stat = read(`/proc/${pid}/stat`); } catch (e) { return e?.code === "ENOENT" || e?.code === "ESRCH" ? null : "?"; }
  // "PID (comm) S …": the name may hold spaces and parentheses, so the state follows the last ")".
  const m = /\)\s+(\S)/.exec(stat.slice(stat.lastIndexOf(")")));
  return m ? m[1] : null;
}

/** Whether a process is gone for good: no such process, or a zombie (dead, only not reaped yet). */
export const procGone = (pid, read) => { const s = procState(pid, read); return s === null || s === "Z" || s === "X"; };

/**
 * Waits for a child process's exit (its "exit" event, marked by the Session as child.exited), up to `ms`. Returns
 * true when it exited. The event comes only when the event loop turns, so this awaits instead of checking a flag.
 */
export async function waitExit(child, ms, clock = { now: Date.now, sleep }) {
  for (const end = clock.now() + ms; !child.exited; ) {
    if (clock.now() >= end) return false;
    await clock.sleep(50);
  }
  return true;
}

/** A number option's value: finite and above `min` (or at least it, with `orEqual`), else a clear error. */
export function positiveNumber(name, v, { orEqual = false, min = 0 } = {}) {
  const n = Number(v);
  if (typeof v !== "string" || v.trim() === "" || !Number.isFinite(n) || (orEqual ? n < min : n <= min)) {
    throw new Error(`${name} wants a number ${orEqual ? "of at least" : "above"} ${min}, not "${v}"`);
  }
  return n;
}

/** The Reforged switches of the editor's preferences, one per kind of asset. */
const ASSET_KINDS = ["Buildings", "Environment", "EnvOld", "Heroes", "Icons", "Textures", "Units", "Vfx"];

/**
 * The [Misc] keys we-drive sets in WorldEditPreferences.txt: no first-start questions, no interface sounds, the
 * graphics mode (`sd`, `hd` or `de`: assetMode 0, 1, 2 decides, hd and the per-kind switches follow; see TESTING.md),
 * and whether the editor's day and night turn (`cycle`) or stand still (`fixed`).
 */
export function editorPrefs(mode, dayNight, keep = false) {
  if (!["sd", "hd", "de"].includes(mode)) throw new Error("--mode wants sd, hd or de");
  if (dayNight !== "cycle" && dayNight !== "fixed") throw new Error("--day-night wants cycle or fixed");
  const on = mode === "sd" ? "0" : "1";
  const am = mode === "de" ? "2" : on;
  return {
    "Has Been Run": "true",
    "Editor User Interface Sound": "0",
    "Play Splash Sound": "0",
    assetMode: am,
    hd: on,
    ...Object.fromEntries(ASSET_KINDS.map((k) => [k, on])),
    "Fixed Day Night Cycle": dayNight === "fixed" ? "1" : "0",
    ...(keep ? {} : PINNED_PREFS),
  };
}

/**
 * The [Misc] toggles a spec may change and the editor persists (Enforce Water Limits, Enforce Camera Boundaries),
 * pinned to the editor's defaults before each start so a run doesn't depend on what the last one left. The editor
 * writes a switched-off Enforce Water Limits as "false", so the default is written as "true". The other View menu
 * toggles (Grid, Camera Bounds, pathing, ...) aren't kept in the preferences file: they start as the editor's own.
 * "Reset Fixed Z When Moving Objects" is the switch Ctrl+Shift+H toggles (unit-heights; seen 2026-11-17: false before,
 * true after one press, and kept by the next start when not pinned): pinned to false, what the farm's prefix held
 * through the runs the specs were written in. `--keep-prefs` leaves these as they are.
 */
export const PINNED_PREFS = Object.freeze({ "Enforce Water Limits": "true", "Enforce Camera Boundaries": "1", "Reset Fixed Z When Moving Objects": "false" });

/**
 * The [Minimap] toggle pinned the same way: the editor keeps the "Show Creep Camp Icon" box under the minimap as it
 * was left, so a spec's click on it ticked it in one run and unticked it in the next (the "first click doesn't take
 * half of the time" of TESTING.md: measured 2026-11-17, six runs alternating, the click took every time). Unticked,
 * as a fresh prefix starts. `--keep-prefs` leaves it as it is.
 */
export const PINNED_MINIMAP_PREFS = Object.freeze({ "Show Creep Camps": "false" });

/** The editor's preferences text with we-drive's keys set: [Misc] always, [Minimap] unless kept. */
export function withEditorPrefs(text, mode, dayNight, keep = false) {
  const misc = setPrefs(text, "Misc", editorPrefs(mode, dayNight, keep));
  return keep ? misc : setPrefs(misc, "Minimap", PINNED_MINIMAP_PREFS);
}

/** The preferences text with the --pref keys ([{ section, key, value }], parsePref) set over it, in their sections; a
 *  later --pref of the same key wins. Applied after we-drive's own keys, --keep-prefs or not. */
export function withExtraPrefs(text, prefs) {
  const bySection = new Map();
  for (const p of prefs) bySection.set(p.section, { ...(bySection.get(p.section) ?? {}), [p.key]: p.value });
  let out = text;
  for (const [section, values] of bySection) out = setPrefs(out, section, values);
  return out;
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

/** How long a killed or closed editor's processes get to go before the next start (bwrap's exit, wineserver -w). */
const EXIT_WAIT_MS = 20000;
/** A save that wrote nothing while no dialog was open for this long has failed (a refused or no-op save). */
const SAVE_IDLE_MS = 90000;
/** How long the locale's `reg` may take (a new prefix's first Wine start included; it took under 30 s). */
const LOCALE_MS = 120000;
/** --close types "n" into a dialog again only this long after the last time, and at most this often. */
const CLOSE_RETYPE_MS = 5000;
const CLOSE_TYPES = 3;
/** A saved file that stood still this long and still isn't a whole MPQ is reported, not copied. */
const SAVE_NOT_MPQ_MS = 10000;
/** How many dialog pictures of earlier runs stay in the work folder (pruneArtefacts). */
const KEEP_DIALOG_SHOTS = 20;

/**
 * Whether `buf` (a file's first bytes; `size` the whole file's) holds a whole MPQ archive as far as its header tells:
 * the header "MPQ\x1A" at a multiple of 512 (a map has its 512-byte HM3W header first), and the hash and block
 * tables it names inside the file. A file the editor is still writing fails this. (A sanity check of the save, not a
 * parser: the CLI and the app read the archive.)
 */
export function isWholeMpq(buf, size) {
  for (let off = 0; off + 32 <= buf.length; off += 512) {
    if (buf.readUInt32LE(off) !== 0x1a51504d) continue;
    const headerSize = buf.readUInt32LE(off + 4);
    if (headerSize < 32) return false;
    const hashPos = buf.readUInt32LE(off + 16), blockPos = buf.readUInt32LE(off + 20);
    const hashCount = buf.readUInt32LE(off + 24), blockCount = buf.readUInt32LE(off + 28);
    const room = size - off;
    return hashCount > 0 && hashPos + hashCount * 16 <= room && blockPos + blockCount * 16 <= room;
  }
  return false;
}

/** isWholeMpq of a file on disk (its first 1 MB read). */
export function fileIsWholeMpq(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const buf = Buffer.alloc(Math.min(size, 1 << 20));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return isWholeMpq(buf.subarray(0, n), size);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Clears what earlier runs left in the work folder: the exported minimaps' TGAs (copied to their destination
 * already) and all but the newest `keep` dialog pictures (the latest stay as evidence of a failed run, e.g. an earlier
 * mode of the same we-compare). Only we-drive's own file names; nothing else in the folder is touched.
 */
export function pruneArtefacts(work, keep = KEEP_DIALOG_SHOTS) {
  let names;
  try { names = readdirSync(work); } catch { return []; }
  const removed = [];
  const rm = (n) => { try { rmSync(join(work, n), { force: true }); removed.push(n); } catch { /* left */ } };
  for (const n of names) if (/^minimap-\d+\.tga$/.test(n)) rm(n);
  const shots = names.filter((n) => /^dialog-[a-z]+-\d+\.png$/.test(n))
    .map((n) => { try { return { n, t: statSync(join(work, n)).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t || b.n.localeCompare(a.n));
  for (const { n } of shots.slice(keep)) rm(n);
  return removed;
}

/**
 * One run's editor and display. `deps` replaces the outside world in the tests: `proton` (else protonFor), `x11`
 * (the helper: (args…) => its JSON), `spawnWine`, `wineserver`, `procGone`, and a clock { now, sleep }.
 */
export class Session {
  constructor(opts, game, deps = {}) {
    this.opts = opts;
    this.game = game;
    this.proton = deps.proton ?? protonFor(game);
    this.clock = deps.clock ?? { now: Date.now, sleep };
    if (deps.x11) this.x11Impl = deps.x11;
    if (deps.spawnWine) this.spawnWine = deps.spawnWine;
    if (deps.wineserver) this.wineserver = deps.wineserver;
    this.procGone = deps.procGone ?? procGone;
    this.display = null;
    this.xvfb = null;
    this.xvfbExited = false;
    this.editor = null;
    this.editorExited = false;
    this.mapName = null;
    this.startedAt = 0;
    this.clicked = new Map();
    this.log = join(opts.work, "editor.log");
  }

  now() { return this.clock.now(); }
  wait(ms) { return this.clock.sleep(ms); }

  /** Whether the run's Xvfb is gone (its exit event, or dead by /proc while the event loop hasn't turned yet). */
  xvfbDead() {
    if (this.xvfbExited) return true;
    return !!this.xvfb?.pid && this.procGone(this.xvfb.pid);
  }

  /** The X11 helper on the run's display. A dead Xvfb is said as such (the helper's guard would call the display
   *  "not an Xvfb"). */
  x(...args) {
    const died = (why) => new Error(`Xvfb died (display ${this.display}, ${this.xvfb.signalCode ?? `exit ${this.xvfb.exitCode}`}${why ? `; ${why}` : ""})`);
    if (this.xvfb && this.xvfbDead()) throw died();
    try {
      return this.x11Impl ? this.x11Impl(...args) : x11(this.display, ...args);
    } catch (e) {
      if (this.xvfb && this.xvfbDead()) throw died(e.message);
      throw e;
    }
  }

  async startDisplay() {
    const size = this.opts.screen ?? SIZE;
    const [cmd, args] = xvfbCommand(["-displayfd", "3", "-screen", "0", `${size[0]}x${size[1]}x24`, "-nolisten", "tcp"]);
    const xvfb = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    this.xvfb = xvfb;
    xvfb.on("exit", () => { this.xvfbExited = true; });
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
    // Another keyboard layout, before the editor starts (Wine reads it then): `--key` names keysyms, so with "de" the
    // key named z is the one US keyboards call Y.
    if (this.opts.keyboard) {
      const r = spawnSync("setxkbmap", ["-display", this.display, this.opts.keyboard], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`setxkbmap ${this.opts.keyboard} failed: ${r.stderr || r.error?.message || r.status}`);
    }
  }

  /** The folders the editor's processes may write (everything else of the machine is mounted read-only): the farm
   *  (its copied CASC indices, shmem and ecache; its hardlinks are mounted read-only again after it), the farm's Wine
   *  prefix, the run's work folder (the map copies the editor saves over, the minimap it exports), the runtime dir
   *  (sockets) and /tmp (wineserver's socket in /tmp/.wine-<uid>, the X server's socket). */
  writableDirs() {
    const run = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
    return [...new Set([farmDir(), prefixDir(), resolve(this.opts.work), run, "/tmp"])].filter((p) => existsSync(p));
  }

  /** The environment and the sandbox the editor's processes run in. */
  sandboxed(program, args) {
    const user = userCompatData(this.game);
    const run = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
    const ro = [user, ...linkedFiles()];
    const fdArgs = Buffer.from(ro.flatMap((p) => ["--ro-bind", p, p]).map((s) => `${s}\0`).join(""));
    // The whole machine read-only (Wine's Z: drive is /), then only what the editor must write.
    const bw = ["--ro-bind", "/", "/"];
    for (const p of this.writableDirs()) bw.push("--bind", p, p);
    bw.push("--dev-bind", "/dev", "/dev", "--proc", "/proc",
      // No sound: no ALSA devices, no PulseAudio or PipeWire sockets.
      "--tmpfs", "/dev/snd",
      // No network: nothing of this machine (a crash report included) can leave it. The editor works offline.
      "--unshare-net",
      // When we-drive dies (SIGKILL, OOM) its Proton goes with it; the editor's Wine processes that outlive it are
      // killed by the next run's `wineserver -k` (start()). Not --unshare-pid: the crash check reads /proc/<pid>.
      "--die-with-parent");
    for (const p of ["pulse"]) if (existsSync(join(run, p))) bw.push("--tmpfs", join(run, p));
    for (const p of ["pipewire-0", "pipewire-0-manager"]) if (existsSync(join(run, p))) bw.push("--ro-bind", "/dev/null", join(run, p));
    bw.push("--args", "3", join(this.proton.tool, "proton"), "run", program, ...args);
    const env = { ...process.env };
    delete env.PIPEWIRE_REMOTE;
    // Never the desktop: the editor opens on its own Xvfb or not at all.
    delete env.WAYLAND_DISPLAY;
    delete env.XAUTHORITY;
    if (!this.display || !/^:\d+$/.test(this.display)) throw new Error("we-drive: no Xvfb display of its own, refusing to start the editor");
    Object.assign(env, {
      DISPLAY: this.display,
      STEAM_COMPAT_DATA_PATH: prefixDir(),
      STEAM_COMPAT_CLIENT_INSTALL_PATH: this.proton.steamRoot,
      SteamAppId: this.proton.appId,
      SteamGameId: this.proton.appId,
      VK_ICD_FILENAMES: lavapipeIcds().join(":"),
      VK_DRIVER_FILES: lavapipeIcds().join(":"),
      WINEDEBUG: "-all",
      // English system dialogs whatever the user's language, so their buttons' keys are known ("n" is No).
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      WINEDLLOVERRIDES: ["winepulse.drv=d", "winealsa.drv=d", "wineoss.drv=d", process.env.WINEDLLOVERRIDES].filter(Boolean).join(";"),
      PULSE_SERVER: "unix:/nonexistent",
      PIPEWIRE_RUNTIME_DIR: "/nonexistent",
      LD_PRELOAD: shimPath(),
      // The home folder is read-only in the sandbox: caches go into the farm's prefix folder. Proton-GE's protonfixes
      // dies at start when it can't append to its log in $XDG_CACHE_HOME/protonfixes (seen 2026-11-17); Mesa's shader
      // and fontconfig's caches go there too.
      XDG_CACHE_HOME: sandboxCache(),
    });
    return { bw, env, fdArgs };
  }

  spawnWine(program, args) {
    mkdirSync(this.opts.work, { recursive: true });
    mkdirSync(sandboxCache(), { recursive: true });
    const { bw, env, fdArgs } = this.sandboxed(program, args);
    // One log per run: the first program of the session starts it afresh, the later ones (the editor after the
    // locale's reg, another map's editor) add to it.
    const out = openSync(this.log, this.logStarted ? "a" : "w");
    this.logStarted = true;
    const child = spawn("bwrap", bw, { cwd: join(farmDir(), "_retail_", "x86_64"), env, stdio: ["ignore", out, out, "pipe"], detached: true });
    closeSync(out);
    // A spawn that fails (no bwrap, EAGAIN) is an "error" event: without a listener it would end we-drive on the spot,
    // past its cleanup. Marked on the child; the callers' waits see it as an exit.
    child.on("error", (e) => { child.spawnError = e; child.exited = true; });
    child.stdio[3].on("error", () => { /* bwrap gone before reading its arguments: its exit or error says why */ });
    child.stdio[3].end(fdArgs);
    return child;
  }

  /** Runs the prefix's wineserver with `args` ("-k" kills its processes, "-w" waits until they're gone), at most
   *  `ms`; a failure (the time up) is tolerated: what's left is reported by tests/wineservers.mjs. A Proton build
   *  without a wineserver is refused before the run starts (main). */
  wineserver(args, ms = 60000) {
    const bin = wineserverPath(this.proton.tool);
    if (!bin) return { error: new Error(`no wineserver in ${this.proton.tool}`) };
    try {
      return spawnSync(bin, args, { env: { ...process.env, WINEPREFIX: join(prefixDir(), "pfx") }, stdio: "ignore", timeout: ms });
    } catch (e) {
      return { error: e };
    }
  }

  /** Kills a program of the prefix that doesn't finish (the locale's reg): the prefix's processes, its process
   *  group, and waits (bounded) until they're gone. */
  killPrefix(child) {
    this.wineserver(["-k"], EXIT_WAIT_MS);
    if (child?.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    this.wineserver(["-w"], EXIT_WAIT_MS);
  }

  /** The install's text locale in the prefix's registry, where the launcher would put it (else the editor
   *  falls back to the system's language, which the install may not have, and shows WESTRING_… names). */
  async ensureLocale() {
    const reg = join(prefixDir(), "pfx", "user.reg");
    const locale = textLocale(readFileSync(join(this.game, ".build.info"), "utf8"));
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
    let code = null;
    child.on("exit", (c) => { code = c; child.exited = true; });
    child.on("error", (e) => { child.spawnError = e; child.exited = true; });
    // Bounded: it runs under the machine-wide lock, and a Wine that hangs (a stale wineserver) must not hold it forever.
    if (!(await waitExit(child, LOCALE_MS, this.clock))) {
      this.killPrefix(child);
      throw new Error(`couldn't set the editor's locale in the prefix: reg didn't finish within ${LOCALE_MS / 1000} s (killed; see ${this.log})`);
    }
    if (child.spawnError) throw new Error(`couldn't set the editor's locale in the prefix: ${child.spawnError.message}`);
    this.wineserver(["-w"], EXIT_WAIT_MS);
    if (code !== 0 || !has()) throw new Error(`couldn't set the editor's locale in the prefix (reg exited ${code}; see ${this.log})`);
  }

  /** The editor's preferences in the prefix, before each start: the keys we-drive needs set, the rest as the editor
   *  left it (a first start writes the whole file). */
  writePrefs() {
    const dir = join(prefixDir(), "pfx", "drive_c", "users", "steamuser", "Documents", "Warcraft III");
    const file = join(dir, "WorldEditPreferences.txt");
    mkdirSync(dir, { recursive: true });
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const after = withExtraPrefs(withEditorPrefs(before, this.opts.mode, this.opts.dayNight, !!this.opts.keepPrefs), this.opts.prefs ?? []);
    if (after !== before) writeFileSync(file, after);
  }

  /** An editor was started and hasn't exited. */
  running() {
    return !!this.editor && !this.editorExited;
  }

  /** Starts the editor, with a copy of `map` if given; `looks` are the run's --look cameras to put into the copy. */
  async start(map, looks = []) {
    if (this.editor) {
      // The editor before (closed or killed) must be gone: its exit event comes only when the event loop turns, and
      // its processes must not still hold the prefix when the next one starts.
      if (!(await waitExit(this.editor, EXIT_WAIT_MS, this.clock))) {
        if (!this.editorExited) throw new Error("the editor is still running: add --close before another --map");
        throw new Error(`the editor before didn't exit within ${EXIT_WAIT_MS / 1000} s of its close (see ${this.log})`);
      }
    }
    // A wineserver of the prefix still running now is a stale one (we-drive holds the machine-wide lock): a run before
    // that was killed past its cleanup (SIGKILL, OOM). The next Wine program would join it.
    this.wineserver(["-k"], EXIT_WAIT_MS);
    this.wineserver(["-w"], EXIT_WAIT_MS);
    // Another map after a --close: a run starts the editor once per --map, on the same display (we-compare.mjs).
    this.editor = null;
    this.editorExited = false;
    this.answered = [];
    this.clicked = new Map();
    this.copy = null;
    this.mapName = null;
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
    this.startedAt = this.now();
    const child = this.spawnWine(exe, args);
    child.exited = false;
    this.editor = child;
    // Only this child's own exit counts: an editor before it may report its exit late (after this start), and must
    // not mark this one as exited.
    const gone = () => {
      child.exited = true;
      if (this.editor === child) this.editorExited = true;
    };
    child.on("exit", gone);
    // A spawn that failed never exits: its error ends the editor the same way (the steps then say it exited).
    child.on("error", gone);
    if (child.spawnError) gone();
  }

  /** The editor's windows. If one is the crash-report dialog, the editor and its prefix's processes (the reporter
   *  included) are killed without touching it and EditorCrashed is thrown. Every step reads windows through here. */
  windows() {
    const all = this.x("windows").windows;
    const crash = crashDialogs(all, programOfPid);
    if (crash.length) this.crashed(crash.map((w) => ({ title: w.title, class: w.class, program: programOfPid(w) })));
    return classify(all);
  }

  /** A pointer action (click, drag, move) of a step: the window list is read first, so a crash dialog that came up
   *  since the last step is found (and the editor killed) before anything could click into it. */
  act(cmd, ...args) {
    this.windows();
    return this.x(cmd, ...args);
  }

  /** --sleep: waits `ms`, reading the window list every second meanwhile once an editor was started, so a crash
   *  dialog is handled when it comes (EditorCrashed) rather than at the next step. */
  async sleepWatching(ms) {
    for (const end = this.now() + ms; ;) {
      const left = end - this.now();
      if (left <= 0) return;
      await this.wait(Math.min(1000, left));
      if (this.editor) this.windows();
    }
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

  /** Kills everything the editor started (its crash reporter too) instead of answering anything, and waits (bounded)
   *  until the prefix's processes are gone, so a next start doesn't meet a dying wineserver or the old editor writing
   *  its preferences. Synchronous (a crash is handled inside windows()); start() awaits the child's exit event. */
  killEditor() {
    this.wineserver(["-k"], EXIT_WAIT_MS);
    if (this.editor?.pid) try { process.kill(-this.editor.pid, "SIGKILL"); } catch { /* gone */ }
    this.wineserver(["-w"], EXIT_WAIT_MS);
    this.editorExited = true;
  }

  viewRect(main) {
    const [x, y, w, h] = main.rect;
    return [x + VIEW_INSET.x, y + VIEW_INSET.y, w - VIEW_INSET.w, h - VIEW_INSET.h];
  }

  shot(file, rect) {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    return this.x("shot", resolve(file), ...(rect ? ["--rect", rect.join(",")] : []));
  }

  /** Answers the dialogs we-drive knows (the first start's welcome); returns the ones it doesn't. */
  answerKnown(dialogs, main = null) {
    const rest = [];
    this.clicked ??= new Map();
    for (const d of dialogs) {
      // The welcome asks to accept Blizzard's terms. The user accepted them in their own install, which the farm is made
      // from, and said on 2026-11-08 that we-drive may accept them in its own prefix. W3PROJ_WE_ACCEPT_TERMS=0 makes it
      // report the dialog instead, like any dialog we-drive doesn't know.
      if (d.title === WELCOME.title && process.env.W3PROJ_WE_ACCEPT_TERMS !== "0") {
        // Once, then again only if it's still there 15 s later (it stays until the editor has loaded the map).
        if (this.now() - (this.clicked.get(d.id) ?? 0) > 15000) {
          this.x("click", `${d.rect[0] + WELCOME.button.x},${d.rect[1] + WELCOME.button.y}`);
          this.clicked.set(d.id, this.now());
          this.answered = [...(this.answered ?? []), d.title];
        }
      } else if (isReopenedModule(d.title)) {
        // A module window the editor opens again because a run before closed the editor with it open (the farm's
        // prefix is shared): closed, and again every 3 s while it stays (a close that comes before the editor has
        // drawn it is lost), so the map's view is what's shown. waitReady counts it as not ready.
        if (this.now() - (this.clicked.get(d.id) ?? -Infinity) > MODULE_RECLOSE_MS) {
          this.x("close", d.id);
          // A module the editor restored at its start (the Trigger or the Object Editor, the one that was open when a
          // run before ended) may ignore the close for as long as the editor runs: then the main window is raised over
          // it, which uncovers the view (checked 2026-11-17: the window stays mapped under the raised main window).
          if (main) this.x("focus", main.id);
          if (!this.clicked.has(d.id)) this.answered = [...(this.answered ?? []), d.title];
          this.clicked.set(d.id, this.now());
        }
      } else rest.push(d);
    }
    return rest;
  }

  dialogShot(name) {
    const file = join(this.opts.work, `dialog-${name}-${this.now()}.png`);
    this.shot(file);
    return file;
  }

  /**
   * Opens `map` in the running editor, as File > Open: Ctrl+O shows the editor's own "Open Document" list (no file name
   * box: its Directory field is read-only and Browse is a folder tree), which lists the prefix's Documents/Warcraft III/Maps.
   * So a copy of the map goes there under a name of its own (the copies of earlier opens are removed first: the new one is the
   * list's only row), its row is clicked and OK pressed. A "Save changes?" question about the map before (a "Warning") is
   * answered "No": --save before --open keeps that map's changes. Returns when the editor has begun to load the map
   * (its loading window, a new title, or 8 s after the list closed); --wait-ready waits for the rest. Throws when the
   * list doesn't open or another dialog stays: --map then restarts the editor instead.
   */
  async openMap(map, looks = []) {
    if (!this.editor || this.editorExited) throw new Error("the editor isn't running");
    this.opens = (this.opens ?? 0) + 1;
    const dir = openMapsDir();
    mkdirSync(dir, { recursive: true });
    // The editor's save leaves a folder beside a copy ("we-open-3-input.w3xTemp"): removed too (rm without recursive
    // refused it with EISDIR, and every open of the run fell back to a restart).
    for (const f of readdirSync(dir)) if (/^we-open-/.test(f)) rmSync(join(dir, f), { recursive: true, force: true });
    const copy = join(dir, openCopyName(this.opens, map));
    copyFileSync(map, copy);
    const withLooks = looks.length ? addCamerasToMap(ensureCli(), copy, join(this.opts.work, "look-project"), looks) : null;
    const { main } = this.mainOrThrow();
    const beforeTitle = main.title;
    const before = new Set(this.windows().dialogs.map((d) => d.id));
    this.x("key", "--window", main.id, "ctrl+o");
    const answered = [], asked = new Set();
    let dialog = null;
    for (const end = this.now() + 20000; !dialog && this.now() < end;) {
      await this.wait(250);
      if (this.editorExited) throw new Error(`the editor exited (see ${this.log})`);
      const fresh = this.windows().dialogs.filter((d) => !before.has(d.id));
      dialog = fresh.find((d) => d.title === OPEN_DIALOG) ?? null;
      const r = openQuestion(fresh.filter((d) => d !== dialog), false);
      if (r.answer && !asked.has(r.answer.dialog.id)) {
        this.x("key", "--window", r.answer.dialog.id, r.answer.key);
        asked.add(r.answer.dialog.id);
        answered.push(r.answer.dialog.title);
      } else if (r.error) throw new Error(`Ctrl+O met a dialog: "${r.error.title}"`);
    }
    if (!dialog) throw new Error(`no "${OPEN_DIALOG}" list opened for Ctrl+O`);
    await this.wait(500);
    const at = (p) => `${dialog.rect[0] + p.x},${dialog.rect[1] + p.y}`;
    this.x("click", at(OPEN_LIST.row));
    await this.wait(300);
    this.x("click", at(OPEN_LIST.ok));
    let loading = false, closedAt = 0;
    for (const end = this.now() + 40000; this.now() < end;) {
      await this.wait(250);
      if (this.editorExited) throw new Error(`the editor exited while opening (see ${this.log})`);
      const w = this.windows();
      if (w.dialogs.some((d) => d.title === PROGRESS_TITLE)) loading = true;
      const r = openQuestion(w.dialogs.filter((d) => d.id !== dialog.id), false);
      if (r.answer && !asked.has(r.answer.dialog.id)) {
        this.x("key", "--window", r.answer.dialog.id, r.answer.key);
        asked.add(r.answer.dialog.id);
        answered.push(r.answer.dialog.title);
        continue;
      }
      if (r.error || r.answer) throw new Error(`the open met a dialog: "${(r.error ?? r.answer.dialog).title}"`);
      if (w.dialogs.some((d) => d.id === dialog.id)) continue;
      closedAt ||= this.now();
      if (loading || (w.main && w.main.title !== beforeTitle) || this.now() - closedAt > 8000) {
        this.copy = copy;
        this.mapName = basename(copy);
        this.answered = answered;
        this.startedAt = this.now();
        if (withLooks) ({ looks: this.looks, parks: this.parks } = withLooks);
        return { answered, loading, copy };
      }
    }
    throw new Error(`the "${OPEN_DIALOG}" list stayed open`);
  }

  async waitReady() {
    if (!this.editor) throw new Error("the editor isn't running: add --map or --start first");
    const deadline = this.now() + this.opts.timeout * 1000;
    let readySince = 0, dialogSince = 0, mainAt = null, progressPolls = 0, moduleSince = 0;
    for (;;) {
      if (this.editorExited) throw new Error(`the editor exited while starting (see ${this.log})`);
      const { main, dialogs, palettes } = this.windows();
      if (main && !mainAt) mainAt = this.now() - this.startedAt;
      const unknown = this.answerKnown(dialogs, main);
      if (dialogs.some((d) => isReopenedModule(d.title))) moduleSince ||= this.now();
      else moduleSince = 0;
      // A loading window (no title, or "Progress") comes and goes while the map loads; a titled dialog that stays is
      // a question. While one is open the map isn't ready (below), so a long load waits up to the timeout.
      const questions = questionDialogs(unknown);
      // How long the loading window was seen (polls of 0.5 s and more), for the report.
      if (unknown.some((d) => d.title === PROGRESS_TITLE)) progressPolls++;
      if (questions.length) {
        dialogSince ||= this.now();
        if (this.now() - dialogSince > 3000) {
          return { ready: false, dialogs: questions.map((d) => ({ title: d.title, rect: d.rect })), screen: this.dialogShot("wait") };
        }
      } else dialogSince = 0;
      // The map's own name in the title: right after an open the title still names the map before.
      const titled = main && (!this.mapName || (main.title.includes("[") && main.title.includes(this.mapName)));
      let drawn = false;
      // A module window the editor opened again covers the view (a grey picture that isn't black): not ready until
      // it's gone (answerKnown closes it, again every few seconds).
      // One that ignores the close (MODULE_STUCK_MS) is under the raised main window: the picture says whether it still covers.
      const moduleStuck = moduleSince > 0 && this.now() - moduleSince > MODULE_STUCK_MS;
      if (titled && !unknown.length && (moduleSince === 0 || moduleStuck)) {
        // The middle of the view (counting the whole of it in Python takes seconds).
        const [vx, vy, vw, vh] = this.viewRect(main);
        const s = this.x("stats", "--rect", [vx + Math.round(vw / 2) - 150, vy + Math.round(vh / 2) - 100, 300, 200].join(","));
        // Black until the view has drawn (dark ground, like Lordaeron's grass at night, isn't black).
        drawn = s.blackPixels < s.pixels * 0.5 && !(moduleStuck && s.mean.every((c) => c >= 235));
      }
      if (drawn) {
        readySince ||= this.now();
        if (this.now() - readySince > 3000) {
          // --expect-layout: a main window or palette elsewhere than where the clicks were measured stops the run.
          if (this.opts.expectLayout) {
            const layout = layoutProblem(main, palettes);
            if (layout) return { ready: false, layout, main: main.rect, palettes: palettes.map((p) => ({ title: p.title, rect: p.rect })), screen: this.dialogShot("layout") };
          }
          return { ready: true, title: main.title, mainWindowMs: mainAt, readyMs: this.now() - this.startedAt, view: this.viewRect(main), answered: this.answered ?? [], progressPolls };
        }
      } else readySince = 0;
      if (this.now() > deadline) {
        return { ready: false, timeout: this.opts.timeout, title: main?.title ?? null, dialogs: unknown.map((d) => ({ title: d.title, rect: d.rect })), screen: this.dialogShot("timeout") };
      }
      await this.wait(500);
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
    this.x("key", "--window", main.id, "ctrl+s");
    // waitedFor: the windows the save waited out (the "Progress" window, an untitled one), for the step's line.
    const deadline = this.now() + this.opts.timeout * 1000, answered = [], asked = new Map(), waitedFor = new Set();
    let last = before, stillSince = 0, idleSince = this.now();
    while (this.now() < deadline) {
      await this.wait(500);
      if (this.editorExited) throw new Error(`the editor exited while saving (see ${this.log})`);
      const { dialogs } = this.windows();
      // A module window the run opened itself (the Sound Editor, F5) stays beside the map: not a question.
      const questions = questionDialogs(dialogs).filter((d) => !isReopenedModule(d.title));
      // The reminder about the default map name, and any dialog --save-accept names (e.g. "Warning", the "no longer
      // considered a melee map" notice): answered with Return, once per dialog (a dialog still there 10 s after its
      // Return didn't take it and is reported).
      const reminder = questions.find((d) => d.title === "Reminder" || this.opts.saveAccept.includes(d.title));
      if (reminder && !asked.has(reminder.id)) {
        this.x("key", "--window", reminder.id, "Return");
        asked.set(reminder.id, this.now());
        answered.push(reminder.title);
        stillSince = 0;
        idleSince = this.now();
        continue;
      }
      const stuck = questions.filter((d) => !asked.has(d.id) || this.now() - asked.get(d.id) > 10000);
      if (stuck.length) return { saved: false, dialogs: stuck.map((d) => ({ title: d.title, rect: d.rect })), screen: this.dialogShot("save") };
      const now = stamp();
      if (now !== last) { last = now; stillSince = 0; idleSince = this.now(); continue; }
      // Any window besides the main one and the run's modules (a question being answered, the "Progress" window, an
      // untitled one) means the editor is still at it: the file standing still meanwhile doesn't make it done.
      const busy = dialogs.filter((d) => !isReopenedModule(d.title));
      for (const d of busy) waitedFor.add(d.title || "(untitled)");
      if (busy.length) { idleSince = this.now(); stillSince = 0; continue; }
      if (now === before && this.now() - idleSince > SAVE_IDLE_MS) {
        return { saved: false, error: `the editor wrote nothing in ${SAVE_IDLE_MS / 1000} s without a dialog open (a refused or no-op save)`, answered, screen: this.dialogShot("save") };
      }
      if (now !== before && now !== null) {
        stillSince ||= this.now();
        if (this.now() - stillSince >= 2000) {
          // A file that stands still but isn't a whole archive yet is waited for a while, then reported.
          if (!fileIsWholeMpq(this.copy)) {
            if (this.now() - stillSince < SAVE_NOT_MPQ_MS) continue;
            return { saved: false, error: `what the editor wrote stood still for ${SAVE_NOT_MPQ_MS / 1000} s and isn't a whole MPQ archive`, answered, screen: this.dialogShot("save") };
          }
          mkdirSync(dirname(resolve(dest)), { recursive: true });
          copyFileSync(this.copy, resolve(dest));
          return { saved: true, file: resolve(dest), bytes: statSync(this.copy).size, answered, waitedFor: [...waitedFor] };
        }
      }
    }
    return { saved: false, timeout: this.opts.timeout, screen: this.dialogShot("save") };
  }

  /**
   * File > Export Minimap… with the dialog's defaults: Image File names a file in the work folder (typed into the
   * "Save As" box), OK writes it, and the TGA is copied to `dest`. Done when the file stood still for 2 s and the
   * dialog has closed; another dialog is reported with a picture of the screen, not answered.
   */
  async exportMinimap(dest) {
    const { main } = this.mainOrThrow();
    const waitFor = async (title) => {
      for (let i = 0; i < 40; i++) {
        await this.wait(250);
        const d = this.windows().dialogs.find((w) => w.title === title);
        if (d) return d;
      }
      return null;
    };
    const at = (rect, p) => `${rect[0] + p.x},${rect[1] + p.y}`;
    this.x("click", at(main.rect, EXPORT_MINIMAP.file));
    await this.wait(600);
    this.x("click", at(main.rect, EXPORT_MINIMAP.item));
    const dialog = await waitFor("Export Minimap");
    if (!dialog) return { exported: false, error: "the Export Minimap dialog didn't open", screen: this.dialogShot("export") };
    this.x("click", at(dialog.rect, EXPORT_MINIMAP.imageFile));
    const saveAs = await waitFor("Save As");
    if (!saveAs) return { exported: false, error: "the Save As box didn't open", screen: this.dialogShot("export") };
    const file = join(resolve(this.opts.work), `minimap-${this.now()}.tga`);
    await this.wait(300);
    this.x("type", "--window", saveAs.id, winePath(file));
    this.x("key", "--window", saveAs.id, "Return");
    for (let i = 0; i < 20 && this.windows().dialogs.some((w) => w.title === "Save As"); i++) await this.wait(250);
    this.x("click", at(dialog.rect, EXPORT_MINIMAP.ok));
    const deadline = this.now() + this.opts.timeout * 1000;
    let last = null, stillSince = 0;
    while (this.now() < deadline) {
      await this.wait(500);
      if (this.editorExited) throw new Error(`the editor exited while exporting (see ${this.log})`);
      const others = questionDialogs(this.windows().dialogs).filter((d) => d.title !== "Export Minimap");
      if (others.length) return { exported: false, dialogs: others.map((d) => ({ title: d.title, rect: d.rect })), screen: this.dialogShot("export") };
      let now = null;
      try { const s = statSync(file); now = `${s.mtimeMs}:${s.size}`; } catch { /* not yet */ }
      if (now !== last) { last = now; stillSince = 0; continue; }
      if (now && !this.windows().dialogs.some((d) => d.title === "Export Minimap")) {
        stillSince ||= this.now();
        if (this.now() - stillSince >= 2000) {
          mkdirSync(dirname(resolve(dest)), { recursive: true });
          copyFileSync(file, resolve(dest));
          const bytes = statSync(file).size;
          // The work folder's TGA was only the editor's place to write: it doesn't pile up over runs.
          rmSync(file, { force: true });
          return { exported: true, file: resolve(dest), bytes };
        }
      }
    }
    return { exported: false, timeout: this.opts.timeout, screen: this.dialogShot("export") };
  }

  mainOrThrow() {
    const w = this.windows();
    if (!w.main) throw new Error("no main window of the editor");
    return w;
  }

  /** Opens the View menu; returns its window. */
  async openViewMenu() {
    const { main } = this.mainOrThrow();
    this.x("click", `${main.rect[0] + VIEW_MENU.x},${main.rect[1] + VIEW_MENU.y}`);
    let menu = null;
    for (let i = 0; i < 20 && !menu; i++) {
      await this.wait(150);
      menu = this.windows().menus.find((m) => m.rect[3] > 300) ?? null;
    }
    if (!menu) throw new Error("the View menu didn't open");
    await this.wait(200);
    return menu;
  }

  async closeMenu() {
    this.x("key", "Escape");
    this.x("key", "Escape");
    await this.wait(200);
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
      this.x("click", `${menu.rect[0] + 60},${menu.rect[1] + spec.y}`);
      clicks++;
      // Until the view has drawn the change: two pictures of it a frame apart the same (about 2 frames a second in
      // HD, 14 in SD), at most 10 s; then the menu is read again.
      const { main } = this.mainOrThrow();
      const hd = this.opts.mode !== "sd";
      await this.wait(300);
      this.x("settle", "--rect", this.viewRect(main).join(","), "--interval", hd ? 1000 : 200, "--timeout", 10000);
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
      this.x("key", "v");
      await this.wait(500);
      st = await this.gameViewState();
      presses.push(st.on ? "on" : "off");
    }
    // The user's test: "Game View Settings" in pinkish red in the view's top-right corner.
    const { main } = this.windows();
    const [vx, vy, vw] = this.viewRect(main);
    const corner = this.x("stats", "--rect", [vx + vw - 260, vy, 260, 40].join(","));
    return { gameView: st.on ? "on" : "off", pressedV: presses.length, checkDarkPixels: st.checkDarkPixels, cornerRedPixels: corner.redPixels };
  }

  /** Shows the camera of look `i` (row i of the camera palette): camera layer, its row, View Selected Camera. */
  async look(i) {
    const look = this.looks?.[i];
    if (!look) throw new Error(`no camera for look ${i + 1} in the map (was it started with --map?)`);
    const { main } = this.mainOrThrow();
    this.x("key", "--window", main.id, "m");
    await this.wait(500);
    const palette = this.windows().palettes.find((p) => p.rect[0] > main.rect[0] + main.rect[2] / 2);
    if (!palette) throw new Error("no tool palette right of the main window");
    const [px, py] = palette.rect;
    const row = (r) => this.x("click", `${px + CAMERA_PALETTE.row.x},${py + CAMERA_PALETTE.row.y + r * CAMERA_PALETTE.rowHeight}`);
    row(i);
    await this.wait(300);
    this.x("click", `${px + CAMERA_PALETTE.view.x},${py + CAMERA_PALETTE.view.y}`);
    // The selected camera's circle is in the middle of the picture: selecting the parking camera farther away (only
    // selected, not viewed) moves it out.
    let parked = null;
    if (this.parks?.length) {
      await this.wait(300);
      parked = fartherPark(look, this.parks);
      row(this.looks.length + parked);
    }
    // The view draws about 14 frames a second in SD and 2 in HD: after a first wait, until two pictures of the view in
    // a row (a frame's time apart) are the same, at most 10 s (a turning day never stands still).
    const hd = this.opts.mode !== "sd";
    await this.wait(hd ? 1000 : 300);
    const still = this.x("settle", "--rect", this.viewRect(main).join(","), "--interval", hd ? 1000 : 200, "--timeout", 10000);
    let studio = null;
    try { studio = studioCamera(look); } catch { /* not fitted for this angle or field of view */ }
    const camera = studio && Object.entries(studio).map(([k, v]) => `${k}=${v}`).join(",");
    const selected = parked === null ? null : [this.parks[parked].x, this.parks[parked].y];
    return { row: i, look: { x: look.x, y: look.y, distance: look.distance, aoa: look.aoa, fov: look.fov, rotation: look.rotation }, studioCamera: camera, selectedParkingCamera: selected, viewSettled: still.settled, settledMs: still.ms };
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
    if (main) this.x("close", main.id);
    const deadline = this.now() + Math.min(this.opts.timeout, 120) * 1000;
    // The dialogs "n" was typed into, per window: again only after 5 s (a key that didn't take), at most 3 times; one
    // that stays then is left alone up to the deadline, not typed into every half second.
    const typed = new Map();
    while (this.now() < deadline) {
      await this.wait(500);
      const w = this.windows();
      if (!w.main && !w.dialogs.length && !w.palettes.length) {
        // The windows are gone; the processes follow. Waited for (bounded): the prefix's wineserver, then the
        // editor's own exit event, so the next start neither meets them nor takes their late exit for its own.
        this.wineserver(["-w"], EXIT_WAIT_MS);
        const exited = await waitExit(this.editor, EXIT_WAIT_MS, this.clock);
        if (!exited) this.killEditor();
        this.editorExited = true;
        return { closed: true, answered, ...(exited ? {} : { killed: "the editor's processes stayed after its windows closed" }) };
      }
      for (const d of w.dialogs) {
        // "Save changes to …?" is a message box titled "Warning" (Yes, No, Cancel): "n" is its "No".
        const action = closeAction(d, w.main);
        if (action === "crash") this.crashed([{ title: d.title, class: d.class, program: programOfPid(d) }]);
        if (action === "no") {
          const t = typed.get(d.id);
          if (t && (t.count >= CLOSE_TYPES || this.now() - t.at < CLOSE_RETYPE_MS)) continue;
          this.x("key", "--window", d.id, "n");
          typed.set(d.id, { at: this.now(), count: (t?.count ?? 0) + 1 });
          if (!t) answered.push(d.title || "(untitled)");
        } else {
          return { closed: false, dialogs: [{ title: d.title, rect: d.rect }], screen: this.dialogShot("close") };
        }
      }
    }
    return { closed: false, timeout: true, screen: this.dialogShot("close") };
  }

  /** Stops whatever the run started. The prefix's wineserver is killed whether or not an editor was started (the
   *  locale's `reg` starts one before), at most 20 s and failures tolerated. Synchronous: it runs from signal handlers. */
  stop() {
    this.wineserver(["-k"], EXIT_WAIT_MS);
    if (this.editor?.pid) try { process.kill(-this.editor.pid, "SIGKILL"); } catch { /* gone */ }
    if (this.xvfb && !this.xvfbExited && this.xvfb.exitCode === null && this.xvfb.signalCode === null) {
      try { this.xvfb.kill("SIGTERM"); } catch { /* gone */ }
      // Waited for (synchronously): gone within 5 s, else killed. A zombie counts as gone (node reaps it only when the
      // event loop turns, which this loop doesn't let happen).
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        if (this.procGone(this.xvfb.pid)) return;
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
  if (!why && !lavapipeIcds().length) why = `no lavapipe Vulkan driver (lvp_icd*.json in ${ICD_DIRS.join(" or ")}; Debian/Ubuntu: mesa-vulkan-drivers)`;
  if (!why) {
    try {
      const { tool } = protonFor(game);
      if (!wineserverPath(tool)) why = `the Proton build ${tool} has no wineserver (files/bin or dist/bin)`;
    } catch (e) { why = e.message; }
  }
  if (why) {
    out({ skipped: why });
    console.error(`we-drive: skipped, ${why} (local only: it needs the installed game, Proton, Xvfb, bubblewrap)`);
    return 0;
  }
  // Refused before anything starts: an install without English text has dialogs we-drive can't read.
  textLocale(readFileSync(join(game, ".build.info"), "utf8"));
  // The lock first: setting up may rebuild the farm (another game build), which must not happen under another run's
  // live editor, nor in two fresh runs at once.
  const release = await takeLock((m) => console.error(`we-drive: ${m}`));
  let s = null;
  const stopAll = () => {
    try { s?.stop(); } finally { release(); }
  };
  const onSignal = () => { stopAll(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  // An error nothing caught (a stream's, a timer's) or a closed stdout (EPIPE: the reader went) would end the process
  // past the finally below: the editor, its wineserver and Xvfb would stay, the lock with them.
  const onFatal = (e) => {
    try { console.error(`we-drive: ${e?.message ?? e}`); } catch { /* stderr gone too */ }
    stopAll();
    process.exit(1);
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  process.stdout.on("error", onFatal);
  pruneArtefacts(opts.work);
  let failed = false, lookIndex = 0, mapsStarted = 0;
  try {
    setup(game);
    s = new Session(opts, game);
    await s.startDisplay();
    for (const [step, arg] of steps) {
      try {
        if (step === "--map") {
          const map = resolve(arg);
          if (!existsSync(map)) throw new Error(`no map at ${map}`);
          const first = mapsStarted++ === 0, info = {};
          let via = mapAction(s.running()), fellBack = null;
          if (via === "open") {
            try {
              Object.assign(info, await s.openMap(map, first ? looks : []));
            } catch (e) {
              if (e instanceof EditorCrashed) throw e;
              // The open failed: the editor is stopped and started again with the map.
              fellBack = e.message;
              s.killEditor();
              via = "restart";
            }
          }
          if (via !== "open") await s.start(map, first ? looks : []);
          out({ step, map, via, ...(fellBack ? { openFailed: fellBack } : {}), ...info, display: s.display, ...(looks.length ? { cameras: looks.length } : {}) });
        } else if (step === "--open") {
          const map = resolve(arg);
          if (!existsSync(map)) throw new Error(`no map at ${map}`);
          mapsStarted++;
          out({ step, map, via: "open", ...(await s.openMap(map, [])), display: s.display });
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
        } else if (step === "--clipboard") {
          out({ step, ...s.x("clipboard", resolve(arg)) });
        } else if (step === "--key") {
          // To the open dialog if there is one, else to the main window (without a window manager the keyboard
          // stays with whatever was clicked last, e.g. the tool palette).
          // KEY@MS holds it down MS (the X server's autorepeat runs meanwhile).
          const m = /^(.+?)(?:@(\d+))?$/.exec(arg);
          const w = s.windows();
          const to = w.dialogs.at(-1) ?? w.main;
          const r = s.x("key", ...(to ? ["--window", to.id] : []), m[1], ...(m[2] ? ["--hold", m[2]] : []));
          await s.wait(300);
          out({ step, key: m[1], ...(m[2] ? { holdMs: Number(m[2]) } : {}), ...(r.pressed === false ? { pressed: false, reason: r.reason } : {}), dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--numlock") {
          // Num Lock as the X server holds it (it outlives an editor on the display): Num_Lock is pressed, into the
          // main window as --key does, only when the state differs, then read again.
          const { main } = s.windows();
          const r = s.x("numlock", arg, ...(main ? ["--window", main.id] : []));
          if (arg !== "status" && r.numlock !== arg) throw new Error(`Num Lock is still ${r.numlock} after ${r.pressed ? "pressing Num_Lock" : "no press"}${r.reason ? ` (${r.reason})` : ""}`);
          await s.wait(r.pressed ? 300 : 0);
          out({ step, numlock: r.numlock, was: r.was, pressed: r.pressed });
        } else if (step === "--type") {
          // Into the open dialog if there is one, else the main window, as --key.
          const w = s.windows();
          const to = w.dialogs.at(-1) ?? w.main;
          s.x("type", ...(to ? ["--window", to.id] : []), arg);
          await s.wait(300);
          out({ step, typed: arg.length, dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--export-minimap") {
          const r = await s.exportMinimap(arg);
          out({ step, ...r });
          if (!r.exported) { failed = true; break; }
        } else if (step === "--click" || step === "--double-click") {
          if (!/^\d+,\d+$/.test(arg)) throw new Error(`${step} wants X,Y`);
          s.act("click", arg, ...(step === "--double-click" ? ["--double"] : []));
          await s.wait(300);
          out({ step, at: arg, dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--drag") {
          s.act("drag", arg.from, arg.to, "--ms", arg.ms, ...(arg.mod ? ["--mod", arg.mod] : []), ...(arg.button ? ["--button", arg.button] : []));
          await s.wait(300);
          out({ step, from: arg.from, to: arg.to, ms: arg.ms, ...(arg.mod ? { mod: arg.mod } : {}), ...(arg.button ? { button: arg.button } : {}), dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--move") {
          if (!/^\d+,\d+$/.test(arg)) throw new Error("--move wants X,Y");
          s.act("move", arg);
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
            s.x("click", at, "--button", n > 0 ? 4 : 5);
            await s.wait(100);
          }
          await s.wait(500);
          out({ step, notches: n, at });
        } else if (step === "--close-modules") {
          const mods = s.windows().dialogs.filter((d) => isReopenedModule(d.title));
          for (const d of mods) s.x("close", d.id);
          await s.wait(1000);
          out({ step, closed: mods.map((d) => d.title) });
        } else if (step === "--windows") {
          const w = s.windows();
          const brief = (x) => ({ title: x.title, rect: x.rect });
          out({ step, main: w.main && brief(w.main), palettes: w.palettes.map(brief), dialogs: w.dialogs.map(brief), menus: w.menus.map(brief) });
        } else if (step === "--game-view") {
          out({ step, ...(await s.gameView(arg)) });
        } else if (step === "--fps") {
          const { main } = s.mainOrThrow();
          out({ step, ...s.x("frames", Number(arg), "--rect", s.viewRect(main).join(",")) });
        } else if (step === "--sleep") {
          await s.sleepWatching(Number(arg));
          out({ step });
        } else if (step === "--save") {
          const r = await s.save(arg);
          out({ step, ...r });
          if (!r.saved) { failed = true; break; }
        } else if (step === "--close") {
          const r = await s.close();
          out({ step, ...r });
          // A crash on close closed the editor, but the run failed (its result isn't to be trusted).
          if (!r.closed || r.crashed) { failed = true; break; }
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
