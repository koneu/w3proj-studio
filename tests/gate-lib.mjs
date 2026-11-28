// The parts of tests/gate.mjs that are worth testing alone (app/scripts/gate.test.mjs): running
// a command with a timeout, ending its tree, the signal handlers, the lock between gates, the coverage floors,
// the step table.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Ctrl-C, a kill of the gate or its terminal closing ends the steps' processes too. */
export function installSignalHandlers(live, exit = (code) => process.exit(code)) {
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(sig, () => {
      for (const c of live) killTree(c);
      exit(code);
    });
  }
}

/** The owner written into a lock folder, or null while there is none (being made, or left half made). */
function lockOwner(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** When a process started, as the system counts it (Linux: field 22 of /proc/<pid>/stat), or null where that isn't known. */
function startedAt(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Whether the process that wrote `owner` still runs: its number alone can be another process's by now. */
function holds(owner) {
  if (!alive(owner.pid)) return false;
  return owner.started == null || startedAt(owner.pid) === owner.started;
}

function ageMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * A lock between gates running at once, also from different worktrees: a folder that exists while
 * it is held, with the owner's process in it (`repo`: the checkout it runs in, for the others' messages). A folder
 * left by a process that is gone is taken over. `say(text)` is told who is waited for, every 30 s.
 */
export async function withFileLock(dir, repo, say, body, { pollMs = 1000 } = {}) {
  const owner = join(dir, "owner.json");
  let told = 0;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, JSON.stringify({ pid: process.pid, started: startedAt(process.pid), repo, since: new Date().toISOString() }));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = lockOwner(owner);
      // Stale: its process is gone, or it never got an owner (a gate killed between the two
      // steps above) and is older than a moment.
      const stale = held ? !holds(held) : ageMs(dir) > 10000;
      if (stale) {
        // Taken over by renaming it away first: of two gates that both see it stale only one can
        // rename it, and a gate that took the lock in between isn't swept away (its owner is checked
        // once more right before the rename).
        const again = lockOwner(owner);
        if (again ? holds(again) || again.pid !== held?.pid : held || ageMs(dir) <= 10000) continue;
        const gone = `${dir}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(dir, gone);
        } catch {
          continue;
        }
        say(held ? `took over the lock of ${held.repo} (process ${held.pid} is gone)` : `took over a lock without an owner: ${dir}`);
        rmSync(gone, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - told > 30000) {
        say(`waiting for ${held ? `the gate of ${held.repo} (process ${held.pid}, since ${held.since})` : "another gate"}: ${dir}`);
        told = Date.now();
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await body();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The gates in the queue folder that still run: each file's entry, with `file`. What a gate that is gone left is removed. */
function queueEntries(dir) {
  const entries = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return entries;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const entry = lockOwner(file);
    // Half written files don't exist (entries arrive by rename): one that can't be read is left by something else.
    if (entry && typeof entry.pid === "number" && holds(entry)) entries.push({ ...entry, file });
    else if (entry || ageMs(file) > 10000) rmSync(file, { force: true });
  }
  return entries;
}

let queueIds = 0;

/**
 * The queue between gates on one machine, also from different worktrees: a folder with one file per gate that waits
 * or runs. `me`: { repo (the checkout it runs in), exclusive }. Gates that are not `exclusive` (the commit tier) run
 * side by side when they are in different checkouts; an exclusive one (anything with the corpus tier's steps: the app
 * smoke test doesn't stand the load of another gate) runs alone. Two gates of one checkout never run together: they
 * share app/dist and the smoke tests' folders. First come, first served among gates that can't run together: once an
 * exclusive gate waits, gates that come later wait behind it instead of passing it for ever.
 *
 * `body({ others, claim })` runs while this gate has its turn: `others()` are the entries of the gates running beside
 * it, `claim(mb)` writes into this gate's entry how much memory its steps may use, for the gates that start later.
 * `say(text)` is told who is waited for, every 30 s. `onEntry(file)`: where this gate's entry is, to remove it when
 * the process is ended (an entry left behind is removed by the next gate: its process is gone).
 */
export async function withGateQueue(dir, me, say, body, { pollMs = 1000, onEntry = () => {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const id = `${process.pid}-${queueIds++}`;
  const file = join(dir, `${id}.json`);
  const mutex = `${dir}.mutex`;
  const entry = { id, pid: process.pid, started: startedAt(process.pid), repo: me.repo, exclusive: Boolean(me.exclusive), state: "waiting", ticket: 0, claim: 0, since: new Date().toISOString() };
  const write = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, file);
  };
  /** One gate at a time reads the folder and writes its decision. */
  const alone = (work) => withFileLock(mutex, me.repo, () => {}, async () => work(queueEntries(dir).filter((e) => e.id !== id)), { pollMs: 20 });
  const clash = (other) => entry.exclusive || other.exclusive || other.repo === entry.repo;
  onEntry(file);
  try {
    await alone((others) => {
      entry.ticket = Math.max(0, ...others.map((e) => e.ticket ?? 0)) + 1;
      write();
    });
    for (let told = 0; ; ) {
      const blockers = await alone((others) => {
        const inTheWay = others.filter((o) => clash(o) && (o.state === "holding" || o.ticket < entry.ticket));
        if (inTheWay.length === 0) {
          entry.state = "holding";
          write();
        }
        return inTheWay;
      });
      if (blockers.length === 0) break;
      if (Date.now() - told > 30000) {
        say(`waiting for ${blockers.map((b) => `the gate of ${b.repo} (process ${b.pid}, ${b.state === "holding" ? "running" : "waiting"} since ${b.since})`).join(", ")}: ${dir}`);
        told = Date.now();
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return await body({
      others: () => queueEntries(dir).filter((e) => e.id !== id && e.state === "holding"),
      claim(mb) {
        entry.claim = mb;
        write();
      },
    });
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * The memory budget (MB) of a gate that runs beside others: what `own` (memoryBudget) found, less what the gates
 * beside it said their steps may use (`claim`). Free memory already lacks what they use now, so this is on the
 * careful side; never below 1 (the scheduler then runs one step at a time).
 */
export function sharedBudget(own, others) {
  const taken = others.reduce((n, e) => n + (Number(e.claim) || 0), 0);
  return taken === 0 ? own : { mb: Math.max(1, own.mb - taken), from: `${own.from}, less ${taken} MB for ${others.length} other gate${others.length === 1 ? "" : "s"}` };
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

/** The process's own cgroup (v2) from the text of /proc/self/cgroup: "/user.slice/...", or null (v1 only, none). */
export function cgroupPath(procSelfCgroup) {
  for (const line of String(procSelfCgroup ?? "").split("\n")) {
    const m = /^0::(\/.*)$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * The memory left (MB) under the tightest memory.max of `path` and the cgroups above it: each one's
 * memory.max minus its memory.current. null when none has a limit ("max") or nothing can be read.
 * `read(file)`: the file's text, or null when it can't be read.
 */
export function cgroupHeadroomMb(path, read, root = "/sys/fs/cgroup") {
  let best = null;
  for (let p = path; p; p = p === "/" ? null : p.slice(0, p.lastIndexOf("/")) || "/") {
    const dir = p === "/" ? root : `${root}${p}`;
    const max = read(`${dir}/memory.max`)?.trim();
    if (!max || max === "max" || !/^\d+$/.test(max)) continue;
    const current = Number(read(`${dir}/memory.current`)?.trim());
    const left = Math.max(0, Number(max) - (Number.isFinite(current) ? current : 0)) / 1048576;
    best = best === null ? left : Math.min(best, left);
  }
  return best === null ? null : Math.floor(best);
}

/** MemAvailable (MB) from the text of /proc/meminfo, or null. */
export function memAvailableMb(meminfo) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(meminfo ?? ""));
  return m ? Math.floor(Number(m[1]) / 1024) : null;
}

/**
 * How much memory (MB) the gate's running steps may need together, and where that came from:
 * W3_GATE_MEM_MB if set, else 80% of the smaller of MemAvailable (os.freemem() off Linux) and what
 * the gate's cgroup leaves (cgroup v2: memory.max minus memory.current, the tightest from its own
 * cgroup up, e.g. a `systemd-run -p MemoryMax=` scope).
 */
export function memoryBudget({ env = process.env, platform = process.platform, read, freemem }) {
  const forced = Number(env.W3_GATE_MEM_MB);
  if (env.W3_GATE_MEM_MB && Number.isFinite(forced) && forced > 0) return { mb: Math.floor(forced), from: "W3_GATE_MEM_MB" };
  const parts = [];
  let avail = platform === "linux" ? memAvailableMb(read("/proc/meminfo")) : null;
  if (avail !== null) parts.push(`MemAvailable ${avail} MB`);
  else {
    avail = Math.floor(freemem() / 1048576);
    parts.push(`free memory ${avail} MB`);
  }
  if (platform === "linux") {
    const path = cgroupPath(read("/proc/self/cgroup"));
    const left = path ? cgroupHeadroomMb(path, read) : null;
    if (left !== null) {
      parts.push(`cgroup limit leaves ${left} MB`);
      avail = Math.min(avail, left);
    }
  }
  return { mb: Math.floor(avail * 0.8), from: `80% of ${parts.join(", ")}` };
}

/**
 * The user's game or Battle.net runs in their Wine prefix: a Windows program started there beside it (JassHelper)
 * dies (X BadWindow, "Fontconfig out of memory", 2026-11-15). `lines`: the processes' command lines (`ps -eo args`);
 * a line counts when it names `Warcraft III.exe` or `Battle.net.exe` as a whole file name (not `Warcraft III.exe.txt`),
 * under a Windows or Unix path or alone. Returns the first such line, else null. Nothing here looks at the gate's own
 * process: the caller leaves its own line out.
 * @param {string[]} lines
 * @returns {string | null}
 */
export function gamePrefixBusy(lines) {
  const name = /(?:^|[\\/\s])(?:Warcraft III|Battle\.net)\.exe(?=\s|$)/i;
  return lines.find((l) => name.test(l)) ?? null;
}

/** The command lines of all processes (Linux; elsewhere, or when `ps` fails, none), except this process's. */
export function processLines(run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 }), platform = process.platform, self = process.pid) {
  if (platform !== "linux") return [];
  try {
    const lines = [];
    for (const l of run("ps", ["-eo", "pid=,args="]).split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      if (m && Number(m[1]) !== self) lines.push(m[2]);
    }
    return lines;
  } catch {
    return [];
  }
}

/** A step missing from the table would be run but left out of the result. */
export function assertInTable(steps, table) {
  for (const s of steps) if (!table.includes(s.id)) throw new Error(`gate: step "${s.id}" is not in the table`);
}

/**
 * The steps named by `ids` and all they come `after` (and what those come after), in the order of `steps`:
 * what `--only` runs, so a step finds what it needs built by this tree.
 */
export function withPrerequisites(steps, ids) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const wanted = new Set();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop().split("#")[0];
    if (wanted.has(id) || !byId.has(id)) continue;
    wanted.add(id);
    stack.push(...(byId.get(id).after ?? []));
  }
  return steps.filter((s) => wanted.has(s.id));
}

/** What a missing or half-installed app/node_modules looks like: one line to say, or null when it's complete enough. */
export function missingDeps(appDir, exists = existsSync) {
  const bin = join(appDir, "node_modules", ".bin");
  const need = process.platform === "win32" ? ["vite.cmd", "tsc.cmd"] : ["vite", "tsc"];
  const lacking = need.filter((n) => !exists(join(bin, n)));
  return lacking.length === 0 ? null : `app/node_modules is missing or incomplete (no ${lacking.join(", ")}): run \`npm ci\` in app/ (also in every new git worktree), then run the gate again`;
}
