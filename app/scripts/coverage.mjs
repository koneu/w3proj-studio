// Line coverage of the TypeScript sources: `npm run coverage`.
//
// The tests run as esbuild bundles, which the ready-made tools get wrong: `node
// --experimental-test-coverage` reports "100%" of nothing, and c8 counts every line of a bundled
// file as covered. So this reads V8's raw coverage and the bundles' source maps directly:
//
//   numerator    lines of a source file all of whose code ran, in any test bundle
//   denominator  lines that produce code when the file is compiled alone, for EVERY file under
//                src/, so a file no test imports counts as 0% instead of disappearing
//
// Flags: --json <file> writes the numbers; --check compares them with tests/coverage-floor.json;
// --update-floor raises the floors to the current numbers (--lower also lets them drop).

import { build, transform } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LineHits, characterCounts, decodeMappings, percent } from "./coverage-core.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const repo = join(app, "..");
const src = join(app, "src");
const work = join(repo, "target", "cov-ts");
const floorFile = join(repo, "tests", "coverage-floor.json");

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** Original lines that produce code, compiling the file by itself (no tree shaking). */
async function codeLines(file) {
  const r = await transform(readFileSync(file, "utf8"), { loader: "ts", sourcemap: "external", sourcefile: file, target: "esnext" });
  return new Set(decodeMappings(JSON.parse(r.map).mappings).map((m) => m[3]));
}

function runTests(out, raw) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const run = spawnSync(process.execPath, [join(app, "scripts", "test.mjs"), "--test-reporter=dot"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, W3_TEST_OUT: out, NODE_V8_COVERAGE: raw },
  });
  if (run.status !== 0) throw new Error("the tests failed; coverage would mean nothing");
}

/** What ran, from the raw V8 reports of the test bundles. */
function collect(raw, out) {
  const hits = new LineHits();
  for (const name of readdirSync(raw)) {
    const report = JSON.parse(readFileSync(join(raw, name), "utf8"));
    for (const script of report.result) {
      if (!script.url.startsWith("file:")) continue;
      const path = fileURLToPath(script.url);
      if (!resolve(path).startsWith(resolve(out))) continue;
      const map = report["source-map-cache"]?.[script.url]?.data;
      if (!map) throw new Error(`no source map for ${path}`);
      const text = readFileSync(path, "utf8");
      const counts = characterCounts(text.length, script.functions);
      const starts = lineStarts(text);
      const sources = map.sources.map((s) => (s.startsWith("file:") ? fileURLToPath(s) : resolve(path, "..", s)));
      for (const [genLine, genCol, source, origLine, origCol] of decodeMappings(map.mappings)) {
        const file = sources[source];
        if (file.startsWith(src)) hits.add(file, origLine, origCol, counts[starts[genLine] + genCol] > 0);
      }
    }
  }
  return hits;
}

async function measure() {
  const out = join(work, "bundles"), raw = join(work, "raw");
  runTests(out, raw);
  const hits = collect(raw, out);
  if (!hits.files.size) throw new Error("no coverage was collected");
  const files = {};
  for (const file of walk(src).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const code = await codeLines(file);
    files[relative(src, file).replaceAll("\\", "/")] = { lines: code.size, covered: hits.covered(file, code) };
  }
  return files;
}

/** Totals by area: all of it, the layers of the app, and each folder of lib/ and builtin/. */
function byArea(files) {
  const areas = {};
  const add = (name, f) => {
    const a = (areas[name] ??= { lines: 0, covered: 0 });
    a.lines += f.lines;
    a.covered += f.covered;
  };
  for (const [path, f] of Object.entries(files)) {
    const parts = path.split("/");
    add("(all)", f);
    add(parts[0], f);
    if (parts.length > 2) add(`${parts[0]}/${parts[1]}`, f);
  }
  return areas;
}

function checkFloors(areas) {
  const floors = JSON.parse(readFileSync(floorFile, "utf8")).ts;
  const low = Object.entries(floors).filter(([k, v]) => percent(areas[k] ?? { lines: 0, covered: 0 }) < v);
  for (const [k, v] of low) console.error(`coverage of ${k} is ${percent(areas[k] ?? { lines: 0, covered: 0 }).toFixed(1)}%, below its floor of ${v}%`);
  return low.length === 0;
}

function updateFloors(areas, lower) {
  const all = JSON.parse(readFileSync(floorFile, "utf8"));
  for (const [k, v] of Object.entries(all.ts)) {
    const now = Math.floor(percent(areas[k]) * 10) / 10;
    all.ts[k] = lower ? now : Math.max(v, now);
  }
  writeFileSync(floorFile, JSON.stringify(all, null, 2) + "\n");
}

const args = process.argv.slice(2);
const files = await measure();
const areas = byArea(files);
const width = Math.max(...Object.keys(areas).map((k) => k.length));
for (const [name, a] of Object.entries(areas).sort(([x], [y]) => x.localeCompare(y))) {
  console.log(`${name.padEnd(width)}  ${percent(a).toFixed(1).padStart(5)}%  ${String(a.covered).padStart(6)} / ${a.lines}`);
}
const json = args.indexOf("--json");
if (json >= 0) writeFileSync(args[json + 1], JSON.stringify({ areas, files }, null, 2));
if (args.includes("--update-floor")) updateFloors(areas, args.includes("--lower"));
if (args.includes("--check") && !checkFloors(areas)) process.exit(1);
