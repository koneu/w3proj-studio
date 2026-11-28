import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInTable, cgroupHeadroomMb, cgroupPath, checkFloors, gamePrefixBusy, memAvailableMb, memoryBudget, missingDeps, processLines, runShell, sharedBudget, withFileLock, withGateQueue, withPrerequisites } from "../../tests/gate-lib.mjs";

// The tests run bundled elsewhere, so the repository is found from app/, where `npm test` starts.
const repo = join(process.cwd(), "..");
const lib = pathToFileURL(join(repo, "tests", "gate-lib.mjs")).href;
const base = join(repo, "target", "gate-test", `run-${process.pid}`);
mkdirSync(base, { recursive: true });
test.after(() => rmSync(base, { recursive: true, force: true }));

// [Refactored] On Linux (especially in container/sandbox PID namespaces where PID 1 does not immediately reap
// reparented grandchildren), a killed child can linger as a zombie ('Z' in /proc/<pid>/stat) while process.kill(pid, 0)
// still succeeds. Treat a zombie process as dead, matching we-drive.mjs's procGone().
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const s = readFileSync(`/proc/${pid}/stat`, "utf8");
      const i = s.lastIndexOf(")");
      if (i >= 0 && s.slice(i + 1).trimStart()[0] === "Z") return false;
    }
    return true;
  } catch {
    return false;
  }
};
const until = async (cond, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const readPid = (file) => (existsSync(file) ? Number(readFileSync(file, "utf8").trim()) || 0 : 0);

// Starts a long sleeper whose pid is written to `pidFile`; the shell around it is what the gate holds.
const sleeper = (pidFile) => `node -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(()=>{}, 600000)" "${pidFile.replaceAll("\\", "/")}"`;

test("a step past its timeout is killed with its tree, and fails", async () => {
  const dir = join(base, "timeout");
  mkdirSync(dir);
  const pidFile = join(dir, "pid");
  const fd = openSync(join(dir, "log"), "w");
  const said = [];
  const live = new Set();
  // [Refactored] Lowered timeoutMs from 1500 to 200 to avoid 1.3s of idle timer wait while still waiting for sleeper startup.
  const ok = await runShell(sleeper(pidFile), { cwd: dir, fd, write: (t) => said.push(t), timeoutMs: 200, live });
  closeSync(fd);
  assert.equal(ok, false);
  assert.match(said.join("\n"), /timed out/);
  assert.equal(live.size, 0);
  const pid = readPid(pidFile);
  assert.ok(pid > 0, "the sleeper started");
  await until(() => !alive(pid), "the sleeper to be gone");
});

test("a timed-out step also ends a descendant that left its process group", { skip: process.platform === "win32" && "no setsid" }, async () => {
  const dir = join(base, "setsid");
  mkdirSync(dir);
  const pidFile = join(dir, "pid");
  const fd = openSync(join(dir, "log"), "w");
  // setsid: the sleeper gets a group of its own, like tauri-driver's WebKitWebDriver or Xvfb.
  const ok = await runShell(`setsid ${sleeper(pidFile)} & wait`, { cwd: dir, fd, write: () => {}, timeoutMs: 1500, live: new Set() });
  closeSync(fd);
  assert.equal(ok, false);
  const pid = readPid(pidFile);
  assert.ok(pid > 0, "the sleeper started");
  await until(() => !alive(pid), "the setsid sleeper to be gone");
});

test("control: a command that ends in time passes, and a failing one fails", async () => {
  const fd = openSync(join(base, "log2"), "w");
  const run = (c) => runShell(c, { cwd: base, fd, write: () => {}, timeoutMs: 60000, live: new Set() });
  // [Refactored] Run passing and failing shell controls concurrently instead of sequentially.
  const [pass, fail] = await Promise.all([
    run(`node -e "process.exit(0)"`),
    run(`node -e "process.exit(3)"`),
  ]);
  assert.equal(pass, true);
  assert.equal(fail, false);
  closeSync(fd);
});

// Windows has no catchable SIGTERM: host.kill() ends the host outright, so no handler can run and kill the step.
test("SIGTERM to the gate kills the commands of its steps", { skip: process.platform === "win32" && "Windows cannot catch SIGTERM" }, async () => {
  const dir = join(base, "sigterm");
  mkdirSync(dir);
  const pidFile = join(dir, "pid");
  const script = join(dir, "host.mjs");
  writeFileSync(
    script,
    `import { openSync } from "node:fs";
import { installSignalHandlers, runShell } from "${lib}";
const live = new Set();
installSignalHandlers(live);
const fd = openSync(${JSON.stringify(join(dir, "log"))}, "w");
runShell(${JSON.stringify(sleeper(pidFile))}, { cwd: ${JSON.stringify(dir)}, fd, write() {}, timeoutMs: 600000, live });
setInterval(() => {}, 1000);
`,
  );
  const host = spawn(process.execPath, [script], { stdio: "ignore" });
  const exited = new Promise((r) => host.on("exit", (code, signal) => r({ code, signal })));
  try {
    await until(() => readPid(pidFile) > 0, "the step's command to start");
    const pid = readPid(pidFile);
    assert.ok(alive(pid));
    host.kill("SIGTERM");
    const r = await exited;
    assert.equal(r.code, 143);
    await until(() => !alive(pid), "the step's command to be gone");
  } finally {
    host.kill("SIGKILL");
    const pid = readPid(pidFile);
    if (pid && alive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
});

test("coverage: a crate with a floor that measured nothing counts as 0% and fails", () => {
  const said = [];
  const r = checkFloors({ app: { lines: 100, covered: 90 } }, { app: 80, gone: 10 }, (t) => said.push(t));
  assert.equal(r.ok, false);
  const text = said.join("\n");
  assert.match(text, /gone\s+0\.0%.*\(not measured\)/);
  assert.match(text, /coverage of gone fell below its floor/);
  assert.doesNotMatch(text, /coverage of app fell/);
});

test("coverage: control, every floor met passes; a crate without a floor is only reported; --update-floor raises", () => {
  const areas = { app: { lines: 100, covered: 90 }, extra: { lines: 10, covered: 0 } };
  const r = checkFloors(areas, { app: 80 }, () => {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.floors, { app: 80 });
  const u = checkFloors(areas, { app: 80 }, () => {}, true);
  assert.deepEqual(u.floors, { app: 90 });
  // never lowered
  assert.deepEqual(checkFloors({ app: { lines: 100, covered: 50 } }, { app: 80 }, () => {}, true).floors, { app: 80 });
});

test("a step missing from the table throws", () => {
  assert.throws(() => assertInTable([{ id: "a" }, { id: "b" }], ["a"]), /step "b" is not in the table/);
  assert.doesNotThrow(() => assertInTable([{ id: "a" }], ["a", "c"]));
});

test("the gate's own steps are all in its table (gate.mjs refuses to start otherwise)", () => {
  const src = readFileSync(join(repo, "tests", "gate.mjs"), "utf8");
  const ids = [...src.matchAll(/^\s*\{ id: "([a-z0-9]+)"/gm)].map((m) => m[1]);
  // The app smoke test's parts are made from their number (SMOKE_PARTS) and put into the table as they are.
  const text = /const table = (\[.*?\]);/s.exec(src)[1];
  assert.match(text, /, \.\.\.smokeParts\.map\(\(s\) => s\.id\),/);
  assert.match(src, /^  \.\.\.smokeParts,$/m);
  const table = JSON.parse(text.replace(" ...smokeParts.map((s) => s.id),", ""));
  assert.ok(ids.length > 10);
  assert.doesNotThrow(() => assertInTable(ids.map((id) => ({ id })), table));
  assert.match(src, /assertInTable\(steps, table\)/);
});

test("every step of the gate has a memory estimate (mem, MB) for the scheduler's budget", () => {
  const src = readFileSync(join(repo, "tests", "gate.mjs"), "utf8");
  const lines = [...src.matchAll(/^\s*\{ id: "([a-z0-9]+)".*$/gm)];
  assert.ok(lines.length > 10);
  for (const [line, id] of lines) assert.match(line, /\bmem: \d+,/, `step ${id} has no mem`);
});

test("every lock a gate step names is a cargo profile's or app/dist's (a new name would be a lock of its own)", () => {
  const src = readFileSync(join(repo, "tests", "gate.mjs"), "utf8");
  const names = new Set([...src.matchAll(/\[\"([a-z-]+)\", \"[rw]\"\]/g)].map((m) => m[1]));
  for (const m of src.matchAll(/locks\.hold\(\"([a-z-]+)\"/g)) names.add(m[1]);
  assert.deepEqual([...names].sort(), ["cargo-debug", "cargo-release", "dist"]);
});

test("--only: the steps named and all they come after, in the gate's order; nothing else", () => {
  const steps = [
    { id: "cli" },
    { id: "appbuild" },
    { id: "appsmoke2", after: ["cli", "appbuild"] },
    { id: "ui", after: ["appbuild#built"] },
    { id: "seeds", after: ["cli"] },
    { id: "tsc" },
  ];
  const ids = (list) => list.map((s) => s.id);
  assert.deepEqual(ids(withPrerequisites(steps, ["appsmoke2"])), ["cli", "appbuild", "appsmoke2"]);
  assert.deepEqual(ids(withPrerequisites(steps, ["tsc", "seeds"])), ["cli", "seeds", "tsc"]);
  // "step#event" names the step too.
  assert.deepEqual(ids(withPrerequisites(steps, ["ui"])), ["appbuild", "ui"]);
  // Control: a step that comes after nothing brings nothing along.
  assert.deepEqual(ids(withPrerequisites(steps, ["tsc"])), ["tsc"]);
});

test("the lock between gates: a second gate waits for the first, says whom it waits for, and the folder is gone after", async () => {
  const dir = join(base, "queue.lock");
  const order = [];
  const said = [];
  let release;
  const first = withFileLock(dir, "/first", () => {}, () => new Promise((r) => { order.push("first in"); release = () => { order.push("first out"); r("a"); }; }));
  await until(() => existsSync(join(dir, "owner.json")), "the first gate to hold the lock");
  const second = withFileLock(dir, "/second", (m) => said.push(m), async () => { order.push("second in"); return "b"; }, { pollMs: 20 });
  await until(() => said.length > 0, "the second gate to say it waits");
  assert.deepEqual(order, ["first in"]);
  assert.match(said[0], /waiting for the gate of \/first \(process \d+/);
  release();
  assert.equal(await first, "a");
  assert.equal(await second, "b");
  assert.deepEqual(order, ["first in", "first out", "second in"]);
  assert.equal(existsSync(dir), false);
});

test("the lock between gates: one left by a gate that is gone is taken over, also when its process number is in use again", { skip: process.platform === "win32" && "no SIGKILL, and no start times, on Windows" }, async () => {
  // A gate that was killed: the lock names a process that ended.
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => gone.on("exit", r));
  const dir = join(base, "stale.lock");
  mkdirSync(dir);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: gone.pid, started: "1", repo: "/killed", since: "then" }));
  const said = [];
  assert.equal(await withFileLock(dir, "/next", (m) => said.push(m), async () => "ran", { pollMs: 20 }), "ran");
  assert.match(said.join("\n"), /took over the lock of \/killed/);
  assert.equal(existsSync(dir), false);
  // Its number given to another process since (this test's own, which runs): only the start time tells them apart.
  if (process.platform === "linux") {
    mkdirSync(dir);
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, started: "1", repo: "/killed-long-ago", since: "then" }));
    said.length = 0;
    assert.equal(await withFileLock(dir, "/next", (m) => said.push(m), async () => "ran again", { pollMs: 20 }), "ran again");
    assert.match(said.join("\n"), /took over the lock of \/killed-long-ago/);
  }
});

test("the lock between gates, control: one held by a process that runs is not taken over", async () => {
  const dir = join(base, "held.lock");
  let release;
  const holder = withFileLock(dir, "/holder", () => {}, () => new Promise((r) => { release = r; }));
  await until(() => existsSync(join(dir, "owner.json")), "the holder");
  let entered = false;
  const waiter = withFileLock(dir, "/waiter", () => {}, async () => { entered = true; }, { pollMs: 20 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(entered, false);
  release();
  await holder;
  await waiter;
  assert.equal(entered, true);
});

// ---- the queue between gates ----

/** Gates in one queue folder, each ended when the test says so. `enter(name, me)` starts one; `inside` lists who has its turn. */
function gates(dir) {
  const inside = [];
  const leave = new Map();
  const said = new Map();
  const turns = new Map();
  return {
    inside,
    said,
    turns,
    enter(name, me) {
      said.set(name, []);
      const p = withGateQueue(dir, me, (m) => said.get(name).push(m), (turn) => new Promise((r) => {
        inside.push(name);
        turns.set(name, turn);
        leave.set(name, () => { inside.splice(inside.indexOf(name), 1); r(name); });
      }), { pollMs: 20 });
      return p;
    },
    leave: (name) => leave.get(name)(),
  };
}
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test("the queue between gates: commit gates of different checkouts run side by side", async () => {
  const dir = join(base, "queue-shared");
  const g = gates(dir);
  const a = g.enter("a", { repo: "/wt/a", exclusive: false });
  const b = g.enter("b", { repo: "/wt/b", exclusive: false });
  await until(() => g.inside.length === 2, "both gates to run");
  g.leave("a");
  g.leave("b");
  assert.deepEqual([await a, await b], ["a", "b"]);
  // Nothing is left of gates that are done.
  assert.deepEqual(readdirSync(dir), []);
});

test("the queue between gates: two gates of one checkout take turns, and the second says whom it waits for", async () => {
  const g = gates(join(base, "queue-same"));
  const a = g.enter("a", { repo: "/wt/a", exclusive: false });
  await until(() => g.inside.includes("a"), "the first gate");
  const b = g.enter("b", { repo: "/wt/a", exclusive: false });
  await until(() => g.said.get("b").length > 0, "the second gate to say it waits");
  assert.deepEqual(g.inside, ["a"]);
  assert.match(g.said.get("b")[0], /waiting for the gate of \/wt\/a \(process \d+, running since /);
  g.leave("a");
  await a;
  await until(() => g.inside.includes("b"), "the second gate's turn");
  g.leave("b");
  await b;
});

test("the queue between gates: a gate with the corpus tier runs alone, and later commit gates don't pass it while it waits", async () => {
  const g = gates(join(base, "queue-exclusive"));
  const a = g.enter("commit-a", { repo: "/wt/a", exclusive: false });
  await until(() => g.inside.includes("commit-a"), "the first commit gate");
  const batch = g.enter("batch", { repo: "/wt/m", exclusive: true });
  await until(() => g.said.get("batch").length > 0, "the batch gate to say it waits");
  // A commit gate that comes now could run beside commit-a, but the batch gate was there first.
  const b = g.enter("commit-b", { repo: "/wt/b", exclusive: false });
  await until(() => g.said.get("commit-b").length > 0, "the later commit gate to say it waits");
  assert.match(g.said.get("commit-b")[0], /the gate of \/wt\/m \(process \d+, waiting since /);
  await pause();
  assert.deepEqual(g.inside, ["commit-a"]);
  g.leave("commit-a");
  await a;
  await until(() => g.inside.includes("batch"), "the batch gate's turn");
  await pause();
  assert.deepEqual(g.inside, ["batch"]);
  g.leave("batch");
  await batch;
  await until(() => g.inside.includes("commit-b"), "the later commit gate's turn");
  g.leave("commit-b");
  await b;
});

test("the queue between gates: what a gate that is gone left in the folder holds nobody up", { skip: process.platform === "win32" && "no start times on Windows" }, async () => {
  const dir = join(base, "queue-stale");
  mkdirSync(dir, { recursive: true });
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => gone.on("exit", r));
  const left = { repo: "/wt/killed", exclusive: true, state: "holding", ticket: 1, claim: 0, since: "then" };
  writeFileSync(join(dir, `${gone.pid}-0.json`), JSON.stringify({ ...left, id: `${gone.pid}-0`, pid: gone.pid, started: "1" }));
  // Its process number in use again (this test's own process): the start time tells them apart.
  writeFileSync(join(dir, `${process.pid}-999.json`), JSON.stringify({ ...left, id: `${process.pid}-999`, pid: process.pid, started: "1" }));
  const g = gates(dir);
  const a = g.enter("a", { repo: "/wt/a", exclusive: true });
  await until(() => g.inside.includes("a"), "the gate to run");
  assert.equal(readdirSync(dir).length, 1);
  g.leave("a");
  await a;
});

test("the queue between gates: a gate sees what the gates beside it may use, and its budget is less by that", async () => {
  const g = gates(join(base, "queue-budget"));
  const a = g.enter("a", { repo: "/wt/a", exclusive: false });
  await until(() => g.inside.includes("a"), "the first gate");
  assert.deepEqual(g.turns.get("a").others(), []);
  g.turns.get("a").claim(11700);
  const b = g.enter("b", { repo: "/wt/b", exclusive: false });
  await until(() => g.inside.includes("b"), "the second gate");
  const beside = g.turns.get("b").others();
  assert.deepEqual(beside.map((e) => [e.repo, e.claim]), [["/wt/a", 11700]]);
  const own = { mb: 30000, from: "80% of MemAvailable 37500 MB" };
  assert.equal(sharedBudget(own, beside).mb, 18300);
  assert.match(sharedBudget(own, beside).from, /less 11700 MB for 1 other gate$/);
  // Control: alone, the budget is its own; and it never falls to nothing.
  assert.deepEqual(sharedBudget(own, []), own);
  assert.equal(sharedBudget({ mb: 5000, from: "x" }, beside).mb, 1);
  g.leave("a");
  g.leave("b");
  await a;
  await b;
});

test("missingDeps: a worktree without node_modules gets one line telling to run npm ci", () => {
  const msg = missingDeps(join(base, "no-such-app"));
  assert.match(msg, /npm ci/);
  assert.equal(msg.includes("\n"), false);
});

test("missingDeps: a half-installed node_modules is named, a complete one passes", () => {
  const onlyVite = (p) => /vite(\.cmd)?$/.test(p);
  assert.match(missingDeps("/x/app", onlyVite), /tsc/);
  assert.equal(missingDeps("/x/app", () => true), null);
  // The real checkout this test runs from has its dependencies.
  assert.equal(missingDeps(process.cwd()), null);
});

// ---- the memory budget, on made-up files ----

const GiB = 1024 * 1024 * 1024;
/** A `read` that serves `files` and null for anything else. */
const fakeFiles = (files) => (p) => files[p] ?? null;
const scope = "/user.slice/user-1000.slice/user@1000.service/app.slice/run-u1.scope";

test("cgroupPath: the v2 line of /proc/self/cgroup; none without one", () => {
  assert.equal(cgroupPath(`0::${scope}\n`), scope);
  assert.equal(cgroupPath(`12:memory:/user.slice\n0::/system.slice/x.service\n`), "/system.slice/x.service");
  assert.equal(cgroupPath("12:memory:/user.slice\n"), null);
  assert.equal(cgroupPath(null), null);
});

test("cgroupHeadroomMb: the tightest memory.max minus memory.current from the cgroup up; null without a limit", () => {
  const root = "/sys/fs/cgroup";
  const files = {
    [`${root}${scope}/memory.max`]: `${20 * GiB}\n`,
    [`${root}${scope}/memory.current`]: `${2 * GiB}\n`,
    [`${root}/user.slice/memory.max`]: "max\n",
  };
  assert.equal(cgroupHeadroomMb(scope, fakeFiles(files)), 18 * 1024);
  // A parent with less room wins.
  files[`${root}/user.slice/user-1000.slice/memory.max`] = `${10 * GiB}`;
  files[`${root}/user.slice/user-1000.slice/memory.current`] = `${4 * GiB}`;
  assert.equal(cgroupHeadroomMb(scope, fakeFiles(files)), 6 * 1024);
  // Control: no limit anywhere, or nothing readable.
  assert.equal(cgroupHeadroomMb(scope, fakeFiles({ [`${root}${scope}/memory.max`]: "max\n" })), null);
  assert.equal(cgroupHeadroomMb(scope, () => null), null);
  assert.equal(cgroupHeadroomMb(scope, fakeFiles({ [`${root}${scope}/memory.max`]: "garbage" })), null);
});

test("memAvailableMb reads /proc/meminfo", () => {
  assert.equal(memAvailableMb("MemTotal:       65751040 kB\nMemFree: 1 kB\nMemAvailable:   58311680 kB\n"), 56945);
  assert.equal(memAvailableMb("MemTotal: 1 kB\n"), null);
});

test("memoryBudget: 80% of the smaller of MemAvailable and the cgroup's room; W3_GATE_MEM_MB wins; freemem off Linux", () => {
  const files = {
    "/proc/meminfo": `MemAvailable: ${50 * 1024 * 1024} kB\n`,
    "/proc/self/cgroup": `0::${scope}\n`,
    [`/sys/fs/cgroup${scope}/memory.max`]: `${20 * GiB}`,
    [`/sys/fs/cgroup${scope}/memory.current`]: "0",
  };
  const freemem = () => 8 * GiB;
  const limited = memoryBudget({ env: {}, platform: "linux", read: fakeFiles(files), freemem });
  assert.equal(limited.mb, Math.floor(20 * 1024 * 0.8));
  assert.match(limited.from, /cgroup limit leaves 20480 MB/);
  // Control: without a cgroup limit, MemAvailable decides.
  const free = memoryBudget({ env: {}, platform: "linux", read: fakeFiles({ ...files, [`/sys/fs/cgroup${scope}/memory.max`]: "max" }), freemem });
  assert.equal(free.mb, Math.floor(50 * 1024 * 0.8));
  assert.equal(memoryBudget({ env: { W3_GATE_MEM_MB: "12000" }, platform: "linux", read: fakeFiles(files), freemem }).mb, 12000);
  // A bad override is ignored, not taken as 0 (that would run every step alone).
  assert.equal(memoryBudget({ env: { W3_GATE_MEM_MB: "lots" }, platform: "linux", read: fakeFiles(files), freemem }).mb, limited.mb);
  assert.equal(memoryBudget({ env: {}, platform: "win32", read: () => null, freemem }).mb, Math.floor(8 * 1024 * 0.8));
});

test("gamePrefixBusy: the user's game or Battle.net in a Wine prefix, and nothing else", () => {
  const warcraft = String.raw`/home/u/.steam/steamapps/compatdata/1/pfx/drive_c/Program Files (x86)/Warcraft III/_retail_/x86_64/Warcraft III.exe`;
  const battle = String.raw`C:\Program Files (x86)\Battle.net\Battle.net.exe --type=renderer --lang=en-US`;
  assert.equal(gamePrefixBusy(["node tests/gate.mjs", `c:\\windows\\system32\\steam.exe ${warcraft}`]), `c:\\windows\\system32\\steam.exe ${warcraft}`);
  assert.equal(gamePrefixBusy(["python3 proton waitforexitandrun " + warcraft]) !== null, true);
  assert.equal(gamePrefixBusy([battle]), battle);
  assert.equal(gamePrefixBusy(["Battle.net.exe 30"]), "Battle.net.exe 30");
  assert.equal(gamePrefixBusy(["warcraft iii.exe"]) !== null, true, "file names are not case sensitive on Windows");
  // Controls: other names, and the World Editor in its own prefix (its folder is the game's, its program another).
  for (const other of [
    "less Warcraft III.exe.txt", String.raw`C:\x\Warcraft III.exe.bak`, "vim notes/Battle.net.exe.log", "XWarcraft III.exe", "Battle.net.exe2",
    "/home/u/Warcraft III/_retail_/x86_64/World Editor.exe", "wineserver -p -f", "node app/scripts/we-drive.mjs target/we/prefix", "",
  ]) assert.equal(gamePrefixBusy([other]), null, other);
  assert.equal(gamePrefixBusy([]), null);
});

test("processLines: ps output without this process, and nothing off Linux or when ps fails", () => {
  const out = "    1 /sbin/init\n  123 node gate.mjs\n  456 Battle.net.exe --x\n\nbad line\n";
  assert.deepEqual(processLines(() => out, "linux", 123), ["/sbin/init", "Battle.net.exe --x"]);
  assert.deepEqual(processLines(() => out, "win32", 1), []);
  assert.deepEqual(processLines(() => { throw new Error("no ps"); }, "linux", 1), []);
});

test("processLines finds a real process by the name it runs under", { skip: process.platform !== "linux" }, async () => {
  // A harmless sleep whose argv[0] is the game's file name: never the game.
  const fake = spawn("sleep", ["30"], { argv0: "Battle.net.exe", stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 200));
    // Among the lines (the user's own game, if it runs, may come first).
    assert.deepEqual(processLines().filter((l) => gamePrefixBusy([l]) && l === "Battle.net.exe 30"), ["Battle.net.exe 30"]);
  } finally {
    fake.kill();
  }
  // Control: once it is gone the list doesn't have it.
  await new Promise((r) => fake.once("exit", r));
  assert.equal(processLines().includes("Battle.net.exe 30"), false);
});
