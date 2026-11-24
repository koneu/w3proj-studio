// Refuses a stale binary. we-compare and the make-*.mjs generators take the w3proj CLI (or a built Studio, W3_APP_BIN)
// from wherever it lies; an old one gave a false result once (batch 17, the ally masks). A binary is stale when a
// tracked source file it is built from is newer than it: crates/, Cargo.toml and Cargo.lock for the CLI, plus
// app/src-tauri and the web page it embeds (app/dist, built by `npm run build` from app/src, index.html, the vite
// and TypeScript configs and the npm packages) for the app. mtimes are compared, so in a fresh checkout (sources just
// written) a binary built or copied before is refused: build again. Except a build of scripts/verify-build.mjs (its
// verify.json names the commit): when the working tree's sources are that commit's, it is fresh whatever the mtimes.
//
// Override: --allow-stale anywhere on a tool's command line (taken out of process.argv on import, so it never shifts
// positional arguments), or W3_ALLOW_STALE=1.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCES = {
  cli: ["crates", "Cargo.toml", "Cargo.lock"],
  app: ["crates", "Cargo.toml", "Cargo.lock", "app/src-tauri", "app/src", "app/index.html", "app/vite.config.ts", "app/tsconfig.json", "app/package.json", "app/package-lock.json"],
};

/** The newest tracked source of `kind` under `root`: { file, mtimeMs }, or null when git lists none. */
export function newestSource(root = defaultRoot, kind = "cli") {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...SOURCES[kind]], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  let best = null;
  for (const f of out.split("\0")) {
    if (!f) continue;
    let m;
    try { m = statSync(join(root, f)).mtimeMs; } catch { continue; } // deleted in the working tree
    if (!best || m > best.mtimeMs) best = { file: f, mtimeMs: m };
  }
  return best;
}

/** The commit a binary of scripts/verify-build.mjs was built from (`<build>/target/<profile>/<bin>` with
 *  `<build>/verify.json`), or null for any other binary. */
export function builtCommit(bin) {
  try {
    const commit = JSON.parse(readFileSync(join(dirname(bin), "..", "..", "verify.json"), "utf8")).commit;
    return typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/** Whether the sources of `kind` in `root`'s working tree are the very ones of `commit` (uncommitted changes count). */
export function sameSources(root, kind, commit) {
  try {
    execFileSync("git", ["diff", "--quiet", commit, "--", ...SOURCES[kind]], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false; // differs (exit 1), or the commit isn't in this repository
  }
}

/** A hash of the CONTENT of the tracked sources of `kind` in `root`'s working tree (git blob ids, so a touched but
 *  unchanged file, or a fresh checkout, gives the same value; any real edit changes it). */
export function sourceFingerprint(root = defaultRoot, kind = "cli") {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SOURCES[kind]], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean).filter((f) => existsSync(join(root, f)));
  const ids = files.length ? execFileSync("git", ["hash-object", "--stdin-paths"], { cwd: root, input: files.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 }).split("\n") : [];
  const h = createHash("sha256");
  files.forEach((f, i) => h.update(`${f}\0${ids[i]}\n`));
  return h.digest("hex");
}

/** The same value for the sources as `commit` has them (what a build of verify-build.mjs, a git archive, was made from). */
export function commitFingerprint(root, kind, commit) {
  const out = execFileSync("git", ["ls-tree", "-r", "-z", commit, "--", ...SOURCES[kind]], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  const h = createHash("sha256");
  for (const e of out.split("\0").filter(Boolean)) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(e);
    if (m) h.update(`${m[2]}\0${m[1]}\n`);
  }
  return h.digest("hex");
}

export const stampPath = (bin) => `${bin}.srcstamp`;

/** Records which sources `bin` was built from (call right after a build), so a later checkout or touch isn't "stale". */
export function writeStamp(bin, kind, fingerprint = sourceFingerprint(defaultRoot, kind)) {
  writeFileSync(stampPath(bin), JSON.stringify({ kind, fingerprint }));
}

/** Whether the stamp next to `bin` names exactly the sources `root` has now. */
export function stampMatches(bin, kind, root) {
  try {
    const st = JSON.parse(readFileSync(stampPath(bin), "utf8"));
    return st.kind === kind && typeof st.fingerprint === "string" && st.fingerprint === sourceFingerprint(root, kind);
  } catch {
    return false;
  }
}

/** Throws when `bin` is missing or older than the newest source (unless allowed). Returns bin. A build of
 *  verify-build.mjs whose commit has the very sources of the working tree is fresh whatever the mtimes say (a checkout
 *  made after the build writes every file anew). */
export function checkFresh(bin, { kind = "cli", root = defaultRoot, allowStale = false } = {}) {
  if (!existsSync(bin)) throw new Error(`no binary at ${bin}`);
  if (allowStale) return bin;
  const src = newestSource(root, kind);
  if (src && src.mtimeMs > statSync(bin).mtimeMs) {
    const commit = builtCommit(bin);
    if (commit && sameSources(root, kind, commit)) return bin;
    if (stampMatches(bin, kind, root)) return bin; // built from these very contents: only the mtimes differ
    throw new Error(`${bin} is older than ${src.file} (${new Date(src.mtimeMs).toISOString()} vs ${statSync(bin).mtime.toISOString()}): rebuild it, or pass --allow-stale (anywhere on the command line) / set W3_ALLOW_STALE=1 to use it anyway (mtimes are compared: a clean tree whose files were just checked out also looks newer, unless the binary has its .srcstamp)`);
  }
  return bin;
}

/** Removes every `--allow-stale` from `argv` in place (so positional arguments don't shift) and tells whether one was there. */
export function takeAllowStale(argv) {
  let seen = false;
  for (let i = argv.length - 1; i >= 2; i--) {
    if (argv[i] === "--allow-stale") { argv.splice(i, 1); seen = true; }
  }
  return seen;
}

// Importing this module is enough for a script's positional arguments to be free of the flag: it is taken out of
// process.argv here, before the script reads its arguments (imports run first), and remembered.
const flagGiven = takeAllowStale(process.argv);

export const staleAllowed = (env = process.env, argv = process.argv) =>
  env.W3_ALLOW_STALE === "1" || argv.includes("--allow-stale") || (argv === process.argv && flagGiven);

/** For scripts: checks `bin` (a falsy path is left to the caller's own usage check) and exits 1 with the message. */
export function requireFresh(bin, kind = "cli", opts = {}) {
  if (!bin) return bin;
  try {
    return checkFresh(bin, { kind, allowStale: staleAllowed(), ...opts });
  } catch (e) {
    console.error(String(e.message));
    process.exit(1);
  }
}
