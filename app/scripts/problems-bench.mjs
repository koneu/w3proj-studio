// Times the Problems checks in the real app (hidden window, own settings folder) on real maps, and
// writes every problem found, so two builds can be held against each other.
//
//   node scripts/problems-bench.mjs --out=<file.json> [--runs=3] [--profile=<dir>] [--no-build] <map.w3x|project dir>...
//   node scripts/problems-bench.mjs --compare <a.json> <b.json>    same problems, same order, same text?
//
// Maps are unpacked (with the release CLI, W3PROJ_BIN) into a scratch folder first; a project folder is
// copied. Needs W3PROJ_GAME. W3_SMOKE_ID picks the identifier (and settings folder) as in app-smoke.
// Per run: the time of each check (the service's "problems:<id>" measures), the backend commands it
// called (count and time), and the problems with their fixes' labels. --profile writes a CPU profile
// of each map's first run.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, problems, sleep, until } from "./cdp.mjs";
import { chosenGamePath } from "../../tests/gamepath.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "..");
const exeName = process.platform === "win32" ? ".exe" : "";
// W3_BENCH_EXE: another build (a copy of an older one, made the same way), to hold against this one.
const exe = process.env.W3_BENCH_EXE ?? join(repo, "target", "debug", `w3proj-studio${exeName}`);
const cli = process.env.W3PROJ_BIN ?? join(repo, "target", "release", `w3proj${exeName}`);
const IDENTIFIER = process.env.W3_SMOKE_ID ?? "dev.w3proj.studio.smoke";
const work = process.env.W3_BENCH_DIR ?? join(tmpdir(), `problems-bench-${IDENTIFIER}`);
const game = chosenGamePath();

const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const inputs = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (process.argv.includes("--compare")) {
  const [a, b] = inputs.map((f) => JSON.parse(readFileSync(f, "utf8")));
  let diffs = 0;
  for (const name of new Set([...Object.keys(a.maps), ...Object.keys(b.maps)])) {
    const x = a.maps[name]?.runs ?? [], y = b.maps[name]?.runs ?? [];
    if (!x.length || !y.length) { console.log(`DIFF ${name}: only in one file`); diffs++; continue; }
    // Every run of both files has to give the same list.
    const lists = [...x, ...y].map((r) => JSON.stringify(r.problems));
    const bad = lists.findIndex((l) => l !== lists[0]);
    if (bad >= 0) {
      diffs++;
      const p = JSON.parse(lists[0]), q = JSON.parse(lists[bad]);
      const at = p.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(q[i]));
      console.log(`DIFF ${name} (run ${bad}): ${p.length} vs ${q.length} problems, first difference at ${at}:\n  ${JSON.stringify(p[at])}\n  ${JSON.stringify(q[at])}`);
    } else console.log(`same ${name}: ${JSON.parse(lists[0]).length} problems, ${lists.length} runs`);
  }
  process.exit(diffs ? 1 : 0);
}

if (!game) throw new Error("W3PROJ_GAME is needed: the checks look things up in the game's data");
const out = opt("out");
if (!out || !inputs.length) throw new Error("usage: --out=<file.json> <map or project>...");
const runs = Number(opt("runs", "3"));
const profileDir = opt("profile");

function build() {
  const conf = JSON.parse(readFileSync(join(app, "src-tauri", "tauri.conf.json"), "utf8"));
  const windows = conf.app.windows.map((w) => ({ ...w, visible: false }));
  const patch = join(work, "tauri.bench.json");
  writeFileSync(patch, JSON.stringify({ identifier: IDENTIFIER, app: { windows }, build: { beforeBuildCommand: "npm run build" } }));
  const r = spawnSync(`npx tauri build --debug --no-bundle --config "${patch}"`, { cwd: app, shell: true, stdio: "inherit" });
  if (r.status !== 0) throw new Error("the build failed");
}

const freePort = () => new Promise((done) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); });
});

/** The projects to check: maps unpacked, project folders copied (the originals stay untouched). */
function projects() {
  const list = [];
  for (const input of inputs) {
    const name = basename(input).replace(/\.w3[xm]$/i, "");
    const dir = join(work, "projects", name);
    rmSync(dir, { recursive: true, force: true });
    if (statSync(input).isDirectory()) cpSync(input, dir, { recursive: true });
    else {
      const r = spawnSync(cli, ["unpack", input, dir, "--game", game], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`unpacking ${input}: ${r.stderr}`);
    }
    list.push({ name, dir });
  }
  return list;
}

/** In the page: counts and times every backend command from now on. */
// Tauri's invoke can't be replaced (a read-only property); every call goes out as a fetch of
// http://ipc.localhost/<command>, so that is where they are counted.
const COUNT_INVOKES = `(() => {
  if (!window.__benchFetch) {
    const original = window.__benchFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = String(input?.url ?? input);
      const m = /^https?:\\/\\/ipc\\.localhost\\/([^?]+)/.exec(url) ?? /^ipc:\\/\\/localhost\\/([^?]+)/.exec(url);
      const p = original.call(window, input, init);
      if (!m) return p;
      const s = (window.__bench ??= {})[decodeURIComponent(m[1])] ??= { n: 0, ms: 0 };
      s.n++;
      const started = performance.now();
      p.then(() => { s.ms += performance.now() - started; }, () => { s.ms += performance.now() - started; });
      return p;
    };
  }
  window.__bench = {};
  return true;
})()`;

/** In the page: one run of every check through the service, as the view and list_problems run them. */
const RUN = `(async () => {
  performance.clearMeasures();
  window.__bench = {};
  const started = performance.now();
  const found = await (await w3.services.get("w3.problems")).run();
  const total = performance.now() - started;
  const checks = Object.fromEntries(performance.getEntriesByType("measure").filter((m) => m.name.startsWith("problems:")).map((m) => [m.name.slice(9), Math.round(m.duration)]));
  return {
    total: Math.round(total), checks, invokes: window.__bench,
    problems: found.map((p) => ({ severity: p.severity, message: p.message, location: p.location ?? null, reveal: p.reveal ?? null, fixes: (p.fixes ?? []).map((f) => [f.label, f.title ?? null]) })),
  };
})()`;

async function main() {
  mkdirSync(work, { recursive: true });
  if (!process.argv.includes("--no-build") && !process.env.W3_BENCH_EXE) build();
  if (!existsSync(exe)) throw new Error(`no app at ${exe}: run without --no-build`);
  const list = projects();
  const result = { identifier: IDENTIFIER, maps: {} };
  // A fresh app per map: its first run is the cold one (the game's data not yet loaded), as after a start.
  for (const { name, dir } of list) result.maps[name] = await bench(name, dir);
  writeFileSync(out, JSON.stringify(result, null, 1));
}

async function bench(name, dir) {
  const configDir = join(process.env.APPDATA ?? join(process.env.HOME ?? "", ".config"), IDENTIFIER);
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ "mcp.enabled": false, "game.installDir": game }));
  const port = await freePort();
  const child = spawn(exe, [], {
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  });
  const entry = { runs: [] };
  try {
    const page = await connect(port);
    await until("the app to start", () => page.evaluate(`!!window.w3 && document.querySelectorAll("button.activity").length > 0`));
    await page.evaluate(`(async () => { const h = w3Workbench.host; await Promise.all(h.extensions.filter((e) => !e.disabled).map((e) => h.activate(e))); })()`);
    if (!(await page.evaluate(COUNT_INVOKES))) throw new Error("backend calls can't be counted");
    await page.evaluate(`w3.workspace.open(${JSON.stringify(dir)})`);
    await until("the project", () => page.evaluate(`w3.workspace.project()?.root != null`));
    await sleep(1000);
    for (let i = 0; i < runs; i++) {
      const profile = profileDir && i < 2;
      if (profile) { await page.send("Profiler.enable"); await page.send("Profiler.setSamplingInterval", { interval: 200 }); await page.send("Profiler.start"); }
      const r = await page.evaluate(RUN);
      if (profile) {
        const { profile: p } = await page.send("Profiler.stop");
        mkdirSync(profileDir, { recursive: true });
        writeFileSync(join(profileDir, `${name}-run${i + 1}.cpuprofile`), JSON.stringify(p));
        r.selfTime = topSelf(p);
      }
      entry.runs.push(r);
      const calls = Object.values(r.invokes).reduce((n, s) => n + s.n, 0);
      // Every run reads the project's files at least: none counted means the counting is broken.
      if (!calls) throw new Error("no backend calls were counted");
      console.log(`${name} run ${i + 1}: ${r.total} ms, ${r.problems.length} problems, ${calls} backend calls; ${Object.entries(r.checks).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
    const errors = problems(page.events);
    if (errors.length) entry.pageErrors = errors;
    for (const e of errors) console.error(`page: ${e}`);
    page.ws.close();
  } finally {
    const exited = new Promise((done) => { if (child.exitCode !== null) done(); else child.once("exit", done); });
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    // WebView2's helpers outlive the app by a moment.
    await sleep(1000);
    rmSync(configDir, { recursive: true, force: true });
  }
  return entry;
}

/** The functions with the most self time in a CPU profile (ms), idle and "program" left out. */
function topSelf(p) {
  const self = new Map();
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const dt = p.timeDeltas;
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i]);
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  }
  return [...self].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Math.round(v)]);
}

await main();
