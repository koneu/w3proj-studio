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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, check) {
  const end = Date.now() + TIMEOUT;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

class Page {
  next = 1;
  pending = new Map();
  events = [];
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      } else this.events.push(msg);
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
}

/** Everything the page reported as wrong, in words. */
function problems(events) {
  const out = [];
  for (const e of events) {
    if (e.method === "Runtime.exceptionThrown") {
      const d = e.params.exceptionDetails;
      out.push(`uncaught: ${d.exception?.description ?? d.text}`);
    } else if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
      out.push(`console.error: ${e.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    } else if (e.method === "Log.entryAdded" && e.params.entry.level === "error") {
      out.push(`browser: ${e.params.entry.text} ${e.params.entry.url ?? ""}`);
    }
  }
  return [...new Set(out)];
}

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
    const targets = await until("a page", async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return list.find((t) => t.type === "page");
    });
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", () => reject(new Error("no DevTools connection")));
    });
    const page = new Page(ws);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
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
    if (views.length < 3) found.push(`only ${views.length} side bar views`);
    if (extensions.length < 20) found.push(`only ${extensions.length} extensions`);
    for (const e of extensions) {
      if (e.error) found.push(`extension ${e.id} failed: ${e.error}`);
      else if (!e.active) found.push(`extension ${e.id} didn't activate`);
    }
    if (commands.length < 20) found.push(`only ${commands.length} commands`);
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
