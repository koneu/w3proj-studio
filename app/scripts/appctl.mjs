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

/** Where the app with this identifier keeps its settings. */
export function configDir(id) {
  const base = process.platform === "win32" ? process.env.APPDATA : (process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"));
  return join(base ?? "", id);
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
  const r = spawnSync(`npx tauri build --debug --no-bundle --config "${patch}"`, { cwd: appDir, shell: true, stdio: ["ignore", process.stderr, process.stderr] });
  if (r.status !== 0) throw new Error("the app build failed");
}

/** The release CLI, built if it isn't there (and W3PROJ_BIN doesn't name another). */
export function ensureCli() {
  const cli = cliPath();
  if (existsSync(cli)) return cli;
  if (process.env.W3PROJ_BIN) throw new Error(`no w3proj at W3PROJ_BIN=${cli}`);
  const r = spawnSync("cargo", ["build", "--release", "-p", "w3proj-cli", "--quiet"], { cwd: repo, stdio: ["ignore", process.stderr, process.stderr] });
  if (r.status !== 0 || !existsSync(cli)) throw new Error("building the w3proj CLI failed");
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
  // Settings in the run's own folder (W3PROJ_CONFIG_DIR, else under `work`) and the webview's storage too (Linux), so
  // two runs of one build, or of a prebuilt one, never share them.
  const dir = process.env.W3PROJ_CONFIG_DIR ? resolve(process.env.W3PROJ_CONFIG_DIR) : join(work, "config");
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
  if (LINUX) {
    ({ page, stop, exited } = await launch(exe, appEnv));
  } else {
    const port = await freePort();
    const child = spawn(exe, [], {
      stdio: "ignore",
      env: { ...process.env, ...appEnv, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
    });
    let code = null;
    child.on("exit", (c) => { code = c; });
    exited = () => code;
    stop = async () => { child.kill(); };
    page = await connect(port);
  }
  const end = async () => {
    await stop();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await until("the app to start", () => page.evaluate(`!!window.w3 && document.querySelectorAll("button.activity").length > 0`), 60000);
  } catch (e) {
    await end();
    throw e;
  }
  return { page, stop: end, exited };
}

/** Calls an MCP tool of the app, as an AI client would; a tool error throws. Returns the reply's text. */
export async function mcpCall(page, name, args = {}) {
  const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const reply = JSON.parse(await page.evaluate(`w3.mcp.handle(${JSON.stringify(message)})`));
  const text = reply.result?.content?.map((c) => c.text ?? `[${c.type}]`).join("\n") ?? reply.error?.message ?? "";
  if (reply.error || reply.result?.isError) throw new Error(`${name}: ${text}`);
  return text;
}
