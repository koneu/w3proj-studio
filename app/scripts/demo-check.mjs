// Serves app/dist-demo under /w3proj-studio/ (as GitHub Pages does) and drives it in headless Chrome or Edge:
// `npm run demo-check` (after `npm run build:demo`, or with --build). Fails on any error the page reports, a missing
// sample project, or a view that shows an error. Screenshots go to --shots=<folder> (default target/demo-check).
// Takes about 15 s, a browser of its own with a throwaway profile; no window.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, problems, until } from "./cdp.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const dist = join(app, "dist-demo");
const SUB = "/w3proj-studio/";
const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice(8) ?? join(app, "..", "target", "demo-check");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

function findBrowser() {
  const found = [process.env.W3_SMOKE_BROWSER, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/microsoft-edge", "/usr/bin/chromium",
    join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe")].find((p) => p && existsSync(p));
  if (!found) throw new Error("no Chrome or Edge found; set W3_SMOKE_BROWSER");
  return found;
}

if (process.argv.includes("--build")) {
  if (spawnSync("npm run build:demo", { cwd: app, shell: true, stdio: "inherit" }).status !== 0) throw new Error("the build failed");
}
if (!existsSync(join(dist, "index.html"))) throw new Error("no app/dist-demo: run `npm run build:demo` or pass --build");

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // Only under the subpath: an absolute /assets/… URL in the build would 404 here, as it would on the site.
  if (!path.startsWith(SUB)) return void res.writeHead(404).end();
  const rel = path.slice(SUB.length) || "index.html";
  const file = join(dist, normalize(rel));
  if (!file.startsWith(dist) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const work = join(app, "..", "target", "demo-check-profile");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(shots, { recursive: true });
const browser = spawn(findBrowser(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${work}`, "--no-first-run", "--disable-extensions", "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
const limit = setTimeout(() => { console.error("FAIL demo-check took over 120 s"); browser.kill("SIGKILL"); process.exit(1); }, 120_000);
const found = [];
try {
  const portFile = join(work, "DevToolsActivePort");
  const port = await until("the browser", () => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0], 30_000);
  const page = await connect(port);
  const shot = async (name) => writeFileSync(join(shots, `${name}.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const text = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ""`);
  await page.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}${SUB}` });
  await until("the app", () => page.evaluate(`!!window.w3Workbench && document.querySelectorAll("button.activity").length > 0`), 30_000);
  await page.evaluate(`window.w3Started`);
  await until("the sample project", () => page.evaluate(`!!w3Workbench.workspace.project() && w3Workbench.workspace.files().length > 5`), 30_000);
  const banner = await text(".demo-banner");
  if (!/UI demo/.test(banner)) found.push("no demo banner");
  const bar = await page.evaluate(`JSON.stringify({ titlebar: !!document.querySelector(".titlebar"), menubar: !!document.querySelector(".menubar"), menubarInTitlebar: !!document.querySelector(".titlebar .menubar"), buttons: document.querySelectorAll(".titlebar-button").length, items: document.querySelectorAll(".menubar-item").length, ua: navigator.userAgent })`);
  const barState = JSON.parse(bar);
  if (!barState.menubarInTitlebar || barState.buttons !== 0) found.push(`title bar: menus missing, or window buttons shown (${bar})`);
  await shot("1-start");

  // [Refactored] Replace fixed 200 ms / 600 ms / 300 ms sleeps with condition waits + paint flushes (~5 s faster, non-flaky).
  const flushPaint = () => page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const views = await page.evaluate(`document.querySelectorAll("button.activity").length`);
  for (let i = 0; i < views; i++) {
    await page.evaluate(`document.querySelectorAll("button.activity")[${i}].click()`);
    await flushPaint();
    if (/Could not|is not a function|undefined/.test(await text(".sidebar"))) found.push(`side bar view ${i} shows an error`);
    await shot(`view-${i}`);
  }

  // Editors that run on the sample's own files.
  const opened = {};
  for (const path of ["map/triggers", "map/war3map.w3u.json", "map/war3map.j", "notes.txt", "README.md", "map/war3map.w3i.json"]) {
    try {
      await page.evaluate(`w3Workbench.editors.open(${JSON.stringify(path)})`);
      await until(`tab for ${path}`, () => page.evaluate(`w3Workbench.editors.activePath() === ${JSON.stringify(path)} && !!document.querySelector(".tab.active")`), 10_000);
      await flushPaint();
      opened[path] = await page.evaluate(`document.querySelector(".tab.active")?.innerText ?? ""`);
      await shot(`file-${path.replace(/[^a-z0-9]+/gi, "_")}`);
    } catch (e) { found.push(`opening ${path}: ${e?.message ?? e}`); }
  }
  // The Trigger Editor, on the made-up trigger definitions the demo serves: the tree, a trigger's parts and its folding.
  try {
    await page.evaluate(`w3Workbench.editors.open("map/triggers")`);
    const click = (label) => page.evaluate(`(() => { const el = [...document.querySelectorAll(".editor-area *")].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(label)}); if (el) el.click(); return !!el; })()`);
    await until("the trigger tree", () => page.evaluate(`document.body.innerText.includes("Demo Timers")`), 10_000);
    const tree = await page.evaluate(`document.body.innerText`);
    for (const name of ["Demo Setup", "Demo Init", "Demo Score", "Demo Tick", "Demo Chat", "Demo Timers"]) if (!tree.includes(name)) found.push(`trigger tree lacks "${name}"`);
    if (/needs the desktop app|Could not open/.test(tree)) found.push("the Trigger Editor shows a desktop-app error");
    await click("Demo Score");
    await until("the trigger's parts", () => page.evaluate(`document.body.innerText.includes("Score of")`), 10_000).catch(() => found.push("trigger Demo Score shows no parts"));
    const parts = await page.evaluate(`document.body.innerText`);
    for (const want of ["score becomes", "If - Conditions", "Then - Actions", "Else - Actions", "Add "]) if (!parts.includes(want)) found.push(`Demo Score lacks "${want}"`);
    await shot("trigger-score");
    // The ▾ in front of the category folds it.
    await page.evaluate(`[...document.querySelectorAll(".editor-area *")].find((e) => e.children.length === 0 && e.textContent.trim() === "\u25be")?.click()`);
    const folded = await until("category folded", () => page.evaluate(`!document.body.innerText.includes("Demo Init")`), 5_000).then(() => false, () => true);
    if (folded) found.push("a category does not fold");
    await flushPaint();
    await shot("trigger-folded");
  } catch (e) { found.push(`trigger editor: ${e?.message ?? e}`); }
  // The command palette and a theme.
  void page.evaluate(`w3Workbench.commands.execute("workbench.commandPalette")`);
  await until("command palette", () => page.evaluate(`document.querySelectorAll(".quickinput, .quick-input, .palette").length > 0`), 5_000).catch(() => {});
  await flushPaint();
  const palette = await page.evaluate(`document.querySelectorAll(".quickinput, .quick-input, .palette").length`);
  await shot("palette");
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  const refused = await page.evaluate(`window.__w3demoRefused`);
  console.log(`opened: ${JSON.stringify(opened)}\npalette elements: ${palette}\ncommands refused by the demo: ${JSON.stringify(refused)}`);
  for (const p of problems(page.events)) found.push(p);
  page.ws.close();
} finally {
  clearTimeout(limit);
  browser.kill();
  server.close();
}
for (const f of found) console.error(`FAIL ${f}`);
console.log(found.length ? `${found.length} problems` : `demo ok (screenshots: ${shots})`);
process.exit(found.length ? 1 : 0);
