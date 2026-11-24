// Starting the real app for scripts: the smoke build (its own identifier, a hidden window on Windows, an
// Xvfb display on Linux), its own settings, and a page that takes cdp.mjs's calls on both systems
// (WebView2 over DevTools on Windows, WebKitGTK over WebDriver on Linux, webdriver.mjs).
// app-drive.mjs uses it; app-smoke.mjs still has its own copy of the start (to be moved over).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep, until } from "./cdp.mjs";
import { launch } from "./webdriver.mjs";
import { checkFresh, staleAllowed, writeStamp } from "../../tests/binfresh.mjs";

export const LINUX = process.platform === "linux";
export const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repo = resolve(app, "..");
const exeName = process.platform === "win32" ? ".exe" : "";
/** The app to start: W3_APP_BIN (a build made elsewhere, e.g. by verify-build.mjs; nothing is built then), else this
 *  checkout's debug build. */
export const appExe = () => (process.env.W3_APP_BIN ? resolve(process.env.W3_APP_BIN) : join(repo, "target", "debug", `w3proj-studio${exeName}`));
export const prebuilt = () => Boolean(process.env.W3_APP_BIN);
export const cliPath = () => process.env.W3PROJ_BIN ?? join(repo, "target", "release", `w3proj${exeName}`);

/** The smoke build's identifier: W3_SMOKE_ID, else one per checkout (as the gate uses), so runs in two
 *  worktrees don't share a settings folder and the build isn't redone for another identifier. */
export function smokeId(root = repo) {
  return process.env.W3_SMOKE_ID ?? `dev.w3proj.studio.smoke.${basename(root).replace(/[^A-Za-z0-9-]+/g, "-")}`;
}

/** How long buildApp lets a build take: a cold one (no sccache) took about 25 minutes here. */
export const BUILD_TIMEOUT_MS = 90 * 60 * 1000;

/** The command buildApp runs: the Tauri CLI's own script under node, as an argument list (no shell: a path with
 *  spaces or quotes in `patch` stays one argument, on Windows too, where npx is a .cmd node won't spawn without one). */
export function buildCommand(appDir, patch) {
  return [process.execPath, [join(appDir, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build", "--debug", "--no-bundle", "--config", patch]];
}

/** Builds the smoke app (debug, no bundle) with this identifier; incremental, so cheap when nothing changed.
 *  `appDir` is the app/ folder to build in (default: this checkout's; verify-build.mjs gives its archive's).
 *  Does nothing when W3_APP_BIN names a prebuilt app. */
export function buildApp(id, work, appDir = app) {
  if (prebuilt() && appDir === app) return;
  const conf = JSON.parse(readFileSync(join(appDir, "src-tauri", "tauri.conf.json"), "utf8"));
  // Linux runs it inside xvfb-run, a display nobody sees, where the window has to be shown to be drawn.
  const windows = conf.app.windows.map((w) => ({ ...w, visible: LINUX }));
  mkdirSync(work, { recursive: true });
  const patch = join(work, "tauri.smoke.json");
  writeFileSync(patch, JSON.stringify({ identifier: id, app: { windows }, build: { beforeBuildCommand: "npm run build" } }));
  const [cmd, args] = buildCommand(appDir, patch);
  const r = spawnSync(cmd, args, { cwd: appDir, stdio: ["ignore", process.stderr, process.stderr], timeout: BUILD_TIMEOUT_MS });
  if (r.error?.code === "ETIMEDOUT") throw new Error(`the app build took longer than ${BUILD_TIMEOUT_MS / 60000} minutes (stopped)`);
  if (r.status !== 0) throw new Error(`the app build failed${r.error ? `: ${r.error.message}` : ""}`);
}

/** The release CLI, built if it isn't there (and W3PROJ_BIN doesn't name another). */
export function ensureCli() {
  const cli = cliPath();
  if (existsSync(cli)) return checkFresh(cli, { kind: "cli", allowStale: staleAllowed() });
  if (process.env.W3PROJ_BIN) throw new Error(`no w3proj at W3PROJ_BIN=${cli}`);
  const r = spawnSync("cargo", ["build", "--release", "-p", "w3proj-cli", "--quiet"], { cwd: repo, stdio: ["ignore", process.stderr, process.stderr] });
  if (r.status !== 0 || !existsSync(cli)) throw new Error("building the w3proj CLI failed");
  writeStamp(cli, "cli");
  return cli;
}

function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

/**
 * Starts the built smoke app with fresh settings and connects to its page.
 * `settings` are written over the defaults (no MCP server, no checkpoints, the game's programs pointed at
 * files that don't exist so nothing can start the game or the World Editor, no game-folder question).
 * Returns { page, stop, exited }; `stop` ends the app and removes its settings folder.
 */
export async function startApp({ id, work, game, settings = {}, env = {} }) {
  const exe = appExe();
  if (!existsSync(exe)) throw new Error(`no app at ${exe}: build it first`);
  // A prebuilt app (W3_APP_BIN) can be of any age; the one built here is rebuilt by buildApp.
  if (prebuilt()) checkFresh(exe, { kind: "app", allowStale: staleAllowed() });
  // Settings in the run's own folder under `work` and the webview's storage too (Linux), so two runs of one build, or
  // of a prebuilt one, never share them. Always this folder (configDirOf): it is removed before and after, so it must
  // be one this script makes, never a W3PROJ_CONFIG_DIR of the caller's environment (which could name real settings).
  const dir = configDirOf(work);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    "mcp.enabled": false, "mcp.writeTools": true, "mcp.saveTool": true, "checkpoints.enabled": false,
    "game.path": join(work, "no-game", "Warcraft III.exe"), "worldEditor.path": join(work, "no-game", "World Editor.exe"),
    ...(game ? { "game.installDir": game } : {}), "game.askForFolder": false,
    ...settings,
  }));
  const appEnv = {
    W3PROJ_TRIGGERDATA: join(repo, "tests", "fixtures", "TriggerData.txt"), W3PROJ_CONFIG_DIR: dir,
    ...(LINUX ? { XDG_DATA_HOME: join(work, "xdg-data"), XDG_CACHE_HOME: join(work, "xdg-cache") } : {}), ...env,
  };
  let page, stop, exited;
  const removeConfig = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (LINUX) {
    try {
      ({ page, stop, exited } = await launch(exe, appEnv));
    } catch (e) {
      removeConfig();
      throw e;
    }
  } else {
    const port = await freePort();
    const child = spawn(exe, [], {
      stdio: "ignore",
      env: { ...process.env, ...appEnv, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
    });
    let code = null;
    child.on("exit", (c, signal) => { code = c ?? signal ?? "gone"; });
    child.on("error", () => { code ??= "failed to start"; });
    exited = () => code;
    // The app's exit is awaited (at most 10 s) before its settings folder is removed: a running app may still write it.
    stop = async () => { if (code === null) child.kill(); await waitFor(() => code !== null, 10000); };
    try {
      page = await connect(port);
    } catch (e) {
      // A failed connect left the app running and its settings behind.
      await stop();
      removeConfig();
      throw e;
    }
  }
  const end = async () => {
    await stop();
    await sleep(300);
    removeConfig();
  };
  try {
    await until("the app to start", () => page.evaluate(`!!window.w3 && document.querySelectorAll("button.activity").length > 0`), 60000);
  } catch (e) {
    await end();
    throw e;
  }
  return { page, stop: end, exited };
}

/** The settings folder startApp makes for a run in `work` (and removes before and after it). */
export const configDirOf = (work) => join(work, "config");

/** Waits until `done()` is true, at most `ms`; returns whether it became true. */
async function waitFor(done, ms) {
  for (const end = Date.now() + ms; !done(); await sleep(50)) if (Date.now() >= end) return false;
  return true;
}

/** Calls an MCP tool of the app, as an AI client would; a tool error throws. Returns the reply's text. */
export async function mcpCall(page, name, args = {}) {
  const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const reply = JSON.parse(await page.evaluate(`w3.mcp.handle(${JSON.stringify(message)})`));
  const text = reply.result?.content?.map((c) => c.text ?? `[${c.type}]`).join("\n") ?? reply.error?.message ?? "";
  if (reply.error || reply.result?.isError) throw new Error(`${name}: ${text}`);
  return text;
}
