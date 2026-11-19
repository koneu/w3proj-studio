// Counts the fixed pauses of the we-compare specs by what they follow:
//
//   node scripts/we-sleeps.mjs [--json] [spec.json…]     (default: every tests/we-compare/*.json)
//
// we side: `--sleep MS` steps of a spec's "we" steps, by the step before (and after, for "before a picture"):
//   open     --map, --open, --start, --wait-ready, --compare-ready…   key   --key, --type, --numlock
//   click    --click, --double-click, --drag, --move, --wheel         menu  --view, --view-menu, --game-view, --close-modules
//   picture  the next step takes a picture or reads the clipboard     sleep another --sleep before it
//   other    anything else (first step, --windows, --fps…)
// Studio side: `{ "sleep": MS }` steps by the step before: open, command, eval, mcp, ui, setting, terrain, sleep, first.
// The totals are in steps and in milliseconds. "Waiting" in a run comes from these plus the fixed waits inside
// we-drive's own steps (300 ms after a key or click…), which this doesn't count.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const WE_KINDS = [
  ["open", /^--(map|open|start|wait-ready|compare-ready|compare-ready-unlit)$/],
  ["key", /^--(key|type|numlock)$/],
  ["click", /^--(click|double-click|drag|move|wheel)$/],
  ["menu", /^--(view|view-menu|game-view|close-modules)$/],
];
const WE_PICTURE = /^--(shot|shot-window|shot-screen|clipboard|look|export-minimap|fps)$/;

/** A we step as [name, value]: "--key d" or ["--key", "d"] or ["--close-modules"]. */
export function weStep(s) {
  if (Array.isArray(s)) return [String(s[0]), s[1]];
  const i = String(s).indexOf(" ");
  return i < 0 ? [String(s), undefined] : [s.slice(0, i), s.slice(i + 1)];
}

/** What a `--sleep` at index `i` of the we steps follows. */
export function weKind(steps, i) {
  const next = i + 1 < steps.length ? weStep(steps[i + 1])[0] : "";
  if (WE_PICTURE.test(next)) return "picture";
  if (i === 0) return "other";
  const prev = weStep(steps[i - 1])[0];
  if (prev === "--sleep") return "sleep";
  for (const [kind, re] of WE_KINDS) if (re.test(prev)) return kind;
  return "other";
}

/** What a Studio `sleep` at index `i` follows: the key of the step before it. */
export function studioKind(steps, i) {
  if (i === 0) return "first";
  const prev = Object.keys(steps[i - 1])[0];
  return ["open", "command", "eval", "mcp", "ui", "setting", "terrain", "sleep"].includes(prev) ? prev : "other";
}

function bump(map, kind, ms) {
  const e = (map[kind] ??= { steps: 0, ms: 0 });
  e.steps++;
  e.ms += ms;
}

/** The inventory of spec objects: { we: { kind: {steps, ms} }, studio: {…}, specs, withSleep }. */
export function inventory(specs) {
  const r = { specs: specs.length, withSleep: 0, we: {}, studio: {} };
  for (const spec of specs) {
    let any = false;
    const we = spec.we?.steps ?? [];
    we.forEach((s, i) => {
      const [name, v] = weStep(s);
      if (name === "--sleep") { bump(r.we, weKind(we, i), Number(v)); any = true; }
    });
    const st = spec.studio?.steps ?? [];
    st.forEach((s, i) => {
      if (s.sleep !== undefined) { bump(r.studio, studioKind(st, i), s.sleep); any = true; }
    });
    if (any) r.withSleep++;
  }
  return r;
}

export function readSpecs(files) {
  return files.flatMap((f) => { const j = JSON.parse(readFileSync(f, "utf8")); return Array.isArray(j) ? j : [j]; });
}

function table(side, m) {
  const total = Object.values(m).reduce((a, e) => ({ steps: a.steps + e.steps, ms: a.ms + e.ms }), { steps: 0, ms: 0 });
  const rows = Object.entries(m).sort((a, b) => b[1].ms - a[1].ms).map(([k, e]) => `  ${side.padEnd(7)} ${k.padEnd(8)} ${String(e.steps).padStart(5)} steps ${String(Math.round(e.ms / 100) / 10).padStart(8)} s`);
  return [...rows, `  ${side.padEnd(7)} ${"total".padEnd(8)} ${String(total.steps).padStart(5)} steps ${String(Math.round(total.ms / 100) / 10).padStart(8)} s`];
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "we-sleeps.mjs") {
  const args = process.argv.slice(2), json = args.includes("--json");
  let files = args.filter((a) => !a.startsWith("--")).map((a) => resolve(a));
  if (!files.length) {
    const dir = join(HERE, "..", "..", "tests", "we-compare");
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "differs-without-paths.json").map((f) => join(dir, f));
  }
  const inv = inventory(readSpecs(files));
  if (json) console.log(JSON.stringify(inv, null, 2));
  else console.log([`${inv.specs} specs, ${inv.withSleep} with a fixed sleep`, ...table("we", inv.we), ...table("studio", inv.studio)].join("\n"));
}
