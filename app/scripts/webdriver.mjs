// The app's page over W3C WebDriver, for Linux: WebKitGTK has no DevTools Protocol, so the smoke tests
// reach it through tauri-driver → WebKitWebDriver, inside xvfb-run (a display of its own, no window on
// yours). The page it gives looks like cdp.mjs's `Page` to the tests: `evaluate`, `events` and `send` for
// the few DevTools commands they use (`Input.*`, `Page.captureScreenshot`, `Runtime.evaluate`), which are
// translated here. So `Hands`, `problems` and the checks themselves run unchanged on both systems.
//
// What differs from the DevTools page:
//   - Errors are caught by a hook installed in the page, not reported by the browser. It's put in on the
//     first `evaluate`, so an error thrown before that (during the app's first moments) isn't seen, and
//     browser-level messages (a failed network load) aren't seen at all.
//   - Text typing (`Input.insertText`) uses the page's own `insertText` editing command: no key events,
//     like DevTools.
//   - The app process is WebKitWebDriver's child, so its exit shows as a lost session.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { sleep, until } from "./cdp.mjs";

/** Is what Linux runs need there? Returns the missing tools' names. */
export function missingTools() {
  return ["xvfb-run", "tauri-driver", "WebKitWebDriver"].filter((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status !== 0);
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// WebDriver's key codes (W3C WebDriver, "Keyboard actions").
const KEYS = {
  Enter: "", Escape: "", Tab: "", Backspace: "", Delete: "",
  ArrowLeft: "", ArrowUp: "", ArrowRight: "", ArrowDown: "",
  PageUp: "", PageDown: "", Home: "", End: "", Insert: "", " ": " ",
  F1: "", F2: "", F3: "", F4: "", F5: "", F6: "",
  F7: "", F8: "", F9: "", F10: "", F11: "", F12: "",
};
// DevTools' modifier bits, in the order they're pressed.
const MODIFIERS = [[2, ""], [8, ""], [1, ""], [4, ""]]; // Control, Shift, Alt, Meta

function keyValue(key) {
  if (KEYS[key]) return KEYS[key];
  if ([...key].length === 1) return key;
  throw new Error(`webdriver.mjs doesn't know the key "${key}": add it to KEYS`);
}

// Collects what the page reports as wrong, in the shape of DevTools' events, so cdp.mjs's `problems` reads it.
const HOOK = `if (!window.__w3smoke) {
  const log = window.__w3smoke = [];
  const text = (x) => x instanceof Error ? (x.stack ?? String(x)) : typeof x === "object" && x !== null ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x);
  const error = console.error.bind(console);
  console.error = (...args) => { log.push({ method: "Runtime.consoleAPICalled", params: { type: "error", args: args.map((a) => ({ value: text(a) })) } }); error(...args); };
  window.addEventListener("error", (e) => log.push({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: e.message, exception: { description: e.error ? text(e.error) : e.message } } } }));
  window.addEventListener("unhandledrejection", (e) => log.push({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught (in promise)", exception: { description: "Uncaught (in promise) " + text(e.reason) } } } }));
}`;

// Runs an expression (or statements, as DevTools' Runtime.evaluate takes them), awaits a promise it gives,
// and answers with JSON text, plus what the hook collected since the last call.
const EVALUATE = `const [expression, done] = arguments;
${HOOK}
const drain = () => window.__w3smoke.splice(0);
Promise.resolve().then(() => (0, eval)(expression)).then(
  (v) => { let json; try { json = JSON.stringify({ v }); } catch { json = "{}"; } done({ json, log: drain() }); },
  (e) => done({ error: e instanceof Error ? (e.stack ?? String(e)) : String(e), log: drain() }));`;

export class WebDriverPage {
  events = [];
  constructor(base, session) {
    this.base = base;
    this.session = session;
    // app-smoke closes the DevTools socket when it's done; here that ends the session.
    this.ws = { close: () => { this.close().catch(() => {}); } };
  }

  async request(method, path, body) {
    const r = await fetch(`${this.base}/session/${this.session}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const { value } = await r.json();
    if (!r.ok || value?.error) throw new Error(`WebDriver ${path}: ${value?.message ?? value?.error ?? r.status}`);
    return value;
  }

  async evaluate(expression) {
    const r = await this.request("POST", "/execute/async", { script: EVALUATE, args: [expression] }).catch((e) => {
      // A WebDriver-level failure doesn't say which call it was; the start of the expression does.
      throw new Error(`${e.message}, evaluating: ${expression.replace(/\s+/g, " ").slice(0, 160)}`);
    });
    this.events.push(...(r.log ?? []));
    if (r.error !== undefined) throw new Error(`in the page: ${r.error}`);
    return JSON.parse(r.json).v;
  }

  actions(actions) { return this.request("POST", "/actions", { actions }); }

  key(type, params) {
    const value = keyValue(params.key);
    const mods = MODIFIERS.filter(([bit]) => (params.modifiers ?? 0) & bit).map(([, v]) => v);
    const steps = type === "keyDown"
      ? [...mods.map((v) => ({ type: "keyDown", value: v })), { type: "keyDown", value }]
      : [{ type: "keyUp", value }, ...mods.reverse().map((v) => ({ type: "keyUp", value: v }))];
    return this.actions([{ type: "key", id: "keyboard", actions: steps }]);
  }

  mouse(params) {
    const move = { type: "pointerMove", origin: "viewport", x: Math.round(params.x), y: Math.round(params.y), duration: 0 };
    const steps = params.type === "mousePressed" ? [move, { type: "pointerDown", button: 0 }]
      : params.type === "mouseReleased" ? [move, { type: "pointerUp", button: 0 }]
      : [move];
    return this.actions([{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: steps }]);
  }

  async screenshot(params) {
    const data = await this.request("GET", "/screenshot");
    if (!params.clip) return { data };
    // The clip is in page pixels; the picture may be scaled by the display's pixel ratio.
    const { x, y, width, height } = params.clip;
    const cropped = await this.evaluate(`(async () => {
      const i = new Image();
      await new Promise((ok, no) => { i.onload = ok; i.onerror = no; i.src = "data:image/png;base64,${data}"; });
      const s = i.width / window.innerWidth, c = document.createElement("canvas");
      c.width = Math.round(${width} * s); c.height = Math.round(${height} * s);
      c.getContext("2d").drawImage(i, Math.round(${x} * s), Math.round(${y} * s), c.width, c.height, 0, 0, c.width, c.height);
      return c.toDataURL("image/png").slice("data:image/png;base64,".length);
    })()`);
    return { data: cropped };
  }

  /** The DevTools commands the tests send, done over WebDriver. */
  async send(method, params = {}) {
    switch (method) {
      case "Runtime.evaluate": return { result: { value: await this.evaluate(params.expression) } };
      case "Input.dispatchKeyEvent": return this.key(params.type, params);
      case "Input.dispatchMouseEvent": return this.mouse(params);
      case "Input.insertText": return this.evaluate(`document.execCommand("insertText", false, ${JSON.stringify(params.text)})`);
      case "Page.captureScreenshot": return this.screenshot(params);
      case "Page.enable": case "Runtime.enable": case "Log.enable": return {};
      default: throw new Error(`webdriver.mjs can't send ${method}: translate it in WebDriverPage.send`);
    }
  }

  async close() {
    if (!this.session) return;
    const session = this.session;
    this.session = null;
    await fetch(`${this.base}/session/${session}`, { method: "DELETE" }).catch(() => {});
  }
}

/**
 * Starts the app through tauri-driver inside xvfb-run and connects to its page.
 * `env` goes to tauri-driver, which passes it on to the app. Returns the page and a `stop` that ends
 * the session, then tauri-driver, WebKitWebDriver and Xvfb (one process group).
 */
export async function launch(exe, env = {}) {
  const missing = missingTools();
  if (missing.length) throw new Error(`missing for the Linux smoke test: ${missing.join(", ")} (run scripts/setup-linux.sh)`);
  const port = await freePort(), nativePort = await freePort();
  const driver = spawn("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", "tauri-driver", "--port", String(port), "--native-port", String(nativePort)], {
    stdio: ["ignore", "ignore", "pipe"], detached: true, env: { ...process.env, ...env },
  });
  let stderr = "";
  driver.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  let exited = null;
  driver.on("exit", (code) => { exited = code; });
  // The driver runs in a process group of its own (so it can be stopped with everything it started), which also
  // keeps a Ctrl+C in the terminal from reaching it: an interrupted run stops the group itself before it ends.
  const killGroup = (signal) => { try { process.kill(-driver.pid, signal); } catch { /* gone already */ } };
  const interrupted = (signal) => { killGroup("SIGKILL"); process.exit(signal === "SIGINT" ? 130 : 143); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const stop = async (page) => {
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    await page?.close();
    killGroup("SIGTERM");
    await sleep(300);
    killGroup("SIGKILL");
  };

  const base = `http://127.0.0.1:${port}`;
  try {
    await until("tauri-driver", async () => {
      if (exited !== null) throw new Error(`tauri-driver exited with ${exited}: ${stderr.trim()}`);
      return (await fetch(`${base}/status`)).ok;
    }, 30000);
    const r = await fetch(`${base}/session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: exe } } } }),
    });
    const { value } = await r.json();
    if (!r.ok || value?.error) throw new Error(`no WebDriver session: ${value?.message ?? r.status} ${stderr.trim()}`);
    const page = new WebDriverPage(base, value.sessionId);
    // DevTools' evaluate has no time limit, and some checks wait minutes for the game's files.
    await page.request("POST", "/timeouts", { script: 15 * 60 * 1000 });
    return { page, stop: () => stop(page), exited: () => exited };
  } catch (e) {
    await stop();
    throw e;
  }
}
