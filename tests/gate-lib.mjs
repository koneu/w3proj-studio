// The parts of tests/gate.mjs that are worth testing alone (app/scripts/gate.test.mjs): running
// a command with a timeout, ending its tree, the signal handlers, the coverage floors, the step table.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

/** The pids below `root` (POSIX, from `ps`); empty when `ps` is unavailable. */
function descendants(root) {
  const r = spawnSync("ps", ["-e", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  const kids = new Map();
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || Number.isNaN(ppid)) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const found = [];
  const stack = [root];
  while (stack.length) for (const k of kids.get(stack.pop()) ?? []) if (!found.includes(k)) (found.push(k), stack.push(k));
  return found;
}

/** Ends a step's process and all it started. */
export function killTree(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else {
      // A descendant that made its own process group (setsid, detached: tauri-driver's WebKitWebDriver, Xvfb)
      // is not in the step's group: collect the tree while it is still linked, then end all of it.
      const rest = descendants(child.pid);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
      for (const pid of rest) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // already gone
  }
}

/**
 * Runs a shell command for a step; resolves with whether it exited 0 without timing out.
 * `fd`: where the command's errors (and the timeout message, via `write`) go. `live`: the set
 * of commands running, for the signal handlers.
 */
export function runShell(command, { cwd, env = {}, stdout, fd, write, timeoutMs, live }) {
  return new Promise((done) => {
    const out = stdout ? openSync(stdout, "w") : fd;
    // A process group of its own (POSIX), so a timeout or a signal ends the whole tree, not just the shell.
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", out, fd], env: { ...process.env, ...env } });
    live.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      write(`gate: step timed out after ${timeoutMs / 60000} min (W3_GATE_STEP_TIMEOUT_MIN), killed`);
      killTree(child);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      live.delete(child);
      if (stdout) closeSync(out);
      write(String(e));
      done(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      live.delete(child);
      if (stdout) closeSync(out);
      done(code === 0 && !timedOut);
    });
  });
}

/** Ctrl-C or a kill of the gate ends the steps' processes too. */
export function installSignalHandlers(live, exit = (code) => process.exit(code)) {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      for (const c of live) killTree(c);
      exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/**
 * Rust coverage `areas` ({crate: {lines, covered}}) against `floors` ({crate: percent}). Every area with
 * a floor is checked; one nothing was measured for (a crate that dropped out) counts as 0%.
 * Returns {ok, floors}: `floors` raised to what was measured when `updating`.
 */
export function checkFloors(areas, floors, say, updating = false) {
  let ok = true;
  const next = { ...floors };
  for (const crate of new Set([...Object.keys(areas), ...Object.keys(floors)])) {
    const a = areas[crate] ?? { lines: 0, covered: 0 };
    const percent = a.lines ? (100 * a.covered) / a.lines : 0;
    const floor = floors[crate];
    say(`${crate.padEnd(8)} ${percent.toFixed(1).padStart(5)}%  ${a.covered} / ${a.lines}${floor === undefined ? "" : `  (floor ${floor}%)`}${a.lines ? "" : "  (not measured)"}`);
    if (floor !== undefined && percent < floor) {
      say(`coverage of ${crate} fell below its floor`);
      ok = false;
    }
    if (updating && floor !== undefined) next[crate] = Math.max(floor, Math.floor(percent * 10) / 10);
  }
  return { ok, floors: next };
}

/** A step missing from the table would be run but left out of the result. */
export function assertInTable(steps, table) {
  for (const s of steps) if (!table.includes(s.id)) throw new Error(`gate: step "${s.id}" is not in the table`);
}
