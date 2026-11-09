// Keyboard shortcuts read the key through lib/keys.ts keyOf, never a keyboard event's `key` itself: on Linux WebKitGTK
// gives some chords key "Unidentified" (Shift+Tab, Ctrl+Alt+F-keys, Ctrl+Alt with the number pad's operators), and a
// handler that compares `e.key` misses them. This finds `<event>.key` in src/ (tests and lib/keys.ts left out): the
// usual names of an event (e, ev, evt, event) and every name the file gives a KeyboardEvent (a parameter typed so, a
// keydown/keyup listener's or onkey… handler's parameter). A line that has to read the key itself says why with
// `keys-ok: <reason>` (in a comment on that line).
//
// Part of `npm run check`; its tests (check-keys.test.mjs) feed it made-up sources.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const USUAL = ["e", "ev", "evt", "event"];

/** The names a source gives keyboard events: the usual ones and those it types or binds as one. */
export function eventNames(source) {
  const names = new Set(USUAL);
  const patterns = [
    /\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*KeyboardEvent\b/g,
    /addEventListener\(\s*["']key(?:down|up|press)["']\s*,\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g,
    /\bonkey(?:down|up|press)\s*[:=]\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/gi,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) names.add(m[1]);
  return names;
}

/** Lines of a source that read a keyboard event's `key` directly: { line (1-based), text }. */
export function directKeyUses(source) {
  const names = [...eventNames(source)].map((n) => n.replace(/\$/g, "[$]"));
  const use = new RegExp(`(?<![\\w$.])(?:${names.join("|")})\\.key(?![\\w$])`);
  const found = [];
  source.split("\n").forEach((text, i) => {
    const code = text.trimStart();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    if (/keys-ok:\s*\S/.test(text)) return;
    // What's left of the line once a trailing comment is cut (a `//` inside a string is rare enough here).
    const before = text.replace(/\s\/\/.*$/, "");
    if (use.test(before)) found.push({ line: i + 1, text: text.trim() });
  });
  return found;
}

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

/** Every direct `key` read under a source folder, as "file:line: text" messages. */
export function checkKeys(src) {
  const problems = [];
  for (const file of walk(src).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))) {
    const rel = relative(src, file).split(sep).join("/");
    if (rel === "lib/keys.ts") continue;
    for (const u of directKeyUses(readFileSync(file, "utf8"))) problems.push(`src/${rel}:${u.line}: ${u.text}`);
  }
  return problems;
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "check-keys.mjs") {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const problems = checkKeys(src);
  if (problems.length) {
    console.error(`Keyboard events' key read directly (use keyOf from lib/keys.ts, or say why with "keys-ok: <reason>"):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("keys read through keyOf");
}
