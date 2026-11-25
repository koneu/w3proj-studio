import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInTable, cgroupHeadroomMb, cgroupPath, checkFloors, memAvailableMb, memoryBudget, missingDeps, runShell } from "../../tests/gate-lib.mjs";

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
  const table = JSON.parse(/const table = (\[.*?\]);/s.exec(src)[1]);
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
