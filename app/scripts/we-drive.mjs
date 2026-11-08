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
//   --mode sd|hd        the editor's graphics (default hd): written into its preferences before the start
//   --day-night cycle|fixed   whether the editor's day and night turn (its default) or stand still (default cycle)
//
// Steps (in the order given; each prints one JSON line):
//   --map FILE          start the editor with a copy of this map (`World Editor.exe -launch -loadfile Z:\…`)
//   --start             start the editor without a map
//   --wait-ready        wait until the map is shown: the main window has the map's name, no dialog is open, and the
//                       terrain view has drawn. A dialog that stays open (an error, "no longer a melee map", …) is
//                       reported with its title and a picture of the screen, and the run stops, rather than hanging
//   --shot FILE.png     picture of the terrain view (the main window's 3D area)
//   --shot-window FILE  picture of the main window
//   --shot-screen FILE  picture of the whole display (dialogs included)
//   --key KEY           press a key in the editor ("v", "Escape", "Up", "ctrl+z"; X keysym names)
//   --click X,Y         click at a position of the display (fixed size, so positions stay put)
//   --wheel N           turn the mouse wheel over the terrain view: N notches, positive zooms in
//   --windows           list the editor's windows: title, rect, and which are dialogs
//   --game-view STATE   "on", "off" or "status": the state of View > Lock to Game View Settings, read from the
//                       picture of the View menu's check mark; on/off press V until it matches, and check again.
//                       Also reports cornerRedPixels, the pinkish red of a "Game View Settings" note in the view's
//                       top-right corner (this build doesn't draw one here: it stays 0 either way)
//   --fps MS            how often the terrain view's picture changes during MS (it animates day and night)
//   --sleep MS          wait
//   --close             quit without saving: closes the main window and answers "don't save" questions
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

import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { farmDir, gameDir, linkedFiles, missing, prefixDir, setup, shimPath, takeLock, userCompatData } from "./we-setup.mjs";

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
const GAME_VIEW_CHECK = { x: 2, y: 381, w: 18, h: 16 };
// The first-start dialog's Continue button, from the dialog's corner.
const WELCOME = { title: "Welcome to the Warcraft III World Editor", button: { x: 473, y: 470 } };

const VALUE_STEPS = new Set(["--map", "--shot", "--shot-window", "--shot-screen", "--key", "--click", "--wheel", "--game-view", "--fps", "--sleep"]);
const FLAG_STEPS = new Set(["--start", "--wait-ready", "--windows", "--close"]);

function parseArgs(argv) {
  const opts = { game: null, work: join(repo, "target", "we-drive"), timeout: 300, mode: "hd", dayNight: "cycle" };
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
    else if (a === "--day-night") opts.dayNight = value();
    else if (VALUE_STEPS.has(a)) steps.push([a, value()]);
    else if (FLAG_STEPS.has(a)) steps.push([a, null]);
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument ${a} (see the top of we-drive.mjs)`);
  }
  return { opts, steps };
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
    const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", `${SIZE[0]}x${SIZE[1]}x24`, "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
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
      "--tmpfs", "/dev/snd"];
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

  async start(map) {
    if (this.editor) throw new Error("the editor is already running (one map per run)");
    await this.ensureLocale();
    this.writePrefs();
    const exe = join(farmDir(), "_retail_", "x86_64", "World Editor.exe");
    const args = ["-launch"];
    if (map) {
      const dir = join(this.opts.work, "maps");
      mkdirSync(dir, { recursive: true });
      const copy = join(dir, basename(map));
      copyFileSync(map, copy);
      args.push("-loadfile", winePath(copy));
      this.mapName = basename(map);
    }
    this.startedAt = Date.now();
    this.editor = this.spawnWine(exe, args);
    this.editor.on("exit", () => { this.editorExited = true; });
  }

  windows() {
    return classify(x11(this.display, "windows").windows);
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
      if (d.title === WELCOME.title) {
        // Once, then again only if it's still there 15 s later (it stays until the editor has loaded the map).
        if (Date.now() - (this.clicked.get(d.id) ?? 0) > 15000) {
          x11(this.display, "click", `${d.rect[0] + WELCOME.button.x},${d.rect[1] + WELCOME.button.y}`);
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
    let readySince = 0, dialogSince = 0, mainAt = null;
    for (;;) {
      if (this.editorExited) throw new Error(`the editor exited while starting (see ${this.log})`);
      const { main, dialogs } = this.windows();
      if (main && !mainAt) mainAt = Date.now() - this.startedAt;
      const unknown = this.answerKnown(dialogs);
      // A loading window (no title, small) comes and goes while the map loads; a titled dialog that stays is a question.
      const questions = unknown.filter((d) => d.title);
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
          return { ready: true, title: main.title, mainWindowMs: mainAt, readyMs: Date.now() - this.startedAt, view: this.viewRect(main), answered: this.answered ?? [] };
        }
      } else readySince = 0;
      if (Date.now() > deadline) {
        return { ready: false, timeout: this.opts.timeout, title: main?.title ?? null, dialogs: unknown.map((d) => ({ title: d.title, rect: d.rect })), screen: this.dialogShot("timeout") };
      }
      await sleep(500);
    }
  }

  mainOrThrow() {
    const w = this.windows();
    if (!w.main) throw new Error("no main window of the editor");
    return w;
  }

  /** Lock to Game View Settings, from the View menu's check mark. */
  async gameViewState() {
    const { main } = this.mainOrThrow();
    x11(this.display, "click", `${main.rect[0] + VIEW_MENU.x},${main.rect[1] + VIEW_MENU.y}`);
    let menu = null;
    for (let i = 0; i < 20 && !menu; i++) {
      await sleep(150);
      menu = this.windows().menus.find((m) => m.rect[3] > 300) ?? null;
    }
    if (!menu) throw new Error("the View menu didn't open");
    await sleep(200);
    const rect = [menu.rect[0] + GAME_VIEW_CHECK.x, menu.rect[1] + GAME_VIEW_CHECK.y, GAME_VIEW_CHECK.w, GAME_VIEW_CHECK.h];
    const s = x11(this.display, "stats", "--rect", rect.join(","));
    x11(this.display, "key", "Escape");
    x11(this.display, "key", "Escape");
    await sleep(200);
    return { on: s.darkPixels >= 8, checkDarkPixels: s.darkPixels };
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

  async close() {
    if (!this.editor || this.editorExited) return { closed: true, answered: [] };
    const answered = [];
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
        if (d.title === "Warning" || d.title.startsWith("Warcraft III World Editor") || d.title === "") {
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
  const { opts, steps } = parseArgs(process.argv.slice(2));
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
  let failed = false;
  try {
    await s.startDisplay();
    for (const [step, arg] of steps) {
      try {
        if (step === "--map") {
          const map = resolve(arg);
          if (!existsSync(map)) throw new Error(`no map at ${map}`);
          await s.start(map);
          out({ step, map, display: s.display });
        } else if (step === "--start") {
          await s.start(null);
          out({ step, display: s.display });
        } else if (step === "--wait-ready") {
          const r = await s.waitReady();
          out({ step, ...r });
          if (!r.ready) { failed = true; break; }
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
          const w = s.windows();
          const to = w.dialogs.at(-1) ?? w.main;
          x11(s.display, "key", ...(to ? ["--window", to.id] : []), arg);
          await sleep(300);
          out({ step, key: arg, dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--click") {
          if (!/^\d+,\d+$/.test(arg)) throw new Error("--click wants X,Y");
          x11(s.display, "click", arg);
          await sleep(300);
          out({ step, at: arg, dialogs: s.windows().dialogs.map((d) => d.title) });
        } else if (step === "--wheel") {
          // Mouse wheel over the middle of the terrain view: positive zooms in (button 4), negative out (button 5).
          const n = Number(arg);
          if (!Number.isInteger(n) || n === 0) throw new Error("--wheel wants a whole number of notches, not 0");
          const { main } = s.mainOrThrow();
          const [vx, vy, vw, vh] = s.viewRect(main);
          for (let i = 0; i < Math.abs(n); i++) {
            x11(s.display, "click", `${vx + Math.round(vw / 2)},${vy + Math.round(vh / 2)}`, "--button", n > 0 ? 4 : 5);
            await sleep(100);
          }
          await sleep(500);
          out({ step, notches: n });
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
        } else if (step === "--close") {
          const r = await s.close();
          out({ step, ...r });
          if (!r.closed) { failed = true; break; }
        }
      } catch (e) {
        failed = true;
        out({ step, arg, error: e.message });
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
