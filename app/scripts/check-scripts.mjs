// Checks the tooling scripts the commit gate never runs: every app/scripts/**/*.mjs, tests/*.mjs and scripts/*.mjs loads
// (`node --check`), and app-smoke.mjs's two lists of checks, the `--only=<check>` map and the full run, name the same
// checks. Both lists are kept by hand and drifted in merges; a merge once broke app-smoke.mjs's syntax and the commit
// tier passed. Part of `npm run check`.
//
//   node scripts/check-scripts.mjs

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The scripts to check: app/scripts and its sub-folders, tests/ (not its fixtures) and the repository's own scripts/. */
export function scriptFiles(repo) {
  const walk = (dir, deep) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return deep && e.name !== "node_modules" ? walk(p, deep) : [];
    return e.name.endsWith(".mjs") ? [p] : [];
  });
  return [...walk(join(repo, "app", "scripts"), true), ...walk(join(repo, "tests"), false), ...walk(join(repo, "scripts"), false)].sort();
}

/** `node --check` on each file, some at a time; resolves with a problem per file that doesn't load. */
export async function syntaxProblems(files) {
  const problems = [];
  const queue = [...files];
  const one = async () => {
    for (let f; (f = queue.shift()) !== undefined;) {
      const { code, err } = await new Promise((done) => {
        const child = spawn(process.execPath, ["--check", f], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr.on("data", (d) => { err += d; });
        child.on("error", (e) => done({ code: -1, err: String(e) }));
        child.on("close", (code) => done({ code, err }));
      });
      if (code !== 0) problems.push({ file: f, message: err.trim().split("\n").slice(0, 6).join("\n") || `exit ${code}` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, availableParallelism()) }, one));
  return problems.sort((a, b) => a.file.localeCompare(b.file));
}

/** The parts of a list, split at its top-level commas; comments are left out. */
function topLevel(text) {
  const parts = [];
  let depth = 0, part = "", quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        part += c + (text[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(part);
      part = "";
      continue;
    }
    part += c;
  }
  parts.push(part);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * app-smoke.mjs's checks: the names in its `--only` map (`const onlyChecks = { a, b: (p, f) => b(p, f, x) };`), the
 * checks its full run calls after it (`await name(page, found…` and `for (const check of [a, b]) await check(page,
 * found…`; not its pieces projectChecks, checksA, checksB and checksC), and the functions it declares.
 */
export function smokeChecks(source) {
  const map = /const onlyChecks = \{([\s\S]*?)\};/.exec(source);
  if (!map) return null;
  const only = topLevel(map[1]).map((p) => /^(\w+)/.exec(p)?.[1]).filter(Boolean);
  const after = source.slice(map.index + map[0].length);
  const run = new Set();
  // The full run's own pieces (the project checks, and the parts the gate runs as three apps: --part) hold the checks.
  const pieces = new Set(["check", "projectChecks", "checksA", "checksB", "checksC"]);
  for (const m of after.matchAll(/await (\w+)\(page, found\b/g)) if (!pieces.has(m[1])) run.add(m[1]);
  for (const m of after.matchAll(/for \(const check of \[([^\]]*)\]\) await check\(page, found\b/g)) for (const n of topLevel(m[1])) run.add(n);
  const declared = new Set([...source.matchAll(/^(?:async )?function (\w+)\s*\(/gm)].map((m) => m[1]));
  // Two names on one line of the map (`a, b,`): it's kept one per line so parallel branches don't conflict on it.
  const crowded = map[1].split("\n").filter((l) => /^\s*\w+\s*,\s*\w+/.test(l)).map((l) => l.trim());
  return { only, run: [...run], declared, crowded };
}

/** Where app-smoke.mjs's `--only` map and its full run disagree, as messages. */
export function smokeListProblems(source) {
  const checks = smokeChecks(source);
  if (!checks) return ["app-smoke.mjs: its --only map (`const onlyChecks = { … };`) wasn't found; update check-scripts.mjs with it"];
  const { only, run, declared, crowded } = checks;
  const problems = [];
  if (crowded.length) problems.push(`app-smoke.mjs: the --only map has one check per line; split: ${crowded.join(" | ")}`);
  const unsorted = only.findIndex((n, i) => i > 0 && only[i - 1].localeCompare(n, "en", { sensitivity: "base" }) > 0);
  if (unsorted > 0) problems.push(`app-smoke.mjs: the --only map is in alphabetical order; ${only[unsorted]} comes before ${only[unsorted - 1]}`);
  const inOnly = new Set(only);
  const twice = only.filter((n, i) => only.indexOf(n) !== i);
  if (twice.length) problems.push(`app-smoke.mjs: named twice in the --only map: ${[...new Set(twice)].join(", ")}`);
  const notOnly = run.filter((n) => !inOnly.has(n));
  if (notOnly.length) problems.push(`app-smoke.mjs: the full run calls checks that --only can't run (add them to its --only map): ${notOnly.join(", ")}`);
  const notRun = only.filter((n) => !run.includes(n));
  if (notRun.length) problems.push(`app-smoke.mjs: the --only map names checks the full run doesn't call: ${notRun.join(", ")}`);
  const unknown = [...new Set([...only, ...run])].filter((n) => !declared.has(n));
  if (unknown.length) problems.push(`app-smoke.mjs: checks named but not declared as functions: ${unknown.join(", ")}`);
  return problems;
}

/** The files the unpack no longer writes: a map's triggers are map/triggers/ (the flat war3map.wtg.json and war3map.wct.txt are gone). */
const GONE_FILES = ["war3map.wtg.json", "war3map.wct.txt"];

/** Generators (tests/fixtures/we-specs/make-*.mjs) of `sources` ({ file name: text }) that name a file the unpack doesn't write any more. */
export function generatorProblems(sources) {
  return Object.entries(sources).flatMap(([name, text]) => GONE_FILES.filter((f) => text.includes(f))
    .map((f) => `${name}: names ${f}, which the unpack no longer writes (the triggers are map/triggers/; tests/fixtures/we-specs/trigger-folder.mjs edits them)`));
}

/** `source` with comments, strings, regex literals and the text parts of templates blanked (same length, same lines); `${…}` stays code. */
export function blankNonCode(source) {
  const out = source.split("");
  const blank = (a, b) => { for (let i = a; i < b; i++) if (out[i] !== "\n") out[i] = " "; };
  const braces = []; // per open template `${`: the brace depth to come back to
  let depth = 0, last = "";
  const template = (from) => { // scans template text from `from`; returns the index after it, or enters a `${`
    let i = from;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") { i++; continue; }
      if (c === "`") { blank(from, i); return i + 1; }
      if (c === "$" && source[i + 1] === "{") { blank(from, i); braces.push(depth); depth++; return i + 2; }
    }
    blank(from, i);
    return i;
  };
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") { const e = source.indexOf("\n", i); const end = e < 0 ? source.length : e; blank(i, end); i = end; continue; }
    if (c === "/" && source[i + 1] === "*") { const e = source.indexOf("*/", i + 2); const end = e < 0 ? source.length : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, j); i = j + 1; last = "x"; continue;
    }
    if (c === "`") { i = template(i + 1); last = "x"; continue; }
    if (c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last))) { // a regex literal
      let j = i + 1, cls = false;
      while (j < source.length && source[j] !== "\n" && (cls || source[j] !== "/")) {
        if (source[j] === "\\") j++;
        else if (source[j] === "[") cls = true;
        else if (source[j] === "]") cls = false;
        j++;
      }
      blank(i + 1, j); i = j + 1; last = "x"; continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (braces.length && braces[braces.length - 1] === depth) { braces.pop(); i = template(i + 1); last = "x"; continue; }
    }
    if (!/\s/.test(c)) last = /[\w$)\]]/.test(c) ? "x" : c;
    i++;
  }
  return out.join("");
}

/**
 * Calls of `run(` in a top-level function of app-smoke.mjs where `run` isn't declared inside that function (its own
 * parameters, a `const run =`, a `function run`): there it is the module's `async function run()`, which starts a whole
 * smoke run inside the current one and leaks an app and Xvfb. A deliberate call of that one carries `// top-level run`
 * on its line. Calls at the module's top level are the program's own.
 */
export function smokeRunProblems(source) {
  const code = blankNonCode(source);
  const lines = source.split("\n");
  const lineOf = (at) => code.slice(0, at).split("\n").length;
  const problems = [];
  for (const head of code.matchAll(/^(?:async )?function\s+(\w+)\s*\(/gm)) {
    // The header's parameters up to the matching ")", then the body's braces.
    let i = head.index + head[0].length, d = 1;
    for (; i < code.length && d > 0; i++) d += code[i] === "(" ? 1 : code[i] === ")" ? -1 : 0;
    const params = code.slice(head.index + head[0].length, i - 1);
    const open = code.indexOf("{", i);
    if (open < 0) continue;
    let end = open;
    for (d = 0; end < code.length; end++) {
      if (code[end] === "{") d++;
      else if (code[end] === "}" && --d === 0) break;
    }
    const body = code.slice(open, end + 1);
    // Declared in the body: `const run`, `function run`, a destructured `{ run }`, an arrow's parameter `(run) =>` / `run =>`.
    const declared = /\brun\b/.test(params)
      || /\b(?:const|let|var|function)\s+run\b/.test(body)
      || /\b(?:const|let|var)\s*[{[][^=;]*\brun\b[^=;]*[}\]]\s*=/.test(body)
      || /\brun\s*=>|\([^()]*\brun\b[^()]*\)\s*=>/.test(body);
    if (declared) continue;
    for (const call of body.matchAll(/(?<![\w$.])run\(/g)) {
      const line = lineOf(open + call.index);
      if (/\/\/\s*top-level run/.test(lines[line - 1])) continue;
      problems.push(`app-smoke.mjs:${line}: ${head[1]}() calls run( but declares no run: that is the top-level run(), which starts a whole smoke run (declare a local run, or mark a deliberate call with "// top-level run")`);
    }
  }
  return problems;
}

/** Messages for the built-in extension folders (app/src/builtin/*) of `repo` that have no README.md. */
export function readmeProblems(repo) {
  const dir = join(repo, "app", "src", "builtin");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !existsSync(join(dir, e.name, "README.md")))
    .map((e) => `app/src/builtin/${e.name}: no README.md (purpose, data it reads and writes, what it contributes)`);
}

/** Every problem of the repository's scripts, as messages. */
export async function checkScripts(repo) {
  const files = scriptFiles(repo);
  const problems = (await syntaxProblems(files)).map((p) => `${relative(repo, p.file).split("\\").join("/")} doesn't load:\n    ${p.message.split("\n").join("\n    ")}`);
  const smoke = join(repo, "app", "scripts", "app-smoke.mjs");
  const smokeSource = readFileSync(smoke, "utf8");
  problems.push(...smokeListProblems(smokeSource), ...smokeRunProblems(smokeSource));
  const specs = join(repo, "tests", "fixtures", "we-specs");
  problems.push(...generatorProblems(Object.fromEntries(readdirSync(specs).filter((f) => /^make-.*\.mjs$/.test(f)).map((f) => [`tests/fixtures/we-specs/${f}`, readFileSync(join(specs, f), "utf8")]))));
  problems.push(...readmeProblems(repo));
  return { files, problems };
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "check-scripts.mjs") {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { files, problems } = await checkScripts(repo);
  if (problems.length) {
    console.error(`Scripts:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`scripts ok: ${files.length} load, app-smoke's --only map and full run agree`);
}
