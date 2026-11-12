#!/usr/bin/env node
// The open points (openpoints/*.md, local and git-ignored) as data, and their burndown.
//
//   node scripts/openpoints-burndown.mjs            snapshot now: write the JSON and the page, add an entry to the history
//   node scripts/openpoints-burndown.mjs --dry-run  print the counts, write nothing
//   node scripts/openpoints-burndown.mjs --no-entry write the JSON and the page, leave the history as it is
//   --dir PATH                                      another openpoints folder (default: the main checkout's)
//
// The Markdown files stay the source: people and agents edit them. An open point is a line starting `- [ ] `; the lines
// indented under it belong to it; the nearest `## ` / `### ` headings above it are its section. This writes:
//   openpoints/openpoints.json  every open point: file, section, text, a stable id (the same text keeps its id)
//   openpoints/burndown.json    the history: one entry per run, the counts per file and in total
//   openpoints/burndown.html    the chart, with its data inside, so it opens from disk without a server
// Two runs a minute apart give two entries; --no-entry refreshes the page without one.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The files and what they hold, in the order the chart stacks them. `active`: counted as work still to do. */
export const FILES = [
  { file: "bugs.md", label: "Bugs", active: true },
  { file: "features.md", label: "Features", active: true },
  { file: "lowprio-bugs.md", label: "Bugs (display, low)", active: true },
  { file: "lowprio-features.md", label: "Features (display, low)", active: true },
  { file: "engineering.md", label: "Engineering", active: true },
  { file: "test.md", label: "To test", active: true },
  { file: "user.md", label: "For the user", active: true },
  { file: "fable.md", label: "For Fable", active: true },
  { file: "blocked.md", label: "Blocked", active: false },
  { file: "onhold.md", label: "On hold", active: false },
];

/** The open points of one Markdown file. */
export function parsePoints(text, file) {
  const points = [];
  const heads = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const head = /^(#{2,3})\s+(.*)$/.exec(raw);
    if (head) {
      const level = head[1].length;
      heads.length = level - 2;
      heads[level - 2] = head[2].trim();
      current = null;
      continue;
    }
    const box = /^- \[( |x|X)\] (.*)$/.exec(raw);
    if (box) {
      current = { file, section: heads.filter(Boolean).join(" › "), done: box[1] !== " ", lines: [box[2]] };
      points.push(current);
      continue;
    }
    // A line indented under a point (or a blank line inside it) continues it; anything else ends it.
    if (current && /^\s+\S/.test(raw)) current.lines.push(raw.trim());
    else if (current && raw.trim() !== "") current = null;
  }
  return points.map((p) => {
    const text = p.lines.join(" ").replace(/\s+/g, " ").trim();
    const title = text.replace(/\*\*/g, "").replace(/`/g, "").slice(0, 140);
    return { id: idOf(file, text), file, section: p.section, done: p.done, title, text };
  });
}

/** A stable id: the file and the point's first 120 characters, so small edits further on keep it. */
export function idOf(file, text) {
  const key = `${file}\n${text.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase()}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 10);
}

/** Counts per file of the open points, and the totals. */
export function countsOf(points) {
  const byFile = Object.fromEntries(FILES.map((f) => [f.file, 0]));
  for (const p of points) if (!p.done && p.file in byFile) byFile[p.file]++;
  const active = FILES.filter((f) => f.active).reduce((n, f) => n + byFile[f.file], 0);
  const total = Object.values(byFile).reduce((a, b) => a + b, 0);
  return { byFile, active, total };
}

/** The main checkout's openpoints folder (from a worktree too: the first entry of `git worktree list`). */
function defaultDir(repo) {
  try {
    const first = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n")[0];
    const main = first.startsWith("worktree ") ? first.slice(9).trim() : repo;
    return join(main, "openpoints");
  } catch {
    return join(repo, "openpoints");
  }
}

function readHistory(file) {
  if (!existsSync(file)) return { entries: [] };
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data.entries)) throw new Error(`${file} has no "entries" list`);
  return data;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The page: a stacked burndown of the open points per file, the active total as a line, and the latest list. */
export function pageOf(history, points) {
  const data = JSON.stringify({ files: FILES, entries: history.entries }).replace(/</g, "\\u003c");
  const latest = history.entries.at(-1);
  const rows = FILES.map((f) => {
    const list = points.filter((p) => p.file === f.file && !p.done);
    const items = list.map((p) => `<li><span class="sec">${escapeHtml(p.section || "—")}</span> ${escapeHtml(p.title)}${p.text.length > 140 ? "…" : ""}</li>`).join("");
    return `<details><summary>${escapeHtml(f.label)} <span class="n">${list.length}</span></summary><ul>${items}</ul></details>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Points Burndown</title>
<style>
:root { --bg: #fafafa; --fg: #1f2328; --muted: #656d76; --grid: #d0d7de; --card: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --grid: #30363d; --card: #161b22; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 16px; }
.tiles { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.tile { background: var(--card); border: 1px solid var(--grid); border-radius: 8px; padding: 8px 12px; min-width: 110px; }
.tile b { display: block; font-size: 20px; } .tile span { color: var(--muted); font-size: 12px; }
.tile .d { font-size: 12px; } .up { color: #cf222e; } .down { color: #1a7f37; }
.card { background: var(--card); border: 1px solid var(--grid); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
svg { width: 100%; height: auto; display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--muted); margin-top: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
details { border-top: 1px solid var(--grid); padding: 6px 0; } summary { cursor: pointer; font-weight: 600; }
summary .n { color: var(--muted); font-weight: 400; } ul { margin: 6px 0 4px; padding-left: 18px; } li { margin: 2px 0; }
.sec { color: var(--muted); font-size: 12px; } #tip { position: fixed; pointer-events: none; background: var(--card); border: 1px solid var(--grid);
  border-radius: 6px; padding: 6px 8px; font-size: 12px; display: none; white-space: nowrap; }
</style></head><body><main>
<h1>Open points burndown</h1>
<p class="sub">From <code>openpoints/*.md</code>. Latest snapshot: ${escapeHtml(latest ? latest.time : "none")}. "Active" counts bugs, features (both also as low-priority display items), engineering, tests and the user's items; blocked and on hold are shown but not counted.</p>
<div class="tiles" id="tiles"></div>
<div class="card"><svg id="chart" viewBox="0 0 1000 420" role="img" aria-label="Open points over time"></svg><div class="legend" id="legend"></div></div>
<div class="card"><b>Open now</b>${rows}</div>
<div id="tip"></div>
</main>
<script>
const DATA = ${data};
const COLORS = { "bugs.md": "#d1242f", "features.md": "#0969da", "lowprio-bugs.md": "#ff8182", "lowprio-features.md": "#80ccff", "engineering.md": "#8250df", "test.md": "#bf8700", "user.md": "#1a7f37", "fable.md": "#a475f9", "blocked.md": "#6e7781", "onhold.md": "#afb8c1" };
const entries = DATA.entries, files = DATA.files;
const svg = document.getElementById("chart"), tip = document.getElementById("tip");
const W = 1000, H = 420, L = 48, R = 16, T = 16, B = 40;
const ns = "http://www.w3.org/2000/svg";
const el = (n, a) => { const e = document.createElementNS(ns, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
function draw() {
  svg.replaceChildren();
  if (!entries.length) return;
  const max = Math.max(...entries.map((e) => e.total)) * 1.08 || 1;
  // Spaced by time, so a snapshot an hour later sits closer than one a day later.
  const ts = entries.map((e) => Date.parse(e.time)), t0 = ts[0], span = ts.at(-1) - t0;
  const x = (i) => entries.length === 1 || !span ? (L + W - R) / 2 : L + ((ts[i] - t0) * (W - L - R)) / span;
  const y = (v) => H - B - (v * (H - T - B)) / max;
  const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted"), grid = getComputedStyle(document.documentElement).getPropertyValue("--grid");
  for (let g = 0; g <= 5; g++) {
    const v = Math.round((max * g) / 5);
    svg.append(el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: grid, "stroke-width": 1 }));
    const t = el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: muted }); t.textContent = v; svg.append(t);
  }
  // Stacked areas, the active files at the bottom.
  let base = entries.map(() => 0);
  for (const f of files) {
    const top = entries.map((e, i) => base[i] + (e.byFile[f.file] || 0));
    let d = entries.map((e, i) => (i ? "L" : "M") + x(i) + " " + y(top[i])).join(" ");
    d += " " + entries.map((e, i) => "L" + x(entries.length - 1 - i) + " " + y(base[entries.length - 1 - i])).join(" ") + " Z";
    svg.append(el("path", { d, fill: COLORS[f.file], "fill-opacity": f.active ? 0.55 : 0.25, stroke: "none" }));
    base = top;
  }
  const line = entries.map((e, i) => (i ? "L" : "M") + x(i) + " " + y(e.active)).join(" ");
  svg.append(el("path", { d: line, fill: "none", stroke: getComputedStyle(document.body).color, "stroke-width": 2.5 }));
  // Axis labels: one only where there's room; the newest always (it replaces a label too close before it).
  let lastLabel = null;
  entries.forEach((e, i) => {
    const dot = el("circle", { cx: x(i), cy: y(e.active), r: 4, fill: getComputedStyle(document.body).color });
    dot.addEventListener("mousemove", (ev) => {
      tip.style.display = "block"; tip.style.left = ev.clientX + 12 + "px"; tip.style.top = ev.clientY + 12 + "px";
      tip.innerHTML = "<b>" + e.time + "</b>" + (e.note ? "<br>" + e.note : "") + "<br>active " + e.active + ", total " + e.total + "<br>" +
        files.map((f) => f.label + ": " + (e.byFile[f.file] || 0)).join("<br>");
    });
    dot.addEventListener("mouseleave", () => { tip.style.display = "none"; });
    svg.append(dot);
    const newest = i === entries.length - 1;
    const room = !lastLabel || x(i) - lastLabel.x > 90;
    if (room || newest) {
      if (!room && lastLabel) lastLabel.node.remove();
      const anchor = entries.length > 1 && i === 0 ? "start" : entries.length > 1 && newest ? "end" : "middle";
      const t = el("text", { x: x(i), y: H - B + 16, "text-anchor": anchor, "font-size": 11, fill: muted }); t.textContent = e.time.slice(5, 16).replace("T", " "); svg.append(t);
      lastLabel = { x: x(i), node: t };
    }
  });
}
const last = entries.at(-1), prev = entries.at(-2);
const tile = (label, v, p) => { const d = p === undefined ? "" : v - p; const cls = d > 0 ? "up" : d < 0 ? "down" : "";
  return '<div class="tile"><span>' + label + "</span><b>" + v + '</b><span class="d ' + cls + '">' + (d === "" ? "" : (d > 0 ? "+" : "") + d + " since last") + "</span></div>"; };
if (last) document.getElementById("tiles").innerHTML = tile("Active", last.active, prev?.active) +
  files.map((f) => tile(f.label, last.byFile[f.file] || 0, prev?.byFile[f.file])).join("");
document.getElementById("legend").innerHTML = files.map((f) => '<span><i style="background:' + COLORS[f.file] + '"></i>' + f.label + "</span>").join("") +
  '<span><i style="background:currentColor;height:3px"></i>Active (line)</span>';
draw();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
</script></body></html>
`;
}

function main() {
  const args = process.argv.slice(2);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const di = args.indexOf("--dir");
  const dir = di >= 0 ? resolve(args[di + 1]) : defaultDir(repo);
  if (!existsSync(dir)) throw new Error(`no openpoints folder at ${dir}`);
  const present = new Set(readdirSync(dir));
  const points = FILES.filter((f) => present.has(f.file)).flatMap((f) => parsePoints(readFileSync(join(dir, f.file), "utf8"), f.file));
  const counts = countsOf(points);
  const time = new Date().toISOString().slice(0, 19) + "Z";
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify({ time, ...counts }, null, 2));
    return;
  }
  const historyFile = join(dir, "burndown.json");
  const history = readHistory(historyFile);
  if (!args.includes("--no-entry")) {
    history.entries.push({ time, ...counts });
    writeFileSync(historyFile, JSON.stringify(history, null, 2) + "\n");
  }
  writeFileSync(join(dir, "openpoints.json"), JSON.stringify({ generated: time, counts, points }, null, 2) + "\n");
  writeFileSync(join(dir, "burndown.html"), pageOf(history, points));
  console.log(`${args.includes("--no-entry") ? "refreshed" : "added an entry:"} active ${counts.active}, total ${counts.total} (${Object.entries(counts.byFile).map(([f, n]) => `${f.replace(".md", "")} ${n}`).join(", ")})`);
  console.log(`  ${join(dir, "burndown.html")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`openpoints-burndown: ${e.message}`); process.exit(1); }
}
