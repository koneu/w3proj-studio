// Runs the TypeScript unit tests (src/**/*.test.ts, and scripts/*.test.mjs for the tooling) with
// Node's test runner: each test file is bundled with esbuild (the app's imports are extensionless
// TypeScript) into node_modules/.cache/w3-tests, or W3_TEST_OUT (coverage needs them outside
// node_modules), and run with `node --test`. Test files given as arguments run alone (`npm test --
// src/lib/undo.test.ts`); other arguments go to node (e.g. `npm test -- --test-name-pattern=undo`).

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const out = process.env.W3_TEST_OUT ?? join(app, "node_modules", ".cache", "w3-tests");

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
process.exit(run.status ?? 1);
