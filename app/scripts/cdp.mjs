// Talking to a page over the Chrome DevTools Protocol, with Node's own WebSocket. Used by the
// smoke tests, for headless Edge and for the app's WebView2 alike.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a check to come out true. One that throws counts as not yet: a file can be half
 *  written, a page still loading. The last error goes into the timeout's message. */
export async function until(what, check, timeout = 60000) {
  const end = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await sleep(100);
  }
}

/** A page call's time limit: `promise`, or a failure naming the call once `ms` passed (0: no limit). A call that took
 *  more than half its limit is told on stderr, so one growing towards it shows before it fails. */
export async function timedCall(promise, ms, expression) {
  if (!ms) return promise;
  const start = Date.now(), what = expression.replace(/\s+/g, " ").slice(0, 160);
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, no) => {
      timer = setTimeout(() => no(new Error(`page call timed out after ${ms / 1000} s (evaluate(…, { timeout }) gives a known-long one more): ${what}`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
    const took = Date.now() - start;
    if (took > ms / 2 && took < ms) process.stderr.write(`slow page call: ${Math.round(took / 1000)} s of its ${ms / 1000} s: ${what}\n`);
  }
}

export class Page {
  next = 1;
  pending = new Map();
  events = [];
  /** The time limit of an `evaluate` that doesn't give its own, in ms; 0: none (app-smoke sets one). */
  callTimeout = 0;
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
  /** `timeout` (ms, 0: none) overrides `callTimeout` for this call. One timed out goes on in the page; its answer is dropped. */
  async evaluate(expression, { timeout = this.callTimeout } = {}) {
    const r = await timedCall(this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), timeout, expression);
    if (r.exceptionDetails) {
      const e = r.exceptionDetails.exception;
      throw new Error(`in the page: ${e?.description ?? e?.value ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }
}

/** Input the way a person gives it, sent into the page: the desktop's mouse and keyboard aren't used. */
export class Hands {
  constructor(page) { this.page = page; }
  /** The centre of the first element matching a selector, and containing a text if given. */
  async where(selector, text = null) {
    const at = await this.page.evaluate(`(() => {
      const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => ${JSON.stringify(text)} === null || x.textContent.trim() === ${JSON.stringify(text)});
      if (!e) return null;
      e.scrollIntoView({ block: "center" });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
    })()`);
    if (!at) throw new Error(`nothing to click: ${selector}${text ? ` "${text}"` : ""}`);
    return at;
  }
  /** `modifiers`: DevTools' bits (8 Shift, 2 Ctrl, 1 Alt). */
  mouse(type, x, y, buttons = 0, modifiers = 0) {
    return this.page.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, modifiers });
  }
  /** Where a click on the element lands on it: its centre (`where`), with nothing else on top there. A toast that only
   *  tells something (an earlier check's note in the lower right, where many buttons are) is closed by its × first; a
   *  toast that asks something, or anything else on top, fails the click, naming what covers the element: the click
   *  would land on that instead. */
  async reach(selector, text = null) {
    for (let round = 0; round < 8; round++) {
      const at = await this.where(selector, text);
      const cover = await this.page.evaluate(`((x, y) => {
        const want = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${JSON.stringify(text)} === null || e.textContent.trim() === ${JSON.stringify(text)});
        const hit = document.elementFromPoint(x, y);
        // Nothing found there (off the window) is left to the click; so is the element's own part, or what holds it
        // when the element itself takes no pointer (an icon in a button).
        if (!want || !hit || want === hit || want.contains(hit) || hit.contains(want)) return null;
        const tell = (e) => {
          const cls = typeof e.className === "string" ? e.className.split(" ").filter(Boolean).map((c) => "." + c).join("") : "";
          return e.tagName.toLowerCase() + cls + ' "' + (e.textContent || "").trim().slice(0, 100) + '"';
        };
        const toast = hit.closest(".toast");
        // A toast asks when it offers a choice (data-asks); a note with one optional action ("Packed … / Reveal") doesn't.
        const asks = toast && toast.hasAttribute("data-asks");
        if (toast && !asks && toast.querySelector(".toast-close")) { toast.querySelector(".toast-close").click(); return { closed: tell(toast) }; }
        return { covered: tell(toast || hit) };
      })(${at.x}, ${at.y})`);
      if (!cover) return at;
      if (cover.covered) throw new Error(`${selector}${text ? ` "${text}"` : ""} is covered at ${Math.round(at.x)},${Math.round(at.y)} by ${cover.covered}: a click there would land on that`);
      await sleep(50);
    }
    throw new Error(`${selector}${text ? ` "${text}"` : ""} stays covered by toasts after closing eight`);
  }
  async click(selector, text = null, modifiers = 0) {
    const { x, y } = await this.reach(selector, text);
    await this.mouse("mouseMoved", x, y, 0, modifiers);
    await this.mouse("mousePressed", x, y, 1, modifiers);
    await this.mouse("mouseReleased", x, y, 0, modifiers);
    await sleep(50);
  }
  /** The mouse wheel turned over a point: `deltaY` pixels down (negative: up). */
  async wheel(x, y, deltaY) {
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    await sleep(50);
  }
  async drag(from, to, steps = 12) {
    await this.mouse("mouseMoved", from.x, from.y);
    await this.mouse("mousePressed", from.x, from.y, 1);
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1);
      await sleep(30);
    }
    await this.mouse("mouseReleased", to.x, to.y);
    await sleep(100);
  }
  /** Inserts the text, then one round trip through the page: insertText answers once it's sent, so a check reading the
   *  field right after could come before the page has the text. */
  async type(text) {
    await this.page.send("Input.insertText", { text });
    await this.page.evaluate("0");
  }
  async key(key, code, windowsVirtualKeyCode, modifiers = 0) {
    // Enter with its character, as a keyboard sends it: without `text` Chromium does no default action for it (a text
    // box's change on Enter didn't fire, which WebDriver's real key presses on Linux always did).
    const e = { key, code, windowsVirtualKeyCode, modifiers, ...(key === "Enter" && !(modifiers & ~8) ? { text: "\r", unmodifiedText: "\r" } : {}) };
    await this.page.send("Input.dispatchKeyEvent", { type: "keyDown", ...e });
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...e });
    await sleep(50);
  }
  /** A chord written as a person names it ("Ctrl+Shift+Z", "Shift+F2", "Numpad7"): see parseChord. */
  chord(spec) {
    const c = parseChord(spec);
    return this.key(c.key, c.code, c.windowsVirtualKeyCode, c.modifiers);
  }
}

// Named keys: their code is their name, and their Windows key code.
const NAMED_KEYS = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i])),
};
// The number pad by its code: the key it gives (Num Lock on) and its Windows key code.
const NUMPAD = {
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, [String(i), 96 + i]])),
  NumpadMultiply: ["*", 106], NumpadAdd: ["+", 107], NumpadSubtract: ["-", 109], NumpadDecimal: [".", 110], NumpadDivide: ["/", 111],
  NumpadEnter: ["Enter", 13],
};
// Punctuation on a US layout: its code and Windows key code.
const PUNCTUATION = { "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "-": ["Minus", 189], "=": ["Equal", 187], "/": ["Slash", 191], ",": ["Comma", 188], ".": ["Period", 190] };
const MODIFIER_BITS = { ctrl: 2, control: 2, shift: 8, alt: 1, meta: 4 };
// A modifier pressed alone ("Alt"): its key, and its Windows key code.
const MODIFIER_KEYS = { Shift: 16, Control: 17, Alt: 18, Meta: 91 };

/**
 * A chord as DevTools' Input.dispatchKeyEvent takes it: "Ctrl+Shift+Z" is key "Z" (a letter with Shift is its capital,
 * as a keyboard gives it), code "KeyZ", modifiers Ctrl|Shift. The last part is the key: a letter, a digit, a named key
 * (Tab, Enter, Escape, Space, the arrows, PageUp, Home, Delete, F1…F12), US punctuation ([ ] - = / , . and `, which
 * with Shift is ~) or a number
 * pad key by its code (Numpad7, NumpadAdd, NumpadEnter), or a modifier alone (Alt, Control, Shift, Meta: the left one).
 * "Plus" names "+" ("Ctrl+Plus").
 */
export function parseChord(spec) {
  const parts = String(spec).split("+");
  // "Ctrl++" ends in an empty part: the key is "+".
  if (parts.length > 1 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIER_BITS[m.toLowerCase()];
    if (!bit) throw new Error(`"${spec}": "${m}" isn't a modifier (Ctrl, Shift, Alt, Meta)`);
    modifiers |= bit;
  }
  const shift = (modifiers & 8) !== 0;
  if (/^[a-z]$/i.test(name)) {
    const upper = name.toUpperCase();
    return { key: shift ? upper : upper.toLowerCase(), code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers };
  }
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, windowsVirtualKeyCode: name.charCodeAt(0), modifiers };
  if (name === "Space") return { key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers };
  if (MODIFIER_KEYS[name]) return { key: name, code: `${name}Left`, windowsVirtualKeyCode: MODIFIER_KEYS[name], modifiers };
  if (NAMED_KEYS[name]) return { key: name, code: name, windowsVirtualKeyCode: NAMED_KEYS[name], modifiers };
  if (NUMPAD[name]) return { key: NUMPAD[name][0], code: name, windowsVirtualKeyCode: NUMPAD[name][1], modifiers };
  if (name === "+" || name === "Plus") return { key: "+", code: "NumpadAdd", windowsVirtualKeyCode: 107, modifiers };
  if (name === "*") return { key: "*", code: "NumpadMultiply", windowsVirtualKeyCode: 106, modifiers };
  if (PUNCTUATION[name]) return { key: name, code: PUNCTUATION[name][0], windowsVirtualKeyCode: PUNCTUATION[name][1], modifiers };
  // The key left of 1 (the World Editor's ~): "`", with Shift "~", as a US keyboard gives them.
  if (name === "`" || name === "Backquote") return { key: shift ? "~" : "`", code: "Backquote", windowsVirtualKeyCode: 192, modifiers };
  throw new Error(`"${spec}": no key named "${name}" (a letter, digit, Tab, Enter, F1, ArrowUp, Numpad7, …)`);
}

/** The page with this DevTools port, connected, with its events on. */
export async function connect(port, wanted = () => true) {
  const target = await until("a page", async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
    return list.find((t) => t.type === "page" && wanted(t));
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("no DevTools connection")));
  });
  const page = new Page(ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  return page;
}

/** Everything the page reported as wrong, in words. */
export function problems(events) {
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
