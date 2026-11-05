// Runs the TypeScript unit tests (src/**/*.test.ts) with Node's test runner: each test file
// is bundled with esbuild (the app's imports are extensionless TypeScript) into
// node_modules/.cache/w3-tests and run with `node --test`. Extra arguments go to node
// (e.g. `npm test -- --test-name-pattern=undo`).

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const out = join(app, "node_modules", ".cache", "w3-tests");

const tests = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".test.ts")) tests.push(p);
  }
};
walk(join(app, "src"));
if (!tests.length) { console.log("no tests"); process.exit(0); }

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: tests,
  outdir: out,
  outbase: join(app, "src"),
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
const bundles = tests.map((t) => join(out, relative(join(app, "src"), t)).replace(/\.ts$/, ".mjs"));
const run = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...process.argv.slice(2), ...bundles], { stdio: "inherit" });
process.exit(run.status ?? 1);
