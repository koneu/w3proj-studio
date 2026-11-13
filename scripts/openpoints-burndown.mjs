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
//   openpoints/burndown-ids.json  the ids: the first snapshot's, then per snapshot what opened, closed and was edited (an id
//                               that went with a new one of at least 80% similar text, leading tags aside, is an edit), and the
//                               latest items' texts to compare the next run with; idsAt() rebuilds any snapshot's ids
// The three lines: to build (bugs, features, engineering, lowprio-*), to prove by agents (test.md without [game]/[windows]),
// waiting for the user (user.md, test.md [game]/[windows]); `[extra]` marks items outside the primary goal.
// Two runs a minute apart give two entries; --no-entry refreshes the page without one.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

/**
 * The open points of one Markdown file with their line ranges (`start`..`end`, 0-based, inclusive: the `- [ ]` line and
 * the indented lines under it, blank lines inside only when an indented line follows).
 */
export function parseBlocks(text, file) {
  const points = [];
  const heads = [];
  let current = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const head = /^(#{2,3})\s+(.*)$/.exec(raw);
    if (head) {
      const level = head[1].length;
      heads.length = level - 2;
      heads[level - 2] = head[2].trim();
      current = null;
      return;
    }
    const box = /^- \[( |x|X)\] (.*)$/.exec(raw);
    if (box) {
      current = { file, section: heads.filter(Boolean).join(" › "), done: box[1] !== " ", lines: [box[2]], start: i, end: i };
      points.push(current);
      return;
    }
    // A line indented under a point (or a blank line inside it) continues it; anything else ends it.
    if (current && /^\s+\S/.test(raw)) {
      current.lines.push(raw.trim());
      current.end = i;
    } else if (current && raw.trim() !== "") current = null;
  });
  return points.map((p) => {
    const text = p.lines.join(" ").replace(/\s+/g, " ").trim();
    const title = text.replace(/\*\*/g, "").replace(/`/g, "").slice(0, 140);
    return { id: idOf(file, text), file, section: p.section, done: p.done, title, text, tags: tagsOf(text), start: p.start, end: p.end };
  });
}

/** The open points of one Markdown file. */
export function parsePoints(text, file) {
  return parseBlocks(text, file).map(({ start, end, ...p }) => p);
}

/** The tags at the start of an item's text: `[we] [game] rest` gives ["we", "game"] (lower case). */
export function tagsOf(text) {
  const m = /^(?:\[[A-Za-z][\w-]*\]\s*)+/.exec(text.trim());
  return m ? [...m[0].matchAll(/\[([^\]]+)\]/g)].map((t) => t[1].toLowerCase()) : [];
}

const NOT_DONE_NOTE = /\s*\(not done: [^)]*\)/g;

/** The text without its leading tags and `(not done: …)` notes: what two versions of an item are compared by. */
export function bareText(text) {
  return text.replace(NOT_DONE_NOTE, "").trim().replace(/^(?:\[[A-Za-z][\w-]*\]\s*)+/, "").replace(/\s+/g, " ").toLowerCase();
}

/** A stable id: the file and the point's first 120 characters, so small edits further on keep it. */
export function idOf(file, text) {
  const key = `${file}\n${text.replace(NOT_DONE_NOTE, "").replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase()}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 10);
}

/** The three lines: what's left to build, to prove by agents, and what waits for the user. null: not counted. */
export const LINES = [
  { key: "build", label: "To build" },
  { key: "agents", label: "To prove by agents" },
  { key: "user", label: "Waiting for the user" },
];
const BUILD_FILES = new Set(["bugs.md", "features.md", "engineering.md", "lowprio-bugs.md", "lowprio-features.md"]);
export function lineOf(p) {
  if (p.done) return null;
  if (BUILD_FILES.has(p.file)) return "build";
  if (p.file === "user.md") return "user";
  if (p.file === "test.md") return p.tags.some((t) => t === "game" || t === "windows") ? "user" : "agents";
  return null;
}

/** Counts per file of the open points, the totals, the three lines, and the split by `[extra]`. */
export function countsOf(points) {
  const byFile = Object.fromEntries(FILES.map((f) => [f.file, 0]));
  for (const p of points) if (!p.done && p.file in byFile) byFile[p.file]++;
  const active = FILES.filter((f) => f.active).reduce((n, f) => n + byFile[f.file], 0);
  const total = Object.values(byFile).reduce((a, b) => a + b, 0);
  const lines = { build: 0, agents: 0, user: 0 };
  let extra = 0;
  for (const p of points) {
    const l = lineOf(p);
    if (!l) continue;
    lines[l]++;
    if (p.tags.includes("extra")) extra++;
  }
  return { byFile, active, total, lines, primary: lines.build + lines.agents + lines.user - extra, extra };
}

/** Similarity of two strings, 0..1 (1 minus the edit distance over the longer length). */
export function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  if (Math.min(a.length, b.length) / max < 0.8) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[b.length] / max;
}

export const EDIT_SIMILARITY = 0.8;
const COMPARE_LEN = 400;

/**
 * What changed between two snapshots of the open points (`{id, file, text}` each, open ones only). An id that went and a
 * new id that came are an edit (one item changed in its first 120 characters, or moved to another file) when their texts,
 * without leading tags, are at least 80% similar (edit distance over the first 400 characters); best pairs first, each
 * item in one pair. Left over: closed and opened.
 */
export function diffSnapshots(prev, cur) {
  const prevIds = new Set(prev.map((p) => p.id)), curIds = new Set(cur.map((p) => p.id));
  const gone = prev.filter((p) => !curIds.has(p.id));
  const came = cur.filter((p) => !prevIds.has(p.id));
  const pairs = [];
  const goneText = gone.map((p) => bareText(p.text).slice(0, COMPARE_LEN));
  const cameText = came.map((p) => bareText(p.text).slice(0, COMPARE_LEN));
  gone.forEach((g, i) => came.forEach((c, j) => {
    const s = similarity(goneText[i], cameText[j]);
    if (s >= EDIT_SIMILARITY) pairs.push({ i, j, s });
  }));
  pairs.sort((a, b) => b.s - a.s);
  const usedG = new Set(), usedC = new Set(), edited = [];
  for (const { i, j } of pairs) {
    if (usedG.has(i) || usedC.has(j)) continue;
    usedG.add(i);
    usedC.add(j);
    edited.push([gone[i].id, came[j].id]);
  }
  return {
    opened: came.filter((_, j) => !usedC.has(j)).map((p) => p.id),
    closed: gone.filter((_, i) => !usedG.has(i)).map((p) => p.id),
    edited,
  };
}

/** The ids open at snapshot `k` of an ids file (`base` plus the deltas up to k, each: opened, closed, edited pairs). */
export function idsAt(idsFile, k) {
  const set = new Set(idsFile.base.ids.split(" ").filter(Boolean));
  for (const d of idsFile.deltas.slice(0, k)) {
    for (const id of d.closed) set.delete(id);
    for (const [o, n] of d.edited) { set.delete(o); set.add(n); }
    for (const id of d.opened) set.add(id);
  }
  return set;
}

/** The main checkout's openpoints folder (from a worktree too: the first entry of `git worktree list`). */
export function defaultDir(repo) {
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
  const data = JSON.stringify({ files: FILES, lines: LINES, entries: history.entries }).replace(/</g, "\\u003c");
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
table { border-collapse: collapse; width: 100%; margin-top: 6px; } td, th { text-align: left; padding: 2px 8px 2px 0; font-size: 12px; }
.bar { display: inline-block; height: 8px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
.sec { color: var(--muted); font-size: 12px; } #tip { position: fixed; pointer-events: none; background: var(--card); border: 1px solid var(--grid);
  border-radius: 6px; padding: 6px 8px; font-size: 12px; display: none; white-space: nowrap; }
</style></head><body><main>
<h1>Open points burndown</h1>
<p class="sub">From <code>openpoints/*.md</code>. Latest snapshot: ${escapeHtml(latest ? latest.time : "none")}. "Active" counts bugs, features (both also as low-priority display items), engineering, tests and the user's items; blocked and on hold are shown but not counted.</p>
<div class="tiles" id="tiles"></div>
<div class="card"><svg id="chart" viewBox="0 0 1000 420" role="img" aria-label="Open points over time"></svg><div class="legend" id="legend"></div></div>
<div class="card"><b>Per day</b> (by id; an edited item is neither opened nor closed)<table id="days"></table></div>
<div class="card"><b>Open now</b>${rows}</div>
<div id="tip"></div>
</main>
<script>
const DATA = ${data};
const COLORS = { "bugs.md": "#d1242f", "features.md": "#0969da", "lowprio-bugs.md": "#ff8182", "lowprio-features.md": "#80ccff", "engineering.md": "#8250df", "test.md": "#bf8700", "user.md": "#1a7f37", "fable.md": "#a475f9", "blocked.md": "#6e7781", "onhold.md": "#afb8c1" };
const LINE_COLORS = { build: "#0550ae", agents: "#bc4c00", user: "#116329" };
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
  entries.length && ["build", "agents", "user"].forEach((k) => {
    const pts = entries.map((e, i) => [e, i]).filter(([e]) => e.lines);
    if (!pts.length) return;
    svg.append(el("path", { d: pts.map(([e, i], n) => (n ? "L" : "M") + x(i) + " " + y(e.lines[k])).join(" "), fill: "none", stroke: LINE_COLORS[k], "stroke-width": 2.5, "stroke-dasharray": k === "build" ? "" : k === "agents" ? "6 3" : "2 3" }));
  });
  const line = entries.map((e, i) => (i ? "L" : "M") + x(i) + " " + y(e.active)).join(" ");
  svg.append(el("path", { d: line, fill: "none", stroke: getComputedStyle(document.body).color, "stroke-width": 2.5 }));
  // Axis labels: one only where there's room; the newest always (it replaces a label too close before it).
  let lastLabel = null;
  entries.forEach((e, i) => {
    const dot = el("circle", { cx: x(i), cy: y(e.active), r: 4, fill: getComputedStyle(document.body).color });
    dot.addEventListener("mousemove", (ev) => {
      tip.style.display = "block"; tip.style.left = ev.clientX + 12 + "px"; tip.style.top = ev.clientY + 12 + "px";
      tip.innerHTML = "<b>" + e.time + "</b>" + (e.note ? "<br>" + e.note : "") + "<br>active " + e.active + ", total " + e.total + (e.lines ? "<br>build " + e.lines.build + ", agents " + e.lines.agents + ", user " + e.lines.user + "<br>primary " + e.primary + ", extra " + e.extra : "") + "<br>" +
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
  (last.lines ? DATA.lines.map((l) => tile(l.label, last.lines[l.key], prev?.lines?.[l.key])).join("") + tile("Primary goal", last.primary, prev?.primary) + tile("Extra", last.extra, prev?.extra) : "") +
  files.map((f) => tile(f.label, last.byFile[f.file] || 0, prev?.byFile[f.file])).join("");
document.getElementById("legend").innerHTML = files.map((f) => '<span><i style="background:' + COLORS[f.file] + '"></i>' + f.label + "</span>").join("") +
  '<span><i style="background:currentColor;height:3px"></i>Active (line)</span>' +
  DATA.lines.map((l) => '<span><i style="background:' + LINE_COLORS[l.key] + ';height:3px"></i>' + l.label + " (line)</span>").join("");
{
  const days = new Map();
  for (const e of entries) {
    if (e.opened === undefined) continue;
    const d = days.get(e.time.slice(0, 10)) || { o: 0, c: 0, ed: 0 };
    d.o += e.opened; d.c += e.closed; d.ed += e.edited; days.set(e.time.slice(0, 10), d);
  }
  const m = Math.max(1, ...[...days.values()].flatMap((d) => [d.o, d.c]));
  document.getElementById("days").innerHTML = "<tr><th>Day</th><th>Opened</th><th>Closed</th><th>Edited</th></tr>" + [...days].reverse().map(([day, d]) =>
    "<tr><td>" + day + '</td><td><i class="bar" style="background:#cf222e;width:' + (d.o * 120) / m + 'px"></i>' + d.o + '</td><td><i class="bar" style="background:#1a7f37;width:' + (d.c * 120) / m + 'px"></i>' + d.c + "</td><td>" + d.ed + "</td></tr>").join("");
}
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
    const entry = { time, ...counts };
    const idsPath = join(dir, "burndown-ids.json");
    const open = points.filter((p) => !p.done).map((p) => ({ id: p.id, file: p.file, text: p.text.slice(0, 400) }));
    const ids = existsSync(idsPath) ? JSON.parse(readFileSync(idsPath, "utf8")) : { base: { time, ids: open.map((p) => p.id).join(" ") }, deltas: [] };
    if (existsSync(idsPath)) {
      const d = diffSnapshots(ids.last, open);
      ids.deltas.push({ time, ...d });
      Object.assign(entry, { opened: d.opened.length, closed: d.closed.length, edited: d.edited.length });
    }
    ids.last = open;
    writeFileSync(idsPath, JSON.stringify(ids) + "\n");
    history.entries.push(entry);
    writeFileSync(historyFile, JSON.stringify(history, null, 2) + "\n");
  }
  writeFileSync(join(dir, "openpoints.json"), JSON.stringify({ generated: time, counts, points }, null, 2) + "\n");
  writeFileSync(join(dir, "burndown.html"), pageOf(history, points));
  console.log(`${args.includes("--no-entry") ? "refreshed" : "added an entry:"} active ${counts.active}, total ${counts.total} (${Object.entries(counts.byFile).map(([f, n]) => `${f.replace(".md", "")} ${n}`).join(", ")})`);
  console.log(`  ${join(dir, "burndown.html")}`);
}

if (process.argv[1] && basename(process.argv[1]) === "openpoints-burndown.mjs") {
  try { main(); } catch (e) { console.error(`openpoints-burndown: ${e.message}`); process.exit(1); }
}
