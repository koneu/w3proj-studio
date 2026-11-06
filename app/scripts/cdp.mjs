// Talking to a page over the Chrome DevTools Protocol, with Node's own WebSocket. Used by the
// smoke tests, for headless Edge and for the app's WebView2 alike.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, check, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export class Page {
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
    if (r.exceptionDetails) {
      const e = r.exceptionDetails.exception;
      throw new Error(`in the page: ${e?.description ?? e?.value ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }
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
