// The page's error collector for the Linux smoke tests (webdriver.mjs). WebKitGTK has no DevTools events, so the page
// keeps what went wrong in window.__w3smoke, in the shape of DevTools' events, and each evaluate hands it over.
//
// Two ways in, the same code:
//   - a debug build for Linux has it as the first script of index.html (vite.config.ts, smokeHook): errors from the
//     page's very first script on, and again after every reload, are kept. Release builds never get it.
//   - webdriver.mjs's first evaluate installs it when the page doesn't have it yet (a prebuilt app from before).
// Plain statements, no backticks, no backslashes: webdriver.mjs also puts this text into a template string.
if (!window.__w3smoke) {
  const log = window.__w3smoke = [];
  // What a reload left undelivered (this page's own pagehide put it there).
  try {
    const kept = sessionStorage.getItem("w3smoke.log");
    if (kept) { sessionStorage.removeItem("w3smoke.log"); log.push(...JSON.parse(kept)); }
  } catch { /* no storage, or not ours */ }
  window.addEventListener("pagehide", () => {
    if (log.length) try { sessionStorage.setItem("w3smoke.log", JSON.stringify(log)); } catch { /* full or none */ }
  });
  // WebKit's stack has no message line (Chrome's has): the message goes first when the stack lacks it.
  const text = (x) => x instanceof Error ? (x.stack && x.stack.includes(x.message) ? x.stack : String(x) + " " + (x.stack ?? "")) : typeof x === "object" && x !== null ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x);
  const error = console.error.bind(console);
  console.error = (...args) => { log.push({ method: "Runtime.consoleAPICalled", params: { type: "error", args: args.map((a) => ({ value: text(a) })) } }); error(...args); };
  window.addEventListener("error", (e) => log.push({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: e.message, exception: { description: e.error ? text(e.error) : e.message } } } }));
  window.addEventListener("unhandledrejection", (e) => log.push({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught (in promise)", exception: { description: "Uncaught (in promise) " + text(e.reason) } } } }));
  // The smoke's own test of the above (app-smoke's earlyPageErrors): a note in localStorage (kept over an app restart) or
  // sessionStorage (kept over a reload) makes this page throw once from its first moments, and is used up by it.
  try {
    for (const store of [localStorage, sessionStorage]) {
      const note = store.getItem("w3smoke.throwAtStart");
      if (note === null) continue;
      store.removeItem("w3smoke.throwAtStart");
      setTimeout(() => { throw new Error("smoke self-test error: " + note); }, 0);
      Promise.reject(new Error("smoke self-test rejection: " + note));
    }
  } catch { /* no storage */ }
}
