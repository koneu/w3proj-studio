#!/usr/bin/env node
// Applies testers' verdicts to the open points (openpoints/*.md, local and git-ignored).
//
//   node scripts/openpoints-close.mjs <verdicts-file> [--dry-run] [--dir PATH]
//
// A verdict is a line `<id>: PASS | FAIL | DIFFERS | NOT DONE — <text>` (id as in openpoints.json; other lines are ignored):
//   PASS      the item (its `- [ ]` line and the indented lines under it) is removed from its file
//   FAIL      a one-line item goes to bugs.md, section "From verification", with the text and a pointer to the old item
//   DIFFERS   the same
//   NOT DONE  `(not done: <reason>, <date>)` is added to the end of the item; the second one moves the item to user.md
//             (when it's tagged [game]/[windows] or the reason names the user, the game or Windows) or else to onhold.md;
//             an item already in user.md goes on to onhold.md, one already in onhold.md stays
// Nothing is changed when an id isn't found (or is ambiguous); they are listed and the exit code is 1. Every file that
// changes is first copied to openpoints/.backup/<timestamp>/. Other items' text is never touched. --dry-run prints the plan.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, defaultDir, parseBlocks } from "./openpoints-burndown.mjs";

const SECTION = "From verification";
const NOTE = /\(not done: [^)]*\)/g;

/** The verdict lines of a file: `{id, verdict, text}`; lines that aren't verdicts are skipped. */
export function parseVerdicts(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*`?([0-9a-f]{10})`?\s*:\s*(PASS|FAIL|DIFFERS|NOT DONE)\b\s*(?:[—–-]+\s*(.*?))?\s*$/i.exec(raw);
    if (m) out.push({ id: m[1].toLowerCase(), verdict: m[2].toUpperCase(), text: m[3] ?? "" });
  }
  return out;
}

/** A reason as it goes into the note: one line, no parentheses (they end the note). */
const cleanReason = (s) => s.replace(/\s+/g, " ").replace(/[()]/g, (c) => (c === "(" ? "[" : "]")).trim() || "no reason given";

function findItems(files, id) {
  const found = [];
  for (const [file, text] of files) for (const p of parseBlocks(text, file)) if (p.id === id) found.push(p);
  return found;
}

/** Inserts item lines at the end of the `## From verification` section of `text` (made at the end when missing). */
function addToSection(text, itemLines, eol) {
  const lines = text.split(/\r?\n/);
  let fresh = false;
  let head = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim() === SECTION);
  if (head < 0) {
    while (lines.length && lines.at(-1).trim() === "") lines.pop();
    lines.push("", `## ${SECTION}`, "");
    head = lines.length - 2;
    fresh = true;
  }
  let end = head + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  let at = end;
  while (at > head + (fresh ? 2 : 1) && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, ...itemLines);
  if (at === lines.length - itemLines.length) lines.push("");
  return lines.join(eol);
}

/**
 * Plans and applies verdicts to `files` (Map file name to text). Returns `{files, plan, problems}`: `files` is the new
 * map (the input when `problems` isn't empty), `plan` one line per verdict.
 */
export function applyVerdicts(files, verdicts, date) {
  const problems = [], plan = [];
  const seen = new Set();
  for (const v of verdicts) {
    if (seen.has(v.id)) problems.push(`${v.id}: more than one verdict`);
    seen.add(v.id);
    const found = findItems(files, v.id);
    if (found.length === 0) problems.push(`${v.id}: not found`);
    else if (found.length > 1) problems.push(`${v.id}: ambiguous (${found.map((f) => f.file).join(", ")})`);
    if ((v.verdict === "FAIL" || v.verdict === "DIFFERS") && !v.text) problems.push(`${v.id}: ${v.verdict} needs a text`);
  }
  if (problems.length) return { files, plan, problems };
  const next = new Map(files);
  const eolOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n");
  const write = (file, text) => next.set(file, text);
  for (const v of verdicts) {
    const p = findItems(next, v.id)[0];
    const text = next.get(p.file);
    const eol = eolOf(text);
    const lines = text.split(/\r?\n/);
    const block = lines.slice(p.start, p.end + 1);
    const label = p.title.slice(0, 60);
    if (v.verdict === "PASS") {
      lines.splice(p.start, p.end - p.start + 1);
      write(p.file, lines.join(eol));
      plan.push(`${v.id} PASS: remove from ${p.file}: ${label}`);
    } else if (v.verdict === "FAIL" || v.verdict === "DIFFERS") {
      const item = `- [ ] ${v.text.replace(/\s+/g, " ")} (verification ${v.verdict} of ${v.id} in ${p.file}: "${label}", ${date})`;
      const bugs = next.get("bugs.md") ?? "# Open points: bugs\n";
      write("bugs.md", addToSection(bugs, [item], eolOf(bugs)));
      plan.push(`${v.id} ${v.verdict}: new item in bugs.md "${SECTION}": ${v.text.slice(0, 60)}`);
    } else {
      const count = (block.join(" ").match(NOTE) ?? []).length + 1;
      block[block.length - 1] += ` (not done: ${cleanReason(v.text)}, ${date})`;
      if (count < 2 || p.file === "onhold.md") {
        lines.splice(p.start, block.length, ...block);
        write(p.file, lines.join(eol));
        plan.push(`${v.id} NOT DONE (${count}): note added in ${p.file}: ${label}`);
      } else {
        const toUser = p.file !== "user.md" && (p.tags.some((t) => t === "game" || t === "windows") || /\b(user|game|windows|account|login)\b/i.test(v.text));
        const dest = toUser ? "user.md" : "onhold.md";
        lines.splice(p.start, p.end - p.start + 1);
        write(p.file, lines.join(eol));
        const target = next.get(dest) ?? `# Open points: ${dest.replace(".md", "")}\n`;
        write(dest, addToSection(target, block, eolOf(target)));
        plan.push(`${v.id} NOT DONE (${count}): move from ${p.file} to ${dest}: ${label}`);
      }
    }
  }
  return { files: next, plan, problems };
}

function main() {
  const args = process.argv.slice(2);
  const di = args.indexOf("--dir");
  const dir = di >= 0 ? resolve(args[di + 1]) : defaultDir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const verdictFile = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--dir");
  if (!verdictFile) throw new Error("usage: openpoints-close.mjs <verdicts-file> [--dry-run] [--dir PATH]");
  if (!existsSync(dir)) throw new Error(`no openpoints folder at ${dir}`);
  const verdicts = parseVerdicts(readFileSync(verdictFile, "utf8"));
  if (!verdicts.length) throw new Error(`no verdict lines in ${verdictFile}`);
  const present = new Set(readdirSync(dir));
  const files = new Map(FILES.filter((f) => present.has(f.file)).map((f) => [f.file, readFileSync(join(dir, f.file), "utf8")]));
  const date = new Date().toISOString().slice(0, 10);
  const { files: out, plan, problems } = applyVerdicts(files, verdicts, date);
  if (problems.length) {
    console.error(`openpoints-close: nothing changed; ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(plan.join("\n"));
  if (args.includes("--dry-run")) return;
  const changed = [...out].filter(([f, t]) => t !== files.get(f));
  const backup = join(dir, ".backup", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(backup, { recursive: true });
  for (const [f] of changed) if (files.has(f)) writeFileSync(join(backup, f), files.get(f));
  for (const [f, t] of changed) writeFileSync(join(dir, f), t);
  console.log(`changed ${changed.map(([f]) => f).join(", ")}; backup in ${backup}`);
}

if (process.argv[1] && basename(process.argv[1]) === "openpoints-close.mjs") {
  try { main(); } catch (e) { console.error(`openpoints-close: ${e.message}`); process.exit(1); }
}
