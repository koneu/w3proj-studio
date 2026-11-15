// Reports (never kills) Wine servers that a run of ours may have left behind: a `wineserver` process whose
// environment says it was started from inside this repository (PWD under one of `roots`). A server is only
// reported, because the same prefix may be the user's, with their programs in it; the user decides.
// Linux only (reads /proc); elsewhere it finds nothing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** NUL-separated /proc file as a list of strings; null when it can't be read. */
function readNul(file) {
  try {
    return readFileSync(file, "latin1").split("\0").filter((s) => s !== "");
  } catch {
    return null;
  }
}

/**
 * @param {string[]} roots folders; a server whose PWD is inside one of them is ours
 * @param {string} [procRoot] "/proc", a parameter for the test
 * @returns {{pid: number, pwd: string, prefix: string, hours: number}[]}
 */
export function findOurWineservers(roots, procRoot = "/proc") {
  if (!existsSync(procRoot)) return [];
  const found = [];
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const cmd = readNul(join(procRoot, name, "cmdline"));
    if (!cmd || cmd.length === 0) continue;
    const exe = cmd[0].split(/[\\/]/).pop();
    if (exe !== "wineserver") continue;
    const env = readNul(join(procRoot, name, "environ"));
    if (!env) continue;
    const get = (k) => env.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1);
    const pwd = get("PWD");
    if (!pwd || !roots.some((r) => pwd === r || pwd.startsWith(r.endsWith(sep) ? r : r + sep))) continue;
    let hours = 0;
    try {
      hours = Math.round(((Date.now() - statSync(join(procRoot, name)).ctimeMs) / 3600000) * 10) / 10;
    } catch {
      /* gone meanwhile */
    }
    found.push({ pid: Number(name), pwd, prefix: get("WINEPREFIX") ?? "?", hours });
  }
  return found;
}

/** The lines the gate prints at its end (empty when nothing is left). */
export function wineserverReport(roots, procRoot) {
  const found = findOurWineservers(roots, procRoot);
  if (!found.length) return [];
  return [
    `WARNING: ${found.length} wineserver(s) started from this repository are still running (reported, not killed; the prefix may be the user's):`,
    ...found.map((f) => `  pid ${f.pid}, ~${f.hours} h, PWD ${f.pwd}, WINEPREFIX ${f.prefix}`),
  ];
}
