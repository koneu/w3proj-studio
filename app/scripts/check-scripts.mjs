// Checks the tooling scripts the commit gate never runs: every app/scripts/**/*.mjs and tests/*.mjs loads
// (`node --check`), and app-smoke.mjs's two lists of checks, the `--only=<check>` map and the full run, name the same
// checks. Both lists are kept by hand and drifted in merges; a merge once broke app-smoke.mjs's syntax and the commit
// tier passed. Part of `npm run check`.
//
//   node scripts/check-scripts.mjs

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The scripts to check: app/scripts and its sub-folders, and tests/ (not its fixtures). */
export function scriptFiles(repo) {
  const walk = (dir, deep) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return deep && e.name !== "node_modules" ? walk(p, deep) : [];
    return e.name.endsWith(".mjs") ? [p] : [];
  });
  return [...walk(join(repo, "app", "scripts"), true), ...walk(join(repo, "tests"), false)].sort();
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
 * found…`; not its pieces projectChecks, firstHalf and secondHalf), and the functions it declares.
 */
export function smokeChecks(source) {
  const map = /const onlyChecks = \{([\s\S]*?)\};/.exec(source);
  if (!map) return null;
  const only = topLevel(map[1]).map((p) => /^(\w+)/.exec(p)?.[1]).filter(Boolean);
  const after = source.slice(map.index + map[0].length);
  const run = new Set();
  // The full run's own pieces (the project checks, and the halves the gate runs as two apps: --part) hold the checks.
  const pieces = new Set(["check", "projectChecks", "firstHalf", "secondHalf"]);
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

/** Every problem of the repository's scripts, as messages. */
export async function checkScripts(repo) {
  const files = scriptFiles(repo);
  const problems = (await syntaxProblems(files)).map((p) => `${relative(repo, p.file).split("\\").join("/")} doesn't load:\n    ${p.message.split("\n").join("\n    ")}`);
  const smoke = join(repo, "app", "scripts", "app-smoke.mjs");
  problems.push(...smokeListProblems(readFileSync(smoke, "utf8")));
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
