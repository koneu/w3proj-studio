// Boots the real production bundle (app/dist) in headless Edge and fails on anything the app
// reports as broken: `npm run ui-smoke` (after `npx vite build`, or with --build).
//
// There is no window, so it can run while someone works at the PC, and it doesn't touch their
// settings: Edge gets a throwaway profile, and the Tauri backend is replaced by the fake below.
// It proves that the bundle starts, every built-in extension activates (and so its lazy chunks
// load) and all side bar views open, with no project. It doesn't prove anything that needs a backend (see TESTING.md).
//
// Driven over the DevTools protocol with Node's own WebSocket: no test dependencies.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, problems, sleep, until as untilFor } from "./cdp.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const dist = join(app, "dist");
const work = join(app, "..", "target", "ui-smoke");
const TIMEOUT = 45_000;

/** Runs in the page before the app. Commands the fake doesn't know are rejected and listed, so
 *  the app's own error handling runs. */
function fakeTauri() {
  const known = {
    app_paths: () => ({ settings: "C:\\smoke\\settings.json", user_extensions: "C:\\smoke\\extensions" }),
    extensions_scan: () => [],
    fs_exists: () => false,
    fs_read_text: () => Promise.reject("not found"),
    watched_maps: () => [],
    "plugin:event|listen": () => 1,
    "plugin:event|unlisten": () => undefined,
  };
  const smoke = (window.__smoke = { unknown: {} });
  let callback = 0;
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      const f = known[command];
      if (f) return Promise.resolve().then(() => f(args));
      smoke.unknown[command] = (smoke.unknown[command] ?? 0) + 1;
      return Promise.reject(`no backend in the smoke test: ${command}`);
    },
    transformCallback: () => ++callback,
    unregisterCallback() {},
    convertFileSrc: (path) => path,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml" };

function serve() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/favicon.ico") {
      res.writeHead(204).end(); // the Tauri app has its icon from the window
      return;
    }
    const file = join(dist, normalize(path === "/" ? "/index.html" : path));
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function findEdge() {
  const candidates = [
    process.env.W3_SMOKE_BROWSER,
    join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("no Edge or Chrome found; set W3_SMOKE_BROWSER");
  return found;
}

const until = (what, check) => untilFor(what, check, TIMEOUT);

async function run() {
  if (process.argv.includes("--build")) {
    const npx = spawnSync("npx vite build", { cwd: app, shell: true, stdio: "inherit" });
    if (npx.status !== 0) throw new Error("the build failed");
  }
  if (!existsSync(join(dist, "index.html"))) throw new Error("no app/dist: run `npx vite build` or pass --build");

  rmSync(work, { recursive: true, force: true });
  const profile = join(work, "profile");
  mkdirSync(profile, { recursive: true });
  const server = await serve();
  const browser = spawn(findEdge(), [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--window-size=1400,900",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const portFile = join(profile, "DevToolsActivePort");
    const port = await until("the browser", () => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0]);
    const page = await connect(port);
    const ws = page.ws;
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${fakeTauri})();` });
    await page.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });

    await until("the app to start", () => page.evaluate(`!!window.w3 && document.querySelectorAll("button.activity").length > 0`));
    await sleep(1000); // extensions activate in the background

    const views = await page.evaluate(`[...document.querySelectorAll("button.activity")].map((e) => e.title || e.textContent.trim())`);
    // Most extensions wait for an event: activate them all, which also loads their lazy chunks.
    const extensions = await page.evaluate(`(async () => {
      const host = w3Workbench.host;
      const all = host.extensions.filter((e) => !e.disabled);
      await Promise.all(all.map((e) => host.activate(e)));
      return all.map((e) => ({ id: e.manifest.id, active: e.active, error: e.error ?? null }));
    })()`);
    const commands = await page.evaluate(`w3Workbench.commands.all().map((c) => c.id)`);
    // The file browser: folders, list and preview come up, and Escape closes it.
    // It opens at the current file with nothing searched: a search left in the box empties every other folder.
    await page.evaluate(`(() => {
      w3.game.list = async () => ["War3.w3mod:units/Human/Knight/Knight.mdx", "War3.w3mod:Units/Human/Footman/Footman.mdx", "War3.w3mod:Units/Orc/Grunt/Grunt.mdx"];
      const current = ["units", "human", "footman", "footman"].join(String.fromCharCode(92));
      return w3.services.get("w3.objects").then((o) => { window.__pick = o.pickFile(document.body, { title: "Smoke", kind: "model", current }); });
    })()`);
    await sleep(300);
    const browser_ = await page.evaluate(`[".browse-tree", ".picker-rows", ".browse-preview canvas"].map((c) => !!document.querySelector(c))`);
    const browserStart = await page.evaluate(`JSON.stringify({ search: document.querySelector(".picker-search").value, row: document.querySelector(".picker-row.active")?.textContent ?? "", folder: document.querySelector(".browse-folder.active")?.textContent ?? "" })`);
    await page.evaluate(`document.querySelectorAll(".browse-folder")[0].click()`);
    await sleep(100);
    const browserAll = await page.evaluate(`document.querySelectorAll(".picker-row").length`);
    await page.evaluate(`document.querySelector(".picker-search").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    const browserClosed = await page.evaluate(`window.__pick.then((r) => r === null && !document.querySelector(".picker-browse"))`);
    // A question after Delete: a key held down doesn't answer it, a new press does.
    const heldKey = await page.evaluate(`(async () => {
      let answer = "open";
      void w3.window.askDelete("Smoke?", "Remove").then((r) => { answer = r; });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", repeat: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      const held = answer;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      // Clicking elsewhere drops the question, so the next Delete can't answer for something else.
      let moved = "open";
      void w3.window.askDelete("Smoke?", "Remove").then((r) => { moved = r; });
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      return held === "open" && answer === true && moved === false;
    })()`);
    const titleBarOk = await page.evaluate(`!!document.querySelector(".titlebar .menubar") && !!document.querySelector(".titlebar .titlebar-search") && document.querySelectorAll(".titlebar-button").length === 3 && document.querySelector(".titlebar").getBoundingClientRect().top === 0`);
    const menus = await page.evaluate(`[...document.querySelectorAll(".menubar-item")].map((b) => b.textContent)`);
    await page.evaluate(`document.querySelector(".menubar-item").click()`);
    const fileMenu = await page.evaluate(`[...document.querySelectorAll(".context-menu-item")].map((e) => e.textContent)`);
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    // The menu bar by keyboard, and what can't run with no project open.
    const menuKeys = await page.evaluate(`(() => {
      const key = (type, k, more = {}) => (document.activeElement ?? window).dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...more }));
      const press = (k, more) => key("keydown", k, more);
      const active = () => document.querySelector(".context-menu-item.active")?.firstChild?.textContent ?? null;
      const titles = () => [...document.querySelectorAll(".context-menu-item")].map((e) => e.firstChild.textContent);
      const focus = () => document.activeElement?.textContent;
      const notes = {};
      press("f", { altKey: true });
      notes.opened = active();
      notes.greyed = [...document.querySelectorAll(".context-menu-item.disabled")].map((e) => e.firstChild.textContent);
      notes.why = document.querySelector(".context-menu-item.disabled")?.title;
      const before = active();
      press("ArrowDown");
      notes.moved = active() !== before;
      press("ArrowRight");
      notes.nextMenu = titles().includes("Undo");
      notes.nextFocus = focus();
      press("Escape");
      notes.closed = !document.querySelector(".context-menu");
      notes.backOnBar = focus();
      press("Escape");
      notes.leftBar = !document.activeElement?.classList.contains("menubar-item");
      press("Alt"); key("keyup", "Alt");
      notes.altTap = focus();
      press("Alt"); key("keyup", "Alt");
      notes.altAgain = !document.activeElement?.classList.contains("menubar-item");
      press("Alt"); window.dispatchEvent(new MouseEvent("mousedown")); key("keyup", "Alt");
      notes.altClick = !document.activeElement?.classList.contains("menubar-item");
      press("q", { altKey: true, ctrlKey: true });
      press("f", { altKey: true, ctrlKey: true });
      notes.altGr = !document.querySelector(".context-menu");
      return notes;
    })()`);
    // With nothing open there's nothing to undo: the buttons by the tabs stay away.
    const undoHidden = await page.evaluate(`document.querySelector(".tabs-actions")?.hidden === true`);
    const shown = [];
    for (let i = 0; i < views.length; i++) {
      await page.evaluate(`document.querySelectorAll("button.activity")[${i}].click()`);
      await sleep(150);
      shown.push(await page.evaluate(`document.body.innerText.includes("Could not") ? "error" : "ok"`));
    }
    const unknown = await page.evaluate(`window.__smoke.unknown`);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(dirname(join(work, "x")), { recursive: true });
    writeFileSync(join(work, "screen.png"), Buffer.from(shot.data, "base64"));
    ws.close();

    const found = problems(page.events);
    if (!menuKeys.opened || !menuKeys.moved || !menuKeys.nextMenu || menuKeys.nextFocus !== "Edit" || !menuKeys.closed || menuKeys.backOnBar !== "Edit"
      || !menuKeys.leftBar || menuKeys.altTap !== "File" || !menuKeys.altAgain || !menuKeys.altClick || !menuKeys.altGr) found.push(`menu bar keys: ${JSON.stringify(menuKeys)}`);
    if (!menuKeys.greyed?.includes("Close Project") || !menuKeys.greyed?.includes("Save") || menuKeys.greyed?.includes("New Map…") || !/project/.test(menuKeys.why ?? "")) found.push(`menu entries greyed out: ${JSON.stringify(menuKeys)}`);
    if (views.length < 3) found.push(`only ${views.length} side bar views`);
    if (extensions.length < 20) found.push(`only ${extensions.length} extensions`);
    for (const e of extensions) {
      if (e.error) found.push(`extension ${e.id} failed: ${e.error}`);
      else if (!e.active) found.push(`extension ${e.id} didn't activate`);
    }
    if (commands.length < 20) found.push(`only ${commands.length} commands`);
    if (menus.join() !== "File,Edit,View,Scenario,Module,Tools,Help") found.push(`the menu bar shows ${menus.join()}`);
    if (browser_.includes(false)) found.push(`the file browser came up without a panel: ${browser_}`);
    const started = JSON.parse(browserStart);
    if (started.search !== "" || !started.row.includes("Footman") || !started.folder.startsWith("▾Footman") && !started.folder.includes("Footman")) found.push(`the file browser didn't open at the current file: ${browserStart}`);
    if (browserAll !== 3) found.push(`All files shows ${browserAll} of 3`);
    if (!browserClosed) found.push("the file browser didn't close");
    if (!heldKey) found.push("the Delete question doesn't tell a held key from a new press");
    if (!titleBarOk) found.push("the title bar isn't complete, or not at the top");
    if (!fileMenu.some((t) => t.startsWith("New Map"))) found.push("the File menu has no New Map");
    if (!commands.includes("workbench.undo") || !commands.includes("workbench.redo")) found.push("no Undo and Redo commands");
    if (!undoHidden) found.push("the undo buttons show with no editor open");
    shown.forEach((s, i) => s === "ok" || found.push(`view "${views[i]}" shows an error`));

    console.log(`${extensions.length} extensions active, ${views.length} views opened, ${commands.length} commands registered`);
    console.log(`backend commands the fake doesn't answer: ${Object.keys(unknown).sort().join(", ") || "none"}`);
    console.log(`screenshot: ${join(work, "screen.png")}`);
    return found;
  } finally {
    browser.kill();
    server.close();
  }
}

try {
  const found = await run();
  for (const p of found) console.error(`FAIL ${p}`);
  console.log(found.length ? `${found.length} problems` : "ui smoke ok");
  process.exit(found.length ? 1 : 0);
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exit(1);
}
