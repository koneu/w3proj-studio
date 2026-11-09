// Runs the TypeScript unit tests (src/**/*.test.ts, and scripts/*.test.mjs for the tooling) with
// Node's test runner: each test file is bundled with esbuild (the app's imports are extensionless
// TypeScript) into a folder of this run's own, node_modules/.cache/w3-tests/run-<pid> (removed after
// the run; two runs in one checkout, e.g. the gate's and an `npm test` beside it, don't clobber each
// other), or W3_TEST_OUT (coverage needs them outside node_modules, and kept), and run with `node
// --test`. Test files given as arguments run alone (`npm test -- src/lib/undo.test.ts`); other
// arguments go to node (e.g. `npm test -- --test-name-pattern=undo`).

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const cache = join(app, "node_modules", ".cache", "w3-tests");
const own = process.env.W3_TEST_OUT === undefined;
const out = own ? join(cache, `run-${process.pid}`) : process.env.W3_TEST_OUT;

/** Whether a process is still there (a run's folder whose process is gone is left over, e.g. from Ctrl+C). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
if (own) {
  mkdirSync(cache, { recursive: true });
  for (const name of readdirSync(cache)) {
    const pid = /^run-(\d+)$/.exec(name)?.[1];
    if (pid && Number(pid) !== process.pid && !alive(Number(pid))) rmSync(join(cache, name), { recursive: true, force: true });
  }
}

const tests = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.test\.m?ts$/.test(e.name) || e.name.endsWith(".test.mjs")) tests.push(p);
  }
};
walk(join(app, "src"));
walk(join(app, "scripts"));
// Test files named among the arguments (`npm test -- src/lib/undo.test.ts`) run alone; the rest go to node.
const args = [], only = new Set();
for (const a of process.argv.slice(2)) {
  if (/\.test\.m?[tj]s$/.test(a) && !a.startsWith("-")) only.add(resolve(process.cwd(), a));
  else args.push(a);
}
if (only.size) {
  const missing = [...only].filter((t) => !tests.includes(t));
  if (missing.length) { console.error(`no such test file: ${missing.join(", ")}`); process.exit(1); }
  tests.splice(0, tests.length, ...only);
}
if (!tests.length) { console.log("no tests"); process.exit(0); }

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: tests,
  outdir: out,
  outbase: app,
  bundle: true,
  platform: "node",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  sourcemap: "inline",
  logLevel: "error",
  // As Vite does: "file?raw" is the file's text.
  plugins: [{
    name: "raw",
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw" }));
      b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
    },
  }],
});
const bundles = tests.map((t) => join(out, relative(app, t)).replace(/\.m?ts$|\.mjs$/, ".mjs"));
const run = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...args, ...bundles], { stdio: "inherit" });
if (own) rmSync(out, { recursive: true, force: true });
process.exit(run.status ?? 1);
