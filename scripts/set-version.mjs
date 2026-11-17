#!/usr/bin/env node
// Sets the app's version everywhere it is written, so they can't drift apart.
//
//   node scripts/set-version.mjs 0.4.0     set it
//   node scripts/set-version.mjs --check   say whether every place agrees (exit 1 if not); changes nothing
//   node scripts/set-version.mjs           print the current version
//
// The places (the version of one release):
//   Cargo.toml                     [workspace.package] version, which every crate of the workspace takes
//   Cargo.lock                     the workspace crates' own entries (the ones with no `source`), not the dependencies
//   app/package.json               "version"
//   app/package-lock.json          its top "version" and the root package's
//   app/src-tauri/tauri.conf.json  "version" (the installer's and the About box's)
// Not touched: the built-in extensions' own versions (app/src/builtin/*/extension.json), which are theirs.
// Plain text edits, no npm or cargo needed, the same on Windows and Linux. Run the gate (node tests/gate.mjs) after.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = (p) => join(root, p);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The version Cargo.toml's [workspace.package] has: the one the others are held against. */
function workspaceVersion(toml) {
  const section = /\[workspace\.package\][^[]*/.exec(toml)?.[0] ?? "";
  return /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
}

/** Every place's version, as [label, version] pairs (undefined where it can't be read). */
function readAll() {
  const toml = readFileSync(file("Cargo.toml"), "utf8");
  const lock = readFileSync(file("Cargo.lock"), "utf8");
  const found = [["Cargo.toml", workspaceVersion(toml)]];
  for (const block of lock.split(/^\[\[package\]\]\r?\n/m).slice(1)) {
    if (/^source\s*=/m.test(block)) continue;
    found.push([`Cargo.lock ${/^name\s*=\s*"([^"]+)"/m.exec(block)?.[1]}`, /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1]]);
  }
  const pkg = JSON.parse(readFileSync(file("app/package.json"), "utf8"));
  const pkgLock = JSON.parse(readFileSync(file("app/package-lock.json"), "utf8"));
  found.push(["app/package.json", pkg.version], ["app/package-lock.json", pkgLock.version], ["app/package-lock.json packages[\"\"]", pkgLock.packages?.[""]?.version]);
  found.push(["app/src-tauri/tauri.conf.json", JSON.parse(readFileSync(file("app/src-tauri/tauri.conf.json"), "utf8")).version]);
  return found;
}

/** `text` with the first `"version": "…"` of the JSON object that starts at `from` replaced (keeps the file's layout). */
function replaceJsonVersion(text, version, from = 0) {
  const re = /("version"\s*:\s*")[^"]*(")/g;
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) throw new Error('no "version" field found');
  return text.slice(0, m.index) + m[1] + version + m[2] + text.slice(m.index + m[0].length);
}

function setAll(version) {
  // Cargo.toml: only the version line under [workspace.package].
  let toml = readFileSync(file("Cargo.toml"), "utf8");
  const at = toml.indexOf("[workspace.package]");
  if (at < 0) throw new Error("Cargo.toml has no [workspace.package]");
  const next = toml.slice(at).replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
  toml = toml.slice(0, at) + next;
  writeFileSync(file("Cargo.toml"), toml);

  // Cargo.lock: the workspace crates (no `source` line); dependencies that happen to share the old number stay.
  const lock = readFileSync(file("Cargo.lock"), "utf8");
  const parts = lock.split(/^(\[\[package\]\]\r?\n)/m);
  for (let i = 2; i < parts.length; i += 2) {
    if (/^source\s*=/m.test(parts[i])) continue;
    parts[i] = parts[i].replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
  }
  writeFileSync(file("Cargo.lock"), parts.join(""));

  // package.json, and package-lock.json (the top version, then the root package's under "packages").
  writeFileSync(file("app/package.json"), replaceJsonVersion(readFileSync(file("app/package.json"), "utf8"), version));
  let pl = readFileSync(file("app/package-lock.json"), "utf8");
  pl = replaceJsonVersion(pl, version);
  const rootPkg = pl.indexOf('"packages"');
  const rootEntry = pl.indexOf('"": {', rootPkg);
  if (rootPkg < 0 || rootEntry < 0) throw new Error("app/package-lock.json has no root package entry");
  writeFileSync(file("app/package-lock.json"), replaceJsonVersion(pl, version, rootEntry));

  writeFileSync(file("app/src-tauri/tauri.conf.json"), replaceJsonVersion(readFileSync(file("app/src-tauri/tauri.conf.json"), "utf8"), version));
}

const arg = process.argv[2];
if (arg === "--check" || arg === undefined) {
  const found = readAll();
  const expected = found[0][1];
  const off = found.filter(([, v]) => v !== expected);
  if (arg === undefined) { console.log(expected); process.exit(0); }
  if (off.length) {
    console.error(`The versions disagree (Cargo.toml says ${expected}):\n${off.map(([where, v]) => `  ${where}: ${v}`).join("\n")}\nFix with: node scripts/set-version.mjs ${expected}`);
    process.exit(1);
  }
  console.log(`all ${found.length} places say ${expected}`);
} else {
  if (!SEMVER.test(arg)) { console.error(`"${arg}" isn't a version like 1.2.3`); process.exit(2); }
  setAll(arg);
  const off = readAll().filter(([, v]) => v !== arg);
  if (off.length) { console.error(`Not everything took ${arg}:\n${off.map(([where, v]) => `  ${where}: ${v}`).join("\n")}`); process.exit(1); }
  console.log(`version ${arg} in all ${readAll().length} places. Run the gate (node tests/gate.mjs) before committing.`);
}
