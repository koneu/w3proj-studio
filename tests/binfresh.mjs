// Refuses a stale binary. we-compare and the make-*.mjs generators take the w3proj CLI (or a built Studio, W3_APP_BIN)
// from wherever it lies; an old one gave a false result once (batch 17, the ally masks). A binary is stale when a
// tracked source file it is built from is newer than it: crates/, Cargo.toml and Cargo.lock for the CLI, plus
// app/src-tauri and the web page it embeds (app/dist, built by `npm run build` from app/src, index.html, the vite
// and TypeScript configs and the npm packages) for the app. mtimes are compared, so in a fresh checkout (sources just
// written) a binary built or copied before is refused: build again. Except a build of scripts/verify-build.mjs (its
// verify.json names the commit): when the working tree's sources are that commit's, it is fresh whatever the mtimes.
//
// Override: --allow-stale on a tool's command line (where it parses its own flags), or W3_ALLOW_STALE=1.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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
    throw new Error(`${bin} is older than ${src.file} (${new Date(src.mtimeMs).toISOString()} vs ${statSync(bin).mtime.toISOString()}): rebuild it, or pass --allow-stale / set W3_ALLOW_STALE=1 to use it anyway`);
  }
  return bin;
}

export const staleAllowed = (env = process.env, argv = process.argv) => env.W3_ALLOW_STALE === "1" || argv.includes("--allow-stale");

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
