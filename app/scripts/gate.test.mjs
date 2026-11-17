import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInTable, checkFloors, runShell } from "../../tests/gate-lib.mjs";

// The tests run bundled elsewhere, so the repository is found from app/, where `npm test` starts.
const repo = join(process.cwd(), "..");
const lib = pathToFileURL(join(repo, "tests", "gate-lib.mjs")).href;
const base = join(repo, "target", "gate-test", `run-${process.pid}`);
mkdirSync(base, { recursive: true });
test.after(() => rmSync(base, { recursive: true, force: true }));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
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
  const ok = await runShell(sleeper(pidFile), { cwd: dir, fd, write: (t) => said.push(t), timeoutMs: 1500, live });
  closeSync(fd);
  assert.equal(ok, false);
  assert.match(said.join("\n"), /timed out/);
  assert.equal(live.size, 0);
  const pid = readPid(pidFile);
  assert.ok(pid > 0, "the sleeper started");
  await until(() => !alive(pid), "the sleeper to be gone");
});

test("control: a command that ends in time passes, and a failing one fails", async () => {
  const fd = openSync(join(base, "log2"), "w");
  const run = (c) => runShell(c, { cwd: base, fd, write: () => {}, timeoutMs: 60000, live: new Set() });
  assert.equal(await run(`node -e "process.exit(0)"`), true);
  assert.equal(await run(`node -e "process.exit(3)"`), false);
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
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
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
